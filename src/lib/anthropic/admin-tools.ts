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
      'Search the system audit log — the trail of WHO did WHAT and WHEN across the whole HRIS. Use for any "who did / who changed / who opened / when did" question: "who opened the payroll wizard", "who raised X\'s rate", "who transferred Y", "who changed Z\'s bank info", "what happened today". Filter by action family, actor, target person, and date range. Action families (prefix-match with action_prefix): wizard. (payroll wizard opened/edited), payroll. (rate.set, kpi.*, dispatch.locked/unlocked), payment.dispatched, dispatch.lock_acquired/released, paystub., bank_update. (self-service bank changes), bank_override.saved, csv. (sheet/CSV syncs), hubstaff.api_sync, employee. (create/delete/rates.update/profile.update/suspend), master.add, hr. (onboarding/pending/offboarding pipeline), offboarding., resignation., department_transfer. (requested/released/declined/applied), department_manager., leave., pab_dispute., time_adjustment., mesa., gift., orphanage., contractor., announcement., ticket., documents., people. (profile/banking edits from the People tab), rbac.role. (granted/revoked), auth., settings., urgent_payment. Combine with find_employee first when the user names a person, then pass their email as target.',
    input_schema: {
      type: 'object',
      properties: {
        action_prefix: {
          type: 'string',
          description:
            'Filter to actions starting with this prefix, e.g. "payroll.rate", "wizard.", "bank_update.", "department_transfer.". Omit to search every action.',
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
    details: truncate(safeJson(r.details), 600),
  };
}

async function searchAuditLog(input: Record<string, unknown>): Promise<ToolResult> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  const limit = clampInt(input.limit, 1, 50, 20);
  // Action prefixes are dot-separated slugs; strip anything that could morph
  // the PostgREST filter (%, commas, quotes) rather than rejecting outright.
  const actionPrefix = str(input.action_prefix).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const actorRaw = str(input.actor_email).trim().toLowerCase();
  const actor = normEmail(actorRaw) ?? actorRaw;
  const target = str(input.target).trim().toLowerCase();
  const since = isoDay(str(input.since));
  const until = isoDay(str(input.until));

  // When a free-text target filter is present we can't push it into SQL
  // (details keys vary per action), so pull a wider window and filter here.
  const fetchLimit = target ? 500 : limit;

  let q = supabase
    .from('audit_log')
    .select(AUDIT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(fetchLimit);
  if (actionPrefix) q = q.ilike('action', `${escapeLike(actionPrefix)}%`);
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

  const { data, error } = await q;
  if (error) return { error: error.message };

  let rows = (data ?? []) as AuditRow[];
  if (target) {
    rows = rows.filter((r) => {
      const hay = [r.resource_id, r.resource, r.action, r.user_name, safeJson(r.details)]
        .join(' ')
        .toLowerCase();
      return hay.includes(target);
    });
  }

  const shown = rows.slice(0, limit).map(compactAuditRow);
  return {
    match_count: rows.length,
    truncated: rows.length > shown.length,
    scanned_note: target
      ? 'Free-text target matching scanned the newest 500 events passing the other filters — the count is within that window only; narrow with action_prefix or a date range to reach older history.'
      : undefined,
    field_notes:
      'actor = who performed the action (usually their signed-in email; a few flows stamp a display name or label). "anonymous" = an unauthenticated/public flow (e.g. the self-service bank-update link — attribution then lives in the details/resource_id). Self-service bank changes also live in get_bank_change_history. Event times are UTC ISO timestamps; the since/until filters select Asia/Manila calendar days.',
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

  const [historyRes, catalogRes, auditRes] = await Promise.all([
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
    supabase
      .from('audit_log')
      .select(AUDIT_COLUMNS)
      .or('action.ilike.payroll.rate.%,action.ilike.employee.rates.%')
      .order('created_at', { ascending: false })
      .limit(300),
  ]);

  if (historyRes.error) return { error: historyRes.error.message };
  // Partial failures must read as failures, not as "no records".
  const lookupErrors: string[] = [];
  if (catalogRes.error) lookupErrors.push(`payment catalog lookup failed: ${catalogRes.error.message}`);
  if (auditRes.error) lookupErrors.push(`audit trail lookup failed: ${auditRes.error.message}`);

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

  const auditEvents = auditFilterByAliases(
    (auditRes.data ?? []) as AuditRow[],
    aliases,
  ).slice(0, 15).map(compactAuditRow);

  return {
    work_email: email,
    aliases_checked: [...aliases],
    lookup_errors: lookupErrors.length ? lookupErrors : undefined,
    rate_history: history,
    payment_catalog_structure: catalog,
    rate_audit_events: auditEvents,
    audit_scan_note:
      'rate_audit_events were matched within the newest 300 rate-related audit events — older edits may exist; use search_audit_log with a date range for deeper history.',
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

  const [subsRes, auditRes] = await Promise.all([
    supabase
      .from('hr_onboarding_submissions')
      .select(
        'id, status, created_at, created_by, submitted_at, invite_name, invite_department, invite_country, full_name, email, work_email',
      )
      .or(or)
      .order('created_at', { ascending: false })
      .limit(3),
    supabase
      .from('audit_log')
      .select(AUDIT_COLUMNS)
      // hr.onboarding/hr.pending = the digital paperwork pipeline;
      // employee.create + hr.employee.% = direct roster adds and re-onboards.
      .or(
        'action.ilike.hr.onboarding.%,action.ilike.hr.pending.%,action.eq.employee.create,action.ilike.hr.employee.%,action.eq.master.add',
      )
      .order('created_at', { ascending: false })
      .limit(300),
  ]);

  if (subsRes.error && !roster) return { error: subsRes.error.message };
  const lookupErrors: string[] = [];
  if (subsRes.error) lookupErrors.push(`onboarding submissions lookup failed: ${subsRes.error.message}`);
  if (auditRes.error) lookupErrors.push(`audit trail lookup failed: ${auditRes.error.message}`);

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

  const auditEvents = auditFilterByAliases(
    (auditRes.data ?? []) as AuditRow[],
    aliases,
  ).slice(0, 10).map(compactAuditRow);

  return {
    email_checked: email,
    lookup_errors: lookupErrors.length ? lookupErrors : undefined,
    roster,
    onboarding_submissions: submissions,
    onboarding_audit_events: auditEvents,
    audit_scan_note:
      'onboarding_audit_events were matched within the newest 300 onboarding-pipeline audit events — use search_audit_log with a date range for older history.',
    field_notes:
      'roster.start_date is the canonical "when were they onboarded" answer (the master-list Start Date, also used for tenure). onboarding_submissions covers the paperwork pipeline: invite_created_at/by = when HR minted the invite and who; paperwork_submitted_at = when the hire completed onboarding; status pending = invited but not yet submitted. People hired before the digital pipeline may have a roster row and no submission — that is normal.',
  };
}

// ── bank change history ──────────────────────────────────────────────────────

async function getBankChangeHistory(workEmail: string): Promise<ToolResult> {
  const email = normEmail(workEmail) ?? '';
  if (!email || !isSafeEmail(email)) return { error: 'Missing or invalid work_email.' };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  const aliases = await aliasesFor(email);

  const [histories, auditRes] = await Promise.all([
    Promise.all([...aliases].map((a) => getPeopleBankHistory(a, 20))),
    supabase
      .from('audit_log')
      .select(AUDIT_COLUMNS)
      .or(
        'action.ilike.bank_update.%,action.eq.people.banking.updated,action.eq.bank_override.saved,action.ilike.people.bank_info.%',
      )
      .order('created_at', { ascending: false })
      .limit(300),
  ]);

  const lookupErrors: string[] = [];
  for (const h of histories) {
    if (h.error) lookupErrors.push(`bank history lookup failed: ${h.error}`);
  }
  if (auditRes.error) lookupErrors.push(`audit trail lookup failed: ${auditRes.error.message}`);

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

  const auditEvents = auditFilterByAliases(
    (auditRes.data ?? []) as AuditRow[],
    aliases,
  ).slice(0, 15).map(compactAuditRow);

  return {
    work_email: email,
    lookup_errors: lookupErrors.length ? lookupErrors : undefined,
    bank_change_history: changes,
    related_audit_events: auditEvents,
    audit_scan_note:
      'related_audit_events were matched within the newest 300 bank-related audit events — use search_audit_log for older history.',
    field_notes:
      'bank_change_history comes from the dedicated (non-clearable) bank_update_history trail. ATTRIBUTION IS PER ROW via changed_by/channel: channel "external_link" = the employee made the change through the secure self-service link and the IP is theirs; any OTHER channel (people_tab, mark_paid_override, accounting_approval, employee_dashboard, …) is a staff-side flow — the row does not name the actor, so find the acting admin in related_audit_events (people.banking.updated / bank_override.saved / bank_update.saved, actor = their email). Values are masked at write time; empty masked_changes on old rows just predates value snapshotting. Full account numbers are never stored.',
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
