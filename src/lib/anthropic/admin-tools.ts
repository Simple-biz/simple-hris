import 'server-only';

import type Anthropic from '@anthropic-ai/sdk';
import { normEmail } from '@/lib/email/norm-email';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
// Service-role only (no anon fallback): these tables sit behind RLS, where an
// anon client "succeeds" with zero rows — a silent wrong answer, not an error.
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { getPayrollDispatchLock } from '@/lib/supabase/payroll-dispatch-lock';
import { getAppSetting } from '@/lib/supabase/app-settings';
import { listHubstaffUploads } from '@/lib/supabase/hubstaff-hours-db';
import { buildPaymentsLive } from '@/lib/ceo/payments-live';
import { getPeopleBankHistory, type BankChangeEntry } from '@/lib/supabase/bank-update-history';
import {
  withProbeTimeout,
  probeSupabase,
  probePgPool,
  probeHubstaffCsv,
  probeMasterList,
  probeAuditLog,
  probeDisbursementRecords,
  probeAuth,
  probeDailyReport,
  probeAppSettings,
  probeGoogleSheetsSync,
  probeRateHistory,
  probeHrOnboarding,
  probeHrOffboarding,
  probeRates,
  probeTickets,
  probeTimeAdjustments,
  probePayrollWizardNotes,
  probeMesa,
  type ProbeResult,
  type ProbeStatus,
} from '@/lib/admin/diagnostics-probes';

/**
 * Admin-only "operations knowledge" tools for the Admin dashboard's Penny AI —
 * layered ON TOP of the CEO payroll tools (see ceo-tools.ts, which the admin
 * chat route also exposes). These answer the "who did what, when, and is the
 * system healthy" questions: audit-log forensics, diagnostic probes, payroll
 * wizard runtime state, and per-person rate / transfer / onboarding / bank
 * change history. Everything is READ-ONLY — the model never writes.
 *
 * Same design rules as ceo-tools.ts: each tool is a narrow, pre-shaped query
 * (never model-written SQL), results are small and labelled with field_notes
 * so the model interprets them correctly and never invents a fact.
 */

export const ADMIN_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_audit_log',
    description:
      'Search the system audit log — the trail of WHO did WHAT and WHEN across the whole HRIS. Use for any "who did / who changed / who opened / when did" question: "who opened the payroll wizard", "who raised X\'s rate", "who transferred Y", "who changed Z\'s bank info", "what happened today". Filter by action family, actor, target person, and date range.\n\nACTION FAMILIES (prefix-match with action_prefix; call list_audit_actions for the live list with counts):\n• accounting.payroll_wizard_notes. — the Payroll Notes board (row_added/row_updated/row_deleted/adjustment_bridged). Use get_payroll_notes_history instead when you need to know WHICH worker or week a note edit was about.\n• bank_update. — self-service bank changes (otp_requested/otp_verified/otp_verify_failed/saved). people.banking.updated + people.banking.revealed + people.bank_info.requested + bank_preferred.request.approved are the staff-side bank actions.\n• people.profile.updated — name / work email / personal email / department / start date / phone / address edits from the People tab. THIS is the family for "who changed X\'s name or email".\n• payroll. — rate.set, kpi.marked_ready, kpi.reopened, dispatch.locked/unlocked.\n• wizard. — opened, bonus_edited, addition_edited, cycle_selected, config.dept_pay, fx_rate_changed.\n• payment. — dispatched, undone, finalized. paystub.sent/send_failed and paystubs.staged cover paystubs.\n• hr. — the onboarding/offboarding pipeline (onboarding.link_created/submitted/set_work_email/verify_work_email/archived, orientation.marked, new_hire_checklist.*, pending.*, hire.*, employee.offboarded). offboarding. and resignation. are separate families.\n• department_transfer. (requested/released/applied_manual/cancelled/deleted) and department_manager. (assigned/revoked).\n• rbac.role. (granted/revoked) and feature_permission. (grant/revoke) — access changes.\n• csv. (master/rates/hsl syncs, upload, delete, set_current, rename), hubstaff.api_sync, offboarded.sheet.sync, screening.sheet.sync.\n• dispatch.lock_acquired/released, mesa., pab_dispute., pab_exclusion. (added/removed - zeroes a whole month of PAB for one employee; trail starts 2026-08-20, earlier entries have no author), notification.insert_failed (a notification that FAILED to insert; delivery is best-effort so the save still succeeded - details carries notification_type, origin, likely_type_check_rejection), time_adjustment., leave., ticket., documents., qc., contractor., orphanage., urgent_payment., employee_gift_shipping., settings.holidays., auth. (impersonation.signin/force_logout), employee.mesa., admin_assistant.query, ceo_assistant.\n\nCombine with find_employee first when the user names a person, then pass their email as target. For one person\'s complete cross-family history use get_change_timeline instead.',
    input_schema: {
      type: 'object',
      properties: {
        action_prefix: {
          type: 'string',
          description:
            'Filter to actions starting with this prefix, e.g. "payroll.rate", "wizard.", "bank_update.", "department_transfer.". Accepts several comma-separated prefixes ("people.profile,bank_update,payroll.rate") to search multiple families at once. Omit to search every action.',
        },
        actor_email: {
          type: 'string',
          description:
            'Only events performed BY this actor. Pass their email (exact match) or a name fragment (contains match — some events record a display name instead of an email). Use for "what did X do".',
        },
        target: {
          type: 'string',
          description:
            'Free-text match against the whole event: the affected person\'s email or name, a resource id, the action, the actor, or any value inside the event details. Use for "what happened TO X".',
        },
        since: {
          type: 'string',
          description: 'Only events on/after this date, "YYYY-MM-DD" (Asia/Manila reference).',
        },
        until: {
          type: 'string',
          description: 'Only events on/before this date, "YYYY-MM-DD".',
        },
        limit: {
          type: 'integer',
          description: 'Max events to return (1-50). Default 20.',
        },
      },
      required: [],
    },
  },
  {
    name: 'run_diagnostics',
    description:
      'Run the live system diagnostic probes — the same health checks as Admin → Diagnostics. Use for "is everything healthy", "what\'s happening with the diagnostic probes", "is the database ok", "is the Hubstaff data fresh", "any system problems". Checks: Supabase client + Postgres, direct pg pool, Hubstaff CSV freshness, master list, audit log recency, disbursement records, auth/login activity, daily report imports, app settings config bag, Google Sheet syncs, rate history, HR onboarding + offboarding pipelines, rates table, tickets board, time adjustments, payroll wizard notes, and MESA. Returns each probe\'s status (healthy/warning/critical/unknown) with details for anything not healthy. No inputs — it always runs the full set.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_payroll_wizard_status',
    description:
      'Live payroll-wizard runtime state. Use for "has the payroll wizard started processing", "is payroll running right now", "who locked dispatch and when", "how far along are the payments", "which week is being paid". Returns: the global processing lock (locked/by/at — locked=true means Start Processing was pressed and dispatch is in progress), the per-cycle wizard lock, the current pay cycle (source file + period label) with live progress (total staged, paid so far, remaining, per-department breakdown), and the most recent weekly hours uploads (who uploaded, when, which batch is current).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_rate_history',
    description:
      'A person\'s PAY RATE history and who set each rate. Use for "what is the rate history on X", "who raised X\'s rate", "when did X\'s rate change". Returns: (1) every employee_rate_history row (effective date, regular + OT rate, who recorded it, note), (2) their Payment Catalog structure — the current source-of-truth rate — with who created/last updated it, and (3) recent rate-related audit events naming them (payroll.rate.set / employee.rates.update) with the acting admin. For the person\'s CURRENT effective merged rate use get_employee_profile. Requires the exact work_email from find_employee.',
    input_schema: {
      type: 'object',
      properties: {
        work_email: {
          type: 'string',
          description: "The person's work email, exactly as returned by find_employee.",
        },
      },
      required: ['work_email'],
    },
  },
  {
    name: 'get_transfer_history',
    description:
      'Department transfer requests — who transferred, from/to which department, when, and who requested/approved it. Use for "when was X transferred", "who transferred X", "any pending transfers". Pass work_email (from find_employee) for one person\'s full transfer history; omit it for the most recent transfers company-wide.',
    input_schema: {
      type: 'object',
      properties: {
        work_email: {
          type: 'string',
          description:
            "One person's work email (from find_employee). Omit for the latest transfers across everyone.",
        },
        limit: {
          type: 'integer',
          description: 'Max transfers to return (1-30). Default 15.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_onboarding_info',
    description:
      'When and how a person was onboarded. Use for "when was X onboarded", "when did X start", "who invited X", "did X finish their paperwork". Returns their roster Start Date (the canonical tenure/onboarding date), department and employee id, plus their HR onboarding submission if one exists: invite created when/by whom, paperwork submitted when, status — and recent onboarding-pipeline audit events about them. Requires an email for the person (work or personal; from find_employee when they are on the roster).',
    input_schema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: "The person's work or personal email.",
        },
      },
      required: ['email'],
    },
  },
  {
    name: 'get_bank_change_history',
    description:
      'A person\'s bank / payout details change history — who changed their bank info and when. Use for "who changed X\'s bank info", "when did X update their account". Returns (1) the dedicated bank_update_history trail: each save with the field names written, MASKED before→after values, processor, channel (e.g. external_link = the self-service link, so the employee themself made the change), and IP; and (2) related audit-log events, which capture ADMIN-side edits (people.banking.updated, bank_override.saved) with the acting admin\'s email. Full account numbers are never stored or returned. Requires the exact work_email from find_employee.',
    input_schema: {
      type: 'object',
      properties: {
        work_email: {
          type: 'string',
          description: "The person's work email, exactly as returned by find_employee.",
        },
      },
      required: ['work_email'],
    },
  },
  {
    name: 'get_change_timeline',
    description:
      'ONE person\'s COMPLETE change history, merged across every source into a single chronological timeline. This is the right tool for open-ended "what changed for X", "what happened to X", "everything on X", "walk me through X\'s record", or when you need to correlate changes of different kinds (e.g. a bank edit followed by a payment). Merges: audit-log events from EVERY action family that names them (bank, rate, name/email/profile, transfers, roles + feature permissions, onboarding/offboarding, payroll notes, wizard bonus/addition edits, payments, paystubs, MESA, disputes, tickets, leave), the dedicated bank_update_history trail, employee_rate_history, and Payroll Notes rows about them. Unlike the per-topic tools this searches the person\'s WHOLE history, not just a recent window. Use kind to narrow to one category and since/until for a date range. Requires an email (work or personal; get it from find_employee).',
    input_schema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: "The person's work or personal email, from find_employee.",
        },
        kind: {
          type: 'string',
          description:
            'Optional category filter: "bank" (bank/payout details), "rate" (pay rates), "identity" (name, work/personal email, department, start date, phone, address), "access" (roles + feature permissions), "employment" (onboarding, offboarding, transfers, resignation), "payroll" (payments, paystubs, wizard bonus/addition edits, payroll notes), or "all" (default).',
        },
        since: { type: 'string', description: 'Only changes on/after this date, "YYYY-MM-DD".' },
        until: { type: 'string', description: 'Only changes on/before this date, "YYYY-MM-DD".' },
        limit: { type: 'integer', description: 'Max timeline entries (1-100). Default 40.' },
      },
      required: ['email'],
    },
  },
  {
    name: 'get_payroll_notes_history',
    description:
      'WHO edited the Payroll Notes board, and what the edited note actually said. Use for "who changed the payroll note for X", "who ticked that note done", "who added the adjustment on X", "what changed on the notes board this week". The raw audit events only carry a note-row id and the field names touched, so this tool resolves each one against the notes table to show the worker, the pay week, the note text, the adjustment amount, the clerk, and Done state. Pass worker_email for one person, week_start (a Sunday, "YYYY-MM-DD") for one pay week, or neither for the latest edits company-wide. Note: this is the EDIT HISTORY — for the current open checklist use get_payroll_wizard_notes.',
    input_schema: {
      type: 'object',
      properties: {
        worker_email: {
          type: 'string',
          description: "Only notes about this person (the worker the note is ABOUT, not its author).",
        },
        week_start: {
          type: 'string',
          description: 'Only notes for this pay week, the Sunday "YYYY-MM-DD".',
        },
        limit: { type: 'integer', description: 'Max note edits to return (1-50). Default 25.' },
      },
      required: [],
    },
  },
  {
    name: 'list_audit_actions',
    description:
      'List the audit action names that actually exist, with how many times each occurred and when it was first/last seen. Use this BEFORE search_audit_log when you are unsure what an action is called, when a search came back empty and you want to check the name, or when asked "what kinds of things are tracked / what can you see in the audit log". Pass contains to filter (e.g. "bank", "rate", "profile", "notes"). This reads the live table, so it is always accurate even if a tool description is out of date.',
    input_schema: {
      type: 'object',
      properties: {
        contains: {
          type: 'string',
          description: 'Only action names containing this text, e.g. "bank", "transfer", "notes".',
        },
      },
      required: [],
    },
  },
];

const ADMIN_TOOL_NAMES = new Set(ADMIN_TOOLS.map((t) => t.name));

export function isAdminTool(name: string): boolean {
  return ADMIN_TOOL_NAMES.has(name);
}

// ── execution ────────────────────────────────────────────────────────────────

type ToolResult = Record<string, unknown>;

export async function runAdminTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'search_audit_log':
        return await searchAuditLog(input);
      case 'run_diagnostics':
        return await runDiagnostics();
      case 'get_payroll_wizard_status':
        return await getPayrollWizardStatus();
      case 'get_rate_history':
        return await getRateHistory(str(input.work_email));
      case 'get_transfer_history':
        return await getTransferHistory(str(input.work_email), input.limit);
      case 'get_onboarding_info':
        return await getOnboardingInfo(str(input.email));
      case 'get_bank_change_history':
        return await getBankChangeHistory(str(input.work_email));
      case 'get_change_timeline':
        return await getChangeTimeline(input);
      case 'get_payroll_notes_history':
        return await getPayrollNotesHistory(input);
      case 'list_audit_actions':
        return await listAuditActions(str(input.contains));
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ── audit log ────────────────────────────────────────────────────────────────

const AUDIT_COLUMNS =
  'id, user_name, user_role, action, resource, resource_id, details, ip_address, created_at';

type AuditRow = {
  id: string;
  user_name: string | null;
  user_role: string | null;
  action: string;
  resource: string | null;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
};

function compactAuditRow(r: AuditRow) {
  return {
    when: r.created_at,
    actor: r.user_name,
    actor_role: r.user_role,
    action: r.action,
    resource: r.resource,
    resource_id: r.resource_id,
    // The IP separates a staff-side edit from the employee's own submission on
    // flows that share an action name — it must survive into the answer.
    ip_address: r.ip_address,
    // Bank/profile events carry a full before→after `changes` array; the old
    // 600-char cut truncated those mid-array and lost the "after" values.
    details: truncate(safeJson(r.details), 1500),
  };
}

/**
 * Every audit event about ONE person, without the recency blind spot.
 *
 * A plain "newest N of this action family, then filter by person" scan silently
 * misses anything older than N events — with ~3.4k bank events alone, the
 * newest 300 reach back only a few days, so a question about a change made last
 * month answers "no records" instead of the truth. Two passes fix that:
 *
 *   1. EXACT: most person-scoped actions put the email in `resource_id`, which
 *      is indexable — filter on it server-side and get that person's FULL
 *      history regardless of age.
 *   2. DEEP:  the rest hide the email inside `details` (keys vary per action,
 *      so it can't be pushed into SQL) — scan the newest `deepLimit` of the
 *      family and match in JS.
 *
 * Results are merged and de-duplicated; `deep_scan_note` states pass 2's window
 * so a partial answer is never presented as a complete one.
 */
async function fetchPersonAuditEvents(
  aliases: Set<string>,
  actionOr: string | null,
  opts: { deepLimit?: number; cap?: number; since?: string | null; until?: string | null } = {},
): Promise<{ rows: AuditRow[]; error?: string; deepCutoff: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Database is not reachable.', deepCutoff: null };

  const deepLimit = opts.deepLimit ?? 1000;
  const cap = opts.cap ?? 400;
  const safe = [...aliases].filter(isSafeEmail);
  if (!safe.length) return { rows: [], deepCutoff: null };

  const applyRange = <T extends { gte: (c: string, v: string) => T; lt: (c: string, v: string) => T }>(
    q: T,
  ): T => {
    let out = q;
    if (opts.since) out = out.gte('created_at', `${opts.since}T00:00:00+08:00`);
    if (opts.until) out = out.lt('created_at', `${nextIsoDay(opts.until)}T00:00:00+08:00`);
    return out;
  };

  // Pass 1 — exact resource_id match (no recency ceiling).
  let exactQ = supabase
    .from('audit_log')
    .select(AUDIT_COLUMNS)
    .or(safe.map((a) => `resource_id.ilike.${escapeLike(a)}`).join(','))
    .order('created_at', { ascending: false })
    .limit(cap);
  if (actionOr) exactQ = exactQ.or(actionOr);
  exactQ = applyRange(exactQ);

  // Pass 2 — newest slice of the family, matched against details in JS.
  let deepQ = supabase
    .from('audit_log')
    .select(AUDIT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(deepLimit);
  if (actionOr) deepQ = deepQ.or(actionOr);
  deepQ = applyRange(deepQ);

  const [exactRes, deepRes] = await Promise.all([exactQ, deepQ]);
  const errors = [exactRes.error?.message, deepRes.error?.message].filter(Boolean);

  const deepRows = (deepRes.data ?? []) as AuditRow[];
  const deepCutoff = deepRows.length >= deepLimit ? (deepRows[deepRows.length - 1]?.created_at ?? null) : null;

  const byId = new Map<string, AuditRow>();
  for (const r of (exactRes.data ?? []) as AuditRow[]) byId.set(r.id, r);
  for (const r of auditFilterByAliases(deepRows, aliases)) byId.set(r.id, r);

  const rows = [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { rows, error: errors.length ? errors.join('; ') : undefined, deepCutoff };
}

/** Honest note about how far pass 2 reached, or confirmation of full coverage. */
function scanNote(deepCutoff: string | null): string {
  return deepCutoff
    ? `Events keyed by the person's email were searched across their FULL history. Events that name them only inside the event details were searched back to ${deepCutoff} (the scan limit) — for anything older, use search_audit_log with an explicit date range.`
    : "Complete: the person's whole audit history was searched, with no recency cut-off.";
}

async function searchAuditLog(input: Record<string, unknown>): Promise<ToolResult> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  const limit = clampInt(input.limit, 1, 50, 20);
  // Action prefixes are dot-separated slugs; strip anything that could morph
  // the PostgREST filter (%, commas, quotes) rather than rejecting outright.
  // Several comma-separated prefixes are allowed so one call can span families.
  const prefixes = str(input.action_prefix)
    .toLowerCase()
    .split(',')
    .map((p) => p.replace(/[^a-z0-9._-]/g, ''))
    .filter(Boolean);
  const actorRaw = str(input.actor_email).trim().toLowerCase();
  const actor = normEmail(actorRaw) ?? actorRaw;
  const target = str(input.target).trim().toLowerCase();
  const since = isoDay(str(input.since));
  const until = isoDay(str(input.until));

  // When a free-text target filter is present we can't push it into SQL
  // (details keys vary per action), so pull a wider window and filter here.
  const fetchLimit = target ? 500 : limit;
  const actionOr = prefixes.length
    ? prefixes.map((p) => `action.ilike.${escapeLike(p)}%`).join(',')
    : null;

  let q = supabase
    .from('audit_log')
    .select(AUDIT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(fetchLimit);
  if (actionOr) q = q.or(actionOr);
  if (actor) {
    // Exact (case-insensitive) match for an email; contains-match otherwise —
    // some writers stamp user_name with a display name or label, and silently
    // dropping the filter would misreport unfiltered events as X's actions.
    q = isSafeEmail(actor)
      ? q.ilike('user_name', escapeLike(actor))
      : q.ilike('user_name', `%${escapeLike(actor).replace(/[,()]/g, '')}%`);
  }
  // Day bounds are Asia/Manila days; upper bound is the exclusive next
  // midnight so the last second of the day is included.
  if (since) q = q.gte('created_at', `${since}T00:00:00+08:00`);
  if (until) q = q.lt('created_at', `${nextIsoDay(until)}T00:00:00+08:00`);

  // A target that is an email is also matched EXACTLY against resource_id in a
  // second query. The free-text pass below only sees the newest 500 events, so
  // without this an older change to that person reads as "no record" — a silent
  // wrong answer, which is worse than a slow one.
  const targetIsEmail = isSafeEmail(target);
  let exactQ = targetIsEmail
    ? supabase
        .from('audit_log')
        .select(AUDIT_COLUMNS)
        .ilike('resource_id', escapeLike(target))
        .order('created_at', { ascending: false })
        .limit(200)
    : null;
  if (exactQ && actionOr) exactQ = exactQ.or(actionOr);
  if (exactQ && since) exactQ = exactQ.gte('created_at', `${since}T00:00:00+08:00`);
  if (exactQ && until) exactQ = exactQ.lt('created_at', `${nextIsoDay(until)}T00:00:00+08:00`);

  const [res, exactRes] = await Promise.all([q, exactQ ?? Promise.resolve(null)]);
  if (res.error) return { error: res.error.message };

  let rows = (res.data ?? []) as AuditRow[];
  if (target) {
    rows = rows.filter((r) => {
      const hay = [r.resource_id, r.resource, r.action, r.user_name, safeJson(r.details)]
        .join(' ')
        .toLowerCase();
      return hay.includes(target);
    });
    if (exactRes && !exactRes.error) {
      const byId = new Map<string, AuditRow>(rows.map((r) => [r.id, r]));
      for (const r of (exactRes.data ?? []) as AuditRow[]) byId.set(r.id, r);
      rows = [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    }
  }

  const windowCutoff =
    (res.data ?? []).length >= fetchLimit
      ? ((res.data ?? []) as AuditRow[])[(res.data ?? []).length - 1]?.created_at ?? null
      : null;

  const shown = rows.slice(0, limit).map(compactAuditRow);
  return {
    match_count: rows.length,
    truncated: rows.length > shown.length,
    scanned_note: target
      ? targetIsEmail
        ? `Events whose resource_id IS ${target} were searched across all history. Events that merely mention them inside the event details were searched${windowCutoff ? ` back to ${windowCutoff}` : ' with no cut-off'} — narrow with action_prefix or a date range to reach further back.`
        : `Free-text matching scanned the newest ${fetchLimit} events passing the other filters${windowCutoff ? ` (back to ${windowCutoff})` : ''} — the count is within that window only; narrow with action_prefix or a date range to reach older history.`
      : undefined,
    field_notes:
      'actor = who performed the action; it is their signed-in email on nearly every flow (a few stamp a display name or label). "anonymous" = an unauthenticated/public flow (e.g. the self-service bank-update link — attribution then lives in the details/resource_id and the IP). ip_address is recorded on roughly 40% of events and is the tiebreaker when one action name covers both a staff-side and an employee-side flow. resource_id is usually the affected person\'s email, but on some families it is a row UUID instead (people.profile.updated → the master-list row; accounting.payroll_wizard_notes.* → the note row — use get_payroll_notes_history to resolve those to a worker). Event times are UTC ISO timestamps; since/until select Asia/Manila calendar days.',
    events: shown,
  };
}

// ── diagnostics ──────────────────────────────────────────────────────────────

const PROBE_SET: Array<{ id: string; name: string; run: () => Promise<ProbeResult> }> = [
  { id: 'supabase', name: 'Supabase Client / Postgres', run: probeSupabase },
  { id: 'pg-pool', name: 'pg Pool / Direct Postgres', run: probePgPool },
  { id: 'hubstaff-csv', name: 'Hubstaff CSV Import', run: probeHubstaffCsv },
  { id: 'master-list', name: 'Employee Master List', run: probeMasterList },
  { id: 'audit-log', name: 'Audit Log', run: probeAuditLog },
  { id: 'disbursement-records', name: 'Disbursement Records', run: probeDisbursementRecords },
  { id: 'auth-login', name: 'Employee / Accounting Login', run: probeAuth },
  { id: 'daily-report', name: 'Daily Report Import', run: probeDailyReport },
  { id: 'app-settings', name: 'App Settings (config bag)', run: probeAppSettings },
  { id: 'google-sheet-sync', name: 'Google Sheet Sync', run: probeGoogleSheetsSync },
  { id: 'rate-history', name: 'Rate History', run: probeRateHistory },
  { id: 'hr-onboarding', name: 'HR Onboarding Pipeline', run: probeHrOnboarding },
  { id: 'hr-offboarding', name: 'HR Offboarding Pipeline', run: probeHrOffboarding },
  { id: 'rates', name: 'Rates Management', run: probeRates },
  { id: 'tickets', name: 'Tickets Board', run: probeTickets },
  { id: 'time-adjust', name: 'Time Adjustment Requests', run: probeTimeAdjustments },
  { id: 'payroll-notes', name: 'Payroll Wizard Notes', run: probePayrollWizardNotes },
  { id: 'mesa', name: 'MESA Program', run: probeMesa },
];

const STATUS_RANK: Record<ProbeStatus, number> = {
  critical: 3,
  warning: 2,
  unknown: 1,
  healthy: 0,
};

async function runDiagnostics(): Promise<ToolResult> {
  const fallback: ProbeResult = {
    status: 'critical',
    summary: 'Probe timed out.',
    details: [],
    suggestedChecks: [],
  };
  // Probes are documented never-throw, but belt-and-braces: one rejecting
  // probe must not fail the whole diagnostics run.
  const results = await Promise.all(
    PROBE_SET.map((p) =>
      withProbeTimeout(
        p.run().catch((e) => ({
          status: 'unknown' as ProbeStatus,
          summary: `Probe failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160),
          details: [],
          suggestedChecks: [],
        })),
        fallback,
      ),
    ),
  );

  let overall: ProbeStatus = 'healthy';
  const probes = PROBE_SET.map((p, i) => {
    const r = results[i]!;
    if (STATUS_RANK[r.status] > STATUS_RANK[overall]) overall = r.status;
    const healthy = r.status === 'healthy';
    return {
      id: p.id,
      name: p.name,
      status: r.status,
      summary: r.summary,
      // Keep the payload lean: details only where something needs attention.
      details: healthy ? undefined : r.details.slice(0, 6),
      suggested_checks: healthy ? undefined : r.suggestedChecks.slice(0, 4),
    };
  });

  const unhealthy = probes.filter((p) => p.status !== 'healthy');
  return {
    overall_status: overall,
    checked_at: new Date().toISOString(),
    unhealthy_count: unhealthy.length,
    field_notes:
      'Same probes as Admin → Diagnostics, computed live (nothing cached). Note: the auth-login probe ALWAYS reports warning by design ("admin gate not fully enforced yet") — do not treat it alone as an incident.',
    probes,
  };
}

// ── payroll wizard status ────────────────────────────────────────────────────

async function getPayrollWizardStatus(): Promise<ToolResult> {
  const [lock, uploads] = await Promise.all([
    getPayrollDispatchLock(),
    listHubstaffUploads().catch(() => []),
  ]);

  let live: Record<string, unknown> | null = null;
  let liveError: string | null = null;
  try {
    const p = await buildPaymentsLive();
    // buildPaymentsLive reports failure via an error field (zeroed counts),
    // not by throwing — never present those zeros as real progress.
    const pErr = (p as unknown as { error?: string | null }).error;
    if (pErr) {
      liveError = pErr;
    } else {
      live = {
        cycle_source_file: p.sourceFile,
        period: p.label,
        total_staged: p.total,
        paid_so_far: p.paid,
        remaining: p.remaining,
        departments: p.departments.map((d) => ({
          department: d.name,
          total: d.total,
          paid: d.paid,
        })),
      };
    }
  } catch (e) {
    liveError = e instanceof Error ? e.message : String(e);
  }

  // Per-cycle wizard lock — JSON {lockedAt, lockedBy} on new rows, a bare
  // "true"/"false" on legacy ones.
  let cycleLock: Record<string, unknown> | null = null;
  const sourceFile = (live?.cycle_source_file as string | null) ?? null;
  if (sourceFile) {
    const raw = await getAppSetting(`payroll.dispatch_lock.${sourceFile}`).catch(() => null);
    if (raw != null && raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const o = parsed as Record<string, unknown>;
          cycleLock = {
            locked: o.locked !== false,
            locked_at: o.lockedAt ?? null,
            locked_by: o.lockedBy ?? null,
          };
        } else {
          // Legacy rows store a bare boolean ("true"/"false" both parse as
          // valid JSON — they must not fall into the object branch).
          cycleLock = { locked: parsed === true };
        }
      } catch {
        cycleLock = { locked: raw.trim().toLowerCase() === 'true' };
      }
    }
  }

  const recentUploads = (uploads ?? []).slice(0, 5).map((u) => ({
    source_file: u.source_file,
    uploaded_at: u.uploaded_at,
    uploaded_by: u.uploaded_by,
    row_count: u.row_count,
    is_current: u.is_current === true,
  }));

  return {
    processing_lock: {
      locked: lock.locked,
      locked_at: lock.lockedAt,
      locked_by: lock.lockedBy,
    },
    cycle_lock: cycleLock,
    live_progress: live,
    live_progress_error: liveError,
    recent_hours_uploads: recentUploads,
    field_notes:
      'processing_lock.locked = true means someone pressed "Start processing" in the Payroll Wizard and dispatch is actively running (employee disputes pause and payroll writes are blocked); locked_by/locked_at say who started it and when. cycle_lock is the per-week wizard lock for the current cycle. live_progress counts the current cycle: total_staged people to pay, paid_so_far already dispatched, remaining still owed. recent_hours_uploads shows the weekly Hubstaff batches; is_current = the week the wizard is working on.',
  };
}

// ── rate history ─────────────────────────────────────────────────────────────

async function getRateHistory(workEmail: string): Promise<ToolResult> {
  const email = normEmail(workEmail) ?? '';
  if (!email || !isSafeEmail(email)) return { error: 'Missing or invalid work_email.' };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  const aliases = await aliasesFor(email);
  // ilike (not .in) — these tables rely on a lowercase trigger that not every
  // environment has, so exact-case matching can silently miss rows.
  const aliasOr = (col: string) => [...aliases].map((a) => `${col}.ilike.${a}`).join(',');

  const [historyRes, catalogRes, auditScan] = await Promise.all([
    supabase
      .from('employee_rate_history')
      .select('employee_email, regular_rate, ot_rate, effective_from, note, created_by, created_at')
      .or(aliasOr('employee_email'))
      .order('effective_from', { ascending: false })
      .limit(40),
    supabase
      .from('payment_catalog_pay_structures')
      .select('department_key, employee_email, employee_name, regular_rate, ot_rate, currency, created_by, created_at, updated_by, updated_at')
      .eq('scope', 'employee')
      .or(aliasOr('employee_email'))
      .order('created_at', { ascending: false })
      .limit(5),
    fetchPersonAuditEvents(aliases, 'action.ilike.payroll.rate.%,action.ilike.employee.rates.%'),
  ]);

  if (historyRes.error) return { error: historyRes.error.message };
  // Partial failures must read as failures, not as "no records".
  const lookupErrors: string[] = [];
  if (catalogRes.error) lookupErrors.push(`payment catalog lookup failed: ${catalogRes.error.message}`);
  if (auditScan.error) lookupErrors.push(`audit trail lookup failed: ${auditScan.error}`);

  const history = ((historyRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    effective_from: r.effective_from,
    regular_rate: r.regular_rate,
    ot_rate: r.ot_rate,
    recorded_by: r.created_by,
    note: r.note,
    recorded_at: r.created_at,
  }));

  const catalog = ((catalogRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    department_key: r.department_key,
    regular_rate: r.regular_rate,
    ot_rate: r.ot_rate,
    currency: r.currency,
    set_by: r.created_by,
    set_at: r.created_at,
    last_updated_by: r.updated_by,
    last_updated_at: r.updated_at,
  }));

  const auditEvents = auditScan.rows.slice(0, 25).map(compactAuditRow);

  return {
    work_email: email,
    aliases_checked: [...aliases],
    lookup_errors: lookupErrors.length ? lookupErrors : undefined,
    rate_history: history,
    payment_catalog_structure: catalog,
    rate_audit_events: auditEvents,
    audit_scan_note: scanNote(auditScan.deepCutoff),
    field_notes:
      'rate_history = employee_rate_history rows (used for mid-week proration); effective_from 1970-01-01 with a "baseline backfill" note is the seeded starting rate, not a real change. recorded_by "system" = an automated write. payment_catalog_structure is the CURRENT source-of-truth rate (engine precedence: catalog, then rates sheet, then department base) — set_by/last_updated_by say which admin set it; entries are newest-first and scoped per department_key, so if several exist (e.g. after a transfer) the newest matching their current department applies. rate_audit_events show rate edits from the audit trail with the acting admin. For the current merged effective rate, use get_employee_profile. Rates are hourly; currency PHP unless marked USD.',
  };
}

// ── transfers ────────────────────────────────────────────────────────────────

const TRANSFER_COLUMNS =
  'employee_name, employee_email, employee_work_email, from_department, to_department, status, reason, requested_by, approver_email, approver_note, decided_at, proposed_effective_date, effective_date, applied_at, created_at';

async function getTransferHistory(workEmail: string, limitRaw: unknown): Promise<ToolResult> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  const limit = clampInt(limitRaw, 1, 30, 15);
  const email = normEmail(workEmail) ?? '';

  let q = supabase
    .from('department_transfer_requests')
    .select(TRANSFER_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (email) {
    if (!isSafeEmail(email)) return { error: 'Invalid work_email.' };
    const aliases = await aliasesFor(email);
    const or = [...aliases]
      .flatMap((a) => [
        `employee_email.ilike.${a}`,
        `employee_work_email.ilike.${a}`,
        `employee_personal_email.ilike.${a}`,
      ])
      .join(',');
    q = q.or(or);
  }

  const { data, error } = await q;
  if (error) return { error: error.message };

  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    employee: r.employee_name,
    employee_email: r.employee_work_email ?? r.employee_email,
    from_department: r.from_department,
    to_department: r.to_department,
    status: r.status,
    reason: r.reason,
    requested_by: r.requested_by,
    approved_or_declined_by: r.approver_email,
    approver_note: r.approver_note,
    decided_at: r.decided_at,
    proposed_effective_date: r.proposed_effective_date,
    effective_date: r.effective_date,
    applied_at: r.applied_at,
    requested_at: r.created_at,
  }));

  return {
    scope: email ? `transfers for ${email}` : 'latest transfers company-wide',
    transfer_count: rows.length,
    transfers: rows,
    field_notes:
      '"When was X transferred" usually means effective_date — the pay-effective date the move counts from; applied_at is when the department was actually written to the roster; decided_at is when it was approved/declined. requested_by = the RECEIVING manager who asked for the person; approved_or_declined_by = the source-department manager (or admin) who released or declined. status: pending → approved → applied is the happy path.',
  };
}

// ── onboarding ───────────────────────────────────────────────────────────────

async function getOnboardingInfo(emailRaw: string): Promise<ToolResult> {
  const email = normEmail(emailRaw) ?? '';
  if (!email || !isSafeEmail(email)) return { error: 'Missing or invalid email.' };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  const aliases = await aliasesFor(email);

  let roster: Record<string, unknown> | null = null;
  try {
    const { employee } = await getEmployeeMasterRecord(email);
    if (employee) {
      roster = {
        name: employee.name,
        department: employee.department,
        employee_id: employee.employee_id,
        start_date: employee.start_date,
        work_email: employee.work_email,
      };
    }
  } catch {
    // person may predate the roster or not be on it — submissions still searchable
  }

  const or = [...aliases]
    .flatMap((a) => [
      `email.ilike.${a}`,
      `work_email.ilike.${a}`,
      `invite_personal_email.ilike.${a}`,
    ])
    .join(',');

  const [subsRes, auditScan] = await Promise.all([
    supabase
      .from('hr_onboarding_submissions')
      .select(
        'id, status, created_at, created_by, submitted_at, invite_name, invite_department, invite_country, full_name, email, work_email',
      )
      .or(or)
      .order('created_at', { ascending: false })
      .limit(3),
    // The whole hr.* pipeline (onboarding, orientation, checklist, pending
    // promotion, hires) plus the roster-side adds. This family is by far the
    // largest in the log, so it needs the deep scan, not a 300-row peek.
    fetchPersonAuditEvents(
      aliases,
      'action.ilike.hr.%,action.ilike.employee.create%,action.eq.master.add',
      { deepLimit: 2000 },
    ),
  ]);

  if (subsRes.error && !roster) return { error: subsRes.error.message };
  const lookupErrors: string[] = [];
  if (subsRes.error) lookupErrors.push(`onboarding submissions lookup failed: ${subsRes.error.message}`);
  if (auditScan.error) lookupErrors.push(`audit trail lookup failed: ${auditScan.error}`);

  const submissions = ((subsRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    status: r.status,
    invite_created_at: r.created_at,
    invite_created_by: r.created_by,
    paperwork_submitted_at: r.submitted_at,
    invite_name: r.invite_name,
    invite_department: r.invite_department,
    invite_country: r.invite_country,
    full_name: r.full_name,
    personal_email: r.email,
    work_email: r.work_email,
  }));

  const auditEvents = auditScan.rows.slice(0, 20).map(compactAuditRow);

  return {
    email_checked: email,
    lookup_errors: lookupErrors.length ? lookupErrors : undefined,
    roster,
    onboarding_submissions: submissions,
    onboarding_audit_events: auditEvents,
    audit_scan_note: scanNote(auditScan.deepCutoff),
    field_notes:
      'roster.start_date is the canonical "when were they onboarded" answer (the master-list Start Date, also used for tenure). onboarding_submissions covers the paperwork pipeline: invite_created_at/by = when HR minted the invite and who; paperwork_submitted_at = when the hire completed onboarding; status pending = invited but not yet submitted. People hired before the digital pipeline may have a roster row and no submission — that is normal.',
  };
}

// ── bank change history ──────────────────────────────────────────────────────

/** Every action family that touches payout details, including the read-side
 *  (`people.banking.revealed`) — who LOOKED at an account matters in a payout
 *  dispute — and the Bank Preferred approval gate. */
const BANK_ACTION_OR = [
  'action.ilike.bank_update.%',
  'action.ilike.people.banking.%',
  'action.ilike.people.bank_info.%',
  'action.ilike.bank_preferred.%',
  'action.eq.bank_override.saved',
].join(',');

async function getBankChangeHistory(workEmail: string): Promise<ToolResult> {
  const email = normEmail(workEmail) ?? '';
  if (!email || !isSafeEmail(email)) return { error: 'Missing or invalid work_email.' };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  const aliases = await aliasesFor(email);

  const [histories, auditScan] = await Promise.all([
    Promise.all([...aliases].map((a) => getPeopleBankHistory(a, 20))),
    fetchPersonAuditEvents(aliases, BANK_ACTION_OR),
  ]);

  const lookupErrors: string[] = [];
  for (const h of histories) {
    if (h.error) lookupErrors.push(`bank history lookup failed: ${h.error}`);
  }
  if (auditScan.error) lookupErrors.push(`audit trail lookup failed: ${auditScan.error}`);

  const seen = new Set<string>();
  const merged: BankChangeEntry[] = [];
  for (const h of histories) {
    for (const row of h.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
  }
  merged.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  // The history table records WHAT changed but has no actor column — the
  // channel is the only attribution signal. Only external_link is provably
  // the employee themself; every other channel is a staff-side flow whose
  // acting admin lives in the audit trail, so keep them clearly apart.
  const changes = merged.slice(0, 20).map((r) => ({
    when: r.created_at,
    person: r.name,
    work_email: r.email,
    changed_by:
      r.via === 'external_link'
        ? 'the employee themself (self-service link)'
        : `a staff-side flow (channel "${r.via ?? 'unknown'}") — the acting admin is in related_audit_events`,
    fields_written: r.fields,
    masked_changes: r.changes.map((c) => ({
      field: c.field,
      before: c.before,
      after: c.after,
      changed: c.changed,
    })),
    processor: r.processor,
    first_time_setup: r.createdNew,
    channel: r.via,
    ip_address: r.ip_address,
  }));

  const auditEvents = auditScan.rows.slice(0, 25).map(compactAuditRow);

  return {
    work_email: email,
    lookup_errors: lookupErrors.length ? lookupErrors : undefined,
    bank_change_history: changes,
    related_audit_events: auditEvents,
    audit_scan_note: scanNote(auditScan.deepCutoff),
    field_notes:
      'bank_change_history comes from the dedicated (non-clearable) bank_update_history trail. ATTRIBUTION IS PER ROW via changed_by/channel: channel "external_link" = the employee made the change through the secure self-service link and the IP is theirs; any OTHER channel (people_tab, payroll_wizard_readiness, mark_paid_override, accounting_approval, employee_dashboard, …) is a STAFF-side flow — the row does not name the actor, so find the acting admin in related_audit_events (bank_update.saved / people.banking.updated, actor = their email; match on the same timestamp). channel "payroll_wizard_readiness" specifically means an admin typed the details into the Payroll Wizard → Readiness "Set bank" fixer on the employee\'s behalf. related_audit_events also include people.banking.revealed — who VIEWED the account details, which matters in a mispayment dispute. Values are masked at write time; empty masked_changes on old rows just predates value snapshotting. Full account numbers are never stored. IMPORTANT: a complete set of bank details is not necessarily the RIGHT person\'s — if account_holder_name does not match the employee\'s own name, say so rather than treating the record as good.',
  };
}

// ── unified per-person change timeline ───────────────────────────────────────

/** Category → the audit actions that belong to it. `all` is the union; the
 *  filter is a prefix list so a newly added action in a family is picked up
 *  without a code change. */
const TIMELINE_KINDS: Record<string, string[]> = {
  bank: ['bank_update.', 'people.banking.', 'people.bank_info.', 'bank_preferred.'],
  rate: ['payroll.rate.', 'employee.rates.'],
  identity: ['people.profile.', 'employee.profile.'],
  access: ['rbac.role.', 'feature_permission.', 'auth.', 'department_manager.'],
  employment: [
    'hr.',
    'offboarding.',
    'offboarded.',
    'resignation.',
    'department_transfer.',
    'employee.create',
    'master.add',
  ],
  payroll: [
    'payment.',
    'paystub.',
    'paystubs.',
    'payroll.',
    'wizard.',
    'accounting.payroll_wizard_notes.',
    'urgent_payment.',
    'mesa.',
    'employee.mesa.',
    'pab_dispute.',
    'time_adjustment.',
    'orphanage.',
    'contractor.',
    'qc.',
  ],
};

/** Plain-English label for an action, so the timeline reads as a story rather
 *  than as raw slugs. Unknown actions pass through verbatim. */
function describeAction(action: string, details: Record<string, unknown> | null): string {
  const fields = Array.isArray(details?.fields) ? (details!.fields as unknown[]).join(', ') : '';
  switch (action) {
    case 'people.profile.updated':
      return fields ? `profile edited (${fields})` : 'profile edited';
    case 'people.banking.updated':
      return fields ? `bank details edited by staff (${fields})` : 'bank details edited by staff';
    case 'people.banking.revealed':
      return 'bank details viewed';
    case 'people.bank_info.requested':
      return 'asked to submit bank details';
    case 'bank_update.saved':
      return 'bank details saved';
    case 'bank_update.otp_requested':
      return 'bank-update code requested';
    case 'bank_update.otp_verified':
      return 'bank-update code verified';
    case 'payroll.rate.set':
      return 'pay rate set';
    case 'payment.dispatched':
      return 'payment sent';
    case 'payment.undone':
      return 'payment undone';
    case 'paystub.sent':
      return 'paystub emailed';
    case 'rbac.role.granted':
      return `role granted${details?.role ? `: ${String(details.role)}` : ''}`;
    case 'rbac.role.revoked':
      return `role revoked${details?.role ? `: ${String(details.role)}` : ''}`;
    case 'department_transfer.requested':
      return 'department transfer requested';
    case 'department_transfer.released':
      return 'department transfer released';
    case 'accounting.payroll_wizard_notes.row_added':
      return 'payroll note added';
    case 'accounting.payroll_wizard_notes.row_updated':
      return fields ? `payroll note edited (${fields})` : 'payroll note edited';
    case 'accounting.payroll_wizard_notes.row_deleted':
      return 'payroll note deleted';
    case 'accounting.payroll_wizard_notes.adjustment_bridged':
      return 'payroll note adjustment pushed into the wizard';
    default:
      return action;
  }
}

async function getChangeTimeline(input: Record<string, unknown>): Promise<ToolResult> {
  const email = normEmail(str(input.email)) ?? '';
  if (!email || !isSafeEmail(email)) return { error: 'Missing or invalid email.' };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  const kind = str(input.kind).trim().toLowerCase() || 'all';
  if (kind !== 'all' && !TIMELINE_KINDS[kind]) {
    return { error: `Unknown kind "${kind}". Use one of: all, ${Object.keys(TIMELINE_KINDS).join(', ')}.` };
  }
  const limit = clampInt(input.limit, 1, 100, 40);
  const since = isoDay(str(input.since));
  const until = isoDay(str(input.until));

  const aliases = await aliasesFor(email);
  const prefixes = kind === 'all' ? null : TIMELINE_KINDS[kind]!;
  const actionOr = prefixes
    ? prefixes
        .map((p) => (p.endsWith('.') ? `action.ilike.${escapeLike(p)}%` : `action.ilike.${escapeLike(p)}%`))
        .join(',')
    : null;

  // A whole-history sweep is wider than any single-family scan, so give the
  // details pass a bigger window.
  const auditScan = await fetchPersonAuditEvents(aliases, actionOr, {
    deepLimit: kind === 'all' ? 4000 : 2000,
    cap: 500,
    since,
    until,
  });

  const inRange = (iso: string | null | undefined): boolean => {
    if (!iso) return false;
    const day = String(iso).slice(0, 10);
    if (since && day < since) return false;
    if (until && day > until) return false;
    return true;
  };

  type Entry = {
    when: string;
    category: string;
    what: string;
    actor: string | null;
    source: string;
    detail?: unknown;
  };
  const entries: Entry[] = [];
  const lookupErrors: string[] = [];
  if (auditScan.error) lookupErrors.push(`audit trail: ${auditScan.error}`);

  const categoryOf = (action: string): string => {
    for (const [k, ps] of Object.entries(TIMELINE_KINDS)) {
      if (ps.some((p) => action.startsWith(p))) return k;
    }
    return 'other';
  };

  for (const r of auditScan.rows) {
    entries.push({
      when: r.created_at,
      category: categoryOf(r.action),
      what: describeAction(r.action, r.details),
      actor: r.user_name,
      source: `audit_log:${r.action}`,
      detail: {
        resource_id: r.resource_id,
        ip_address: r.ip_address,
        details: truncate(safeJson(r.details), 900),
      },
    });
  }

  // The bank history table is deliberately non-clearable, so it can hold rows
  // the audit log no longer does — merge it in for bank/all.
  if (kind === 'all' || kind === 'bank') {
    const histories = await Promise.all([...aliases].map((a) => getPeopleBankHistory(a, 30)));
    const seenBank = new Set<string>();
    for (const h of histories) {
      if (h.error) lookupErrors.push(`bank history: ${h.error}`);
      for (const row of h.rows) {
        if (seenBank.has(row.id) || !inRange(row.created_at)) continue;
        seenBank.add(row.id);
        entries.push({
          when: row.created_at,
          category: 'bank',
          what:
            row.via === 'external_link'
              ? `bank details ${row.createdNew ? 'first submitted' : 'updated'} by the employee (self-service link)`
              : `bank details ${row.createdNew ? 'first entered' : 'updated'} by staff (channel "${row.via ?? 'unknown'}")`,
          actor: row.via === 'external_link' ? row.name : null,
          source: 'bank_update_history',
          detail: {
            fields: row.fields,
            masked_changes: row.changes,
            processor: row.processor,
            ip_address: row.ip_address,
          },
        });
      }
    }
  }

  if (kind === 'all' || kind === 'rate') {
    const aliasOr = [...aliases].map((a) => `employee_email.ilike.${escapeLike(a)}`).join(',');
    const { data, error } = await supabase
      .from('employee_rate_history')
      .select('regular_rate, ot_rate, effective_from, note, created_by, created_at')
      .or(aliasOr)
      .order('effective_from', { ascending: false })
      .limit(60);
    if (error) lookupErrors.push(`rate history: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const when = String(r.created_at ?? r.effective_from ?? '');
      if (!inRange(when)) continue;
      entries.push({
        when,
        category: 'rate',
        what: `rate recorded: ${r.regular_rate}/hr (OT ${r.ot_rate}), effective ${String(r.effective_from ?? '')}`,
        actor: r.created_by == null ? null : String(r.created_by),
        source: 'employee_rate_history',
        detail: { note: r.note },
      });
    }
  }

  if (kind === 'all' || kind === 'payroll') {
    const aliasOr = [...aliases].map((a) => `worker_email.ilike.${escapeLike(a)}`).join(',');
    const { data, error } = await supabase
      .from('payroll_wizard_notes')
      .select('worker, worker_email, notes, adjustment, done, week_start, payroll_clerk, created_by, created_at, updated_at')
      .or(aliasOr)
      .order('created_at', { ascending: false })
      .limit(40);
    if (error) lookupErrors.push(`payroll notes: ${error.message}`);
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const when = String(r.created_at ?? '');
      if (!inRange(when)) continue;
      entries.push({
        when,
        category: 'payroll',
        what: `payroll note for week ${String(r.week_start ?? '?')}: ${truncate(String(r.notes ?? ''), 200)}`,
        actor: r.created_by == null ? null : String(r.created_by),
        source: 'payroll_wizard_notes',
        detail: {
          adjustment: r.adjustment,
          done: r.done,
          clerk: r.payroll_clerk,
          last_edited_at: r.updated_at,
        },
      });
    }
  }

  entries.sort((a, b) => (a.when < b.when ? 1 : -1));
  const shown = entries.slice(0, limit);
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.category] = (counts[e.category] ?? 0) + 1;

  return {
    email_checked: email,
    aliases_checked: [...aliases],
    kind,
    date_range: since || until ? { since, until } : 'all time',
    total_changes: entries.length,
    truncated: entries.length > shown.length,
    counts_by_category: counts,
    lookup_errors: lookupErrors.length ? lookupErrors : undefined,
    coverage_note: scanNote(auditScan.deepCutoff),
    timeline: shown,
    field_notes:
      'One merged, newest-first timeline from four sources (see each entry\'s "source"): audit_log (who did it — "actor"), bank_update_history (the non-clearable bank trail; actor is only known for self-service rows, staff rows carry a channel instead), employee_rate_history, and payroll_wizard_notes. The same change can legitimately appear twice from two sources — say it once, and prefer the audit_log row when you need the acting admin. actor null = the source does not record one; look for a matching audit_log entry at the same timestamp. Times are UTC. NOTE: people.profile.updated records WHICH fields changed but not their before/after values for edits made before 2026-07-31, so for older name/email edits report the field and the actor, and do not guess the previous value.',
  };
}

// ── payroll notes edit history ───────────────────────────────────────────────

async function getPayrollNotesHistory(input: Record<string, unknown>): Promise<ToolResult> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  const limit = clampInt(input.limit, 1, 50, 25);
  const workerEmail = normEmail(str(input.worker_email)) ?? '';
  const weekStart = isoDay(str(input.week_start));
  if (workerEmail && !isSafeEmail(workerEmail)) return { error: 'Invalid worker_email.' };

  // Scope the notes table first — the audit rows only carry the note-row id, so
  // the note is what makes an edit interpretable.
  let notesQ = supabase
    .from('payroll_wizard_notes')
    .select('id, worker, worker_email, notes, adjustment, done, week_start, note_date, payroll_clerk, created_by, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(400);
  if (workerEmail) {
    const aliases = await aliasesFor(workerEmail);
    notesQ = notesQ.or([...aliases].filter(isSafeEmail).map((a) => `worker_email.ilike.${escapeLike(a)}`).join(','));
  }
  if (weekStart) notesQ = notesQ.eq('week_start', weekStart);

  const { data: notes, error: notesErr } = await notesQ;
  if (notesErr) return { error: notesErr.message };
  const noteById = new Map<string, Record<string, unknown>>();
  for (const n of (notes ?? []) as Array<Record<string, unknown>>) noteById.set(String(n.id), n);

  // Then the edit events for exactly those rows (resource_id = the note id).
  const ids = [...noteById.keys()].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  let events: AuditRow[] = [];
  let auditError: string | undefined;
  if (ids.length) {
    // Chunked so the or() filter never grows past what PostgREST will parse.
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40));
    const results = await Promise.all(
      chunks.map((c) =>
        supabase
          .from('audit_log')
          .select(AUDIT_COLUMNS)
          .ilike('action', 'accounting.payroll_wizard_notes.%')
          .or(c.map((id) => `resource_id.eq.${id}`).join(','))
          .order('created_at', { ascending: false })
          .limit(200),
      ),
    );
    for (const r of results) {
      if (r.error) auditError = r.error.message;
      events.push(...((r.data ?? []) as AuditRow[]));
    }
    events.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  const edits = events.slice(0, limit).map((r) => {
    const note = noteById.get(String(r.resource_id ?? ''));
    return {
      when: r.created_at,
      edited_by: r.user_name,
      editor_role: r.user_role,
      what: describeAction(r.action, r.details),
      action: r.action,
      note_is_about: note
        ? {
            worker: note.worker,
            worker_email: note.worker_email,
            pay_week_start: note.week_start,
            note_date: note.note_date,
            note_text: note.notes,
            adjustment: note.adjustment,
            done: note.done,
            payroll_clerk: note.payroll_clerk,
            written_by: note.created_by,
          }
        : null,
      details: truncate(safeJson(r.details), 400),
    };
  });

  // Notes whose rows exist but have no surviving edit event (e.g. created
  // before notes auditing) — otherwise they would silently vanish.
  const editedIds = new Set(events.map((e) => String(e.resource_id ?? '')));
  const unedited = [...noteById.values()]
    .filter((n) => !editedIds.has(String(n.id)))
    .slice(0, 15)
    .map((n) => ({
      worker: n.worker,
      worker_email: n.worker_email,
      pay_week_start: n.week_start,
      note_text: n.notes,
      adjustment: n.adjustment,
      done: n.done,
      written_by: n.created_by,
      written_at: n.created_at,
      last_changed_at: n.updated_at,
    }));

  return {
    scope: workerEmail
      ? `payroll notes about ${workerEmail}${weekStart ? ` for week ${weekStart}` : ''}`
      : weekStart
        ? `payroll notes for week ${weekStart}`
        : 'latest payroll note edits company-wide',
    notes_matched: noteById.size,
    edit_events: edits.length,
    audit_error: auditError,
    edits,
    notes_with_no_recorded_edit: unedited,
    field_notes:
      'edited_by = the admin/clerk who made the EDIT. "written_by" inside note_is_about = whoever originally created the note, and payroll_clerk is the clerk the note is filed under — these three are often different people. adjustment is a signed peso string ("-5,342.33" = a deduction) and only reaches payroll once it is bridged into the wizard (action accounting.payroll_wizard_notes.adjustment_bridged). pay_week_start is the Sunday of the pay week the note applies to. The raw audit event records only which fields were touched (e.g. ["done"]), never the note text before/after — quote note_text as the CURRENT text, not as what it said at edit time. notes_with_no_recorded_edit are rows that exist but have no surviving edit event.',
  };
}

// ── audit action catalogue ───────────────────────────────────────────────────

async function listAuditActions(containsRaw: string): Promise<ToolResult> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  const contains = containsRaw.trim().toLowerCase();
  // Paged sweep of just the action + timestamp: cheap, and the only way to get
  // a true distinct list (PostgREST has no GROUP BY).
  const PAGE = 1000;
  const stats = new Map<string, { count: number; first: string; last: string }>();
  let from = 0;
  let scanned = 0;
  for (;;) {
    let q = supabase
      .from('audit_log')
      .select('action, created_at')
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (contains) q = q.ilike('action', `%${escapeLike(contains)}%`);
    const { data, error } = await q;
    if (error) return { error: error.message };
    const rows = (data ?? []) as Array<{ action: string; created_at: string }>;
    for (const r of rows) {
      const s = stats.get(r.action);
      if (!s) stats.set(r.action, { count: 1, first: r.created_at, last: r.created_at });
      else {
        s.count += 1;
        if (r.created_at < s.first) s.first = r.created_at;
        if (r.created_at > s.last) s.last = r.created_at;
      }
    }
    scanned += rows.length;
    if (rows.length < PAGE) break;
    from += PAGE;
    // Safety valve — the table is append-only and grows without bound.
    if (from >= 50000) break;
  }

  const actions = [...stats.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([action, s]) => ({
      action,
      family: action.includes('.') ? action.slice(0, action.indexOf('.')) : action,
      count: s.count,
      first_seen: s.first,
      last_seen: s.last,
    }));

  return {
    filter: contains || 'none (all actions)',
    distinct_actions: actions.length,
    events_scanned: scanned,
    actions,
    field_notes:
      'The live catalogue, read from the table itself — trust it over any action name mentioned in a tool description. Pass any of these (or a dot-prefix of one) to search_audit_log as action_prefix. first_seen marks when that event type started being recorded: an action absent before its first_seen was simply not audited yet, which is NOT evidence the underlying thing never happened.',
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** All known email addresses for a person (work, personal, gsuite aliases),
 *  normalized and safe to embed in a PostgREST or() filter. */
async function aliasesFor(email: string): Promise<Set<string>> {
  const aliases = new Set<string>([email]);
  const collect = (vals: Array<unknown>) => {
    for (const a of vals) {
      const n = normEmail(typeof a === 'string' ? a : '');
      if (n && isSafeEmail(n)) aliases.add(n);
    }
  };
  try {
    const { employee } = await getEmployeeMasterRecord(email);
    if (employee) {
      collect([
        employee.work_email,
        employee.personal_email,
        employee.alternate_work_email,
        employee.alternate_work_email_2,
      ]);
      return aliases;
    }
    // Off-boarded people are filtered out of getEmployeeMasterRecord, but
    // history questions are often ABOUT leavers — expand their aliases from
    // the raw master table (including off-boarded rows) directly.
    const supabase = createSupabaseServiceRoleClient();
    if (supabase) {
      const { data } = await supabase
        .from('global_master_list')
        .select('"Work Email", "Personal Email", "Alternate Work Email", "Alternate Work Email 2"')
        .or(`"Work Email".ilike.${email},"Personal Email".ilike.${email}`)
        .limit(1);
      const row = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (row) {
        collect([
          row['Work Email'],
          row['Personal Email'],
          row['Alternate Work Email'],
          row['Alternate Work Email 2'],
        ]);
      }
    }
  } catch {
    // roster lookup is best-effort; fall back to the input email alone
  }
  return aliases;
}

/** Keep audit rows that mention any of the person's emails in the target
 *  fields or anywhere inside details (key names vary per action). */
function auditFilterByAliases(rows: AuditRow[], aliases: Set<string>): AuditRow[] {
  const needles = [...aliases];
  return rows.filter((r) => {
    const hay = `${r.resource_id ?? ''} ${safeJson(r.details)}`.toLowerCase();
    return needles.some((a) => hay.includes(a));
  });
}

function safeJson(v: unknown): string {
  if (v == null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Basic email shape, excluding characters that are meaningful in a
 *  PostgREST or() filter (comma, parens, quotes, whitespace). */
function isSafeEmail(s: string): boolean {
  return /^[^\s@,()"']+@[^\s@,()"']+\.[^\s@,()"']+$/.test(s);
}

/** Escape PostgREST ilike wildcards in a user-influenced value. */
function escapeLike(s: string): string {
  return s.replace(/[%_]/g, '\\$&');
}

function isoDay(s: string): string | null {
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

/** The calendar day after an ISO "YYYY-MM-DD" day. */
function nextIsoDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
