import 'server-only';

import type Anthropic from '@anthropic-ai/sdk';
import { normEmail } from '@/lib/email/norm-email';
import {
  getEmployeesForAuthorizedServerRoute,
  getEmployeeMasterRecord,
} from '@/lib/supabase/employees';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import {
  collapseOffboardedRows,
  matchesRosterQuery,
  rankRosterMatches,
  rosterMatchNote,
  type OffboardedMasterRow,
  type RosterCandidate,
} from '@/lib/penny/roster-match';
import {
  applyDispatchedTotals,
  buildReconciledPayWeeks,
  rollUpDispatchedByCycle,
  totalsFor,
  type PayRecordInput,
  type WizardSnapshotInput,
} from '@/lib/penny/pay-reconciliation';
import { getAppSettingsWithMeta } from '@/lib/supabase/app-settings';
import { finalPaySnapshotKey } from '@/lib/payroll/paystub-fresh';
import {
  createSupabaseServiceRoleClient,
  createSupabaseServerClient,
} from '@/lib/supabase/server';
import { listDisbursementReports } from '@/lib/payroll/disbursement-reports';
import {
  listHubstaffUploads,
  fetchHubstaffRowsOrdered,
  fetchHubstaffRowsBySourceFile,
  rowsToPayrollRows,
} from '@/lib/supabase/hubstaff-hours-db';
import { periodLabelFromFilename } from '@/lib/hubstaff/period-label';
import { listPayrollWizardNotes } from '@/lib/supabase/payroll-wizard-notes';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { getSkillSet } from '@/lib/supabase/employee-skill-sets';
import { getProfilePhotoUrlForEmail } from '@/lib/supabase/employee-profile-photo';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import {
  fetchFeaturePermissionsForEmail,
  resolveFeatureAccess,
  FEATURE_CATALOG,
  ROLE_TO_FEATURE_VIEW,
  type FeatureViewKey,
  type FeaturePermissionsMap,
} from '@/lib/rbac/feature-permissions';
import { hasElevatedRole, hasRateVisibility } from '@/lib/auth/elevated-roles';
import { ROUTE_REQUIRED_ROLES } from '@/lib/auth/route-access';

/** Hubstaff exports append a ~30k-hour grand-total row that parses as a fake
 *  person; drop any row over this when aggregating across everyone. */
const MAX_PLAUSIBLE_WEEKLY_HOURS = 192;

const DEPT_NAME = new Map(DEPARTMENTS.map((d) => [d.key, d.name]));
const deptDisplay = (v: string): string => DEPT_NAME.get(v) ?? v;

/**
 * Read-only "knowledge base" tools the CEO assistant can call to pull real
 * financial data out of Supabase. Each tool is backed by an existing server
 * function or a narrow, pre-shaped query — we never let the model write SQL.
 *
 * Add a new capability by appending a definition to CEO_TOOLS and a case to
 * runCeoTool(). Keep results small, exact, and labelled with their source so
 * the model interprets them correctly and never invents a number.
 */

export const CEO_TOOLS: Anthropic.Tool[] = [
  {
    name: 'find_employee',
    description:
      "Resolve a person's name or email to their employee record(s). ALWAYS call this first whenever the user names a person (e.g. \"Kane\", \"kane@simple.biz\") — you need the exact work_email it returns before you can look up their pay. Searches ACTIVE and OFF-BOARDED people: every match carries status, and an off-boarded match also carries when they left, the recorded reason and who recorded it. An off-boarded person is still a real record — their pay, history and audit trail remain searchable with the other tools — so never describe one as 'not in the system'; say they were off-boarded on that date. Returns 0, 1, or several matches (active first). If several match, ask the user which one (by department or work email) before continuing; never guess.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A name, partial name, or email address. Matches active employees AND off-boarded people (labelled).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_employee_pay',
    description:
      'Get one employee\'s recent weekly pay from the payroll disbursement records. Use for "what was X\'s last pay" (weeks=1) or "add/sum the last N weeks of X\'s pay" (weeks=N). Requires the exact work_email from find_employee. Returns one entry per pay week (most recent first) with hours, the computed amount, the actually-paid amount, and status — plus a summed total across the returned weeks so you can answer "add up" questions directly.',
    input_schema: {
      type: 'object',
      properties: {
        work_email: {
          type: 'string',
          description: "The employee's work email, exactly as returned by find_employee.",
        },
        weeks: {
          type: 'integer',
          description:
            'How many recent pay weeks to return (1–26). Default 1 (the latest pay). Use a large value (e.g. 26) for "all his pay", "since he started", or "since the first data we have".',
        },
      },
      required: ['work_email'],
    },
  },
  {
    name: 'get_payroll_report',
    description:
      'Get company-wide weekly payroll totals — how much was paid out, to how many people, and how much is still outstanding — for the most recent pay weeks. Use for "pull the payroll report", "how much did we pay out last week/month", or any org-level financial question. Returns one summary per week (most recent first) plus a combined total across the weeks.',
    input_schema: {
      type: 'object',
      properties: {
        weeks: {
          type: 'integer',
          description: 'How many recent pay weeks to include (1–12). Default 4.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_overtime_leaders',
    description:
      'Rank employees by OVERTIME hours over recent pay weeks. Use for "top N people by overtime", "who worked the most OT in the last 2 weeks", or any overtime report. Returns the top people (default 5) with summed OT hours, regular hours, total hours, their department, and computed pay — across the most recent N pay weeks (default 1). Also returns the exact period covered so you can label the report (e.g. its subtitle).',
    input_schema: {
      type: 'object',
      properties: {
        weeks: {
          type: 'integer',
          description: 'How many recent pay weeks to span (1–12). "last 2 weeks" = 2. Default 1.',
        },
        limit: {
          type: 'integer',
          description: 'How many top people to return (1–25). Default 5.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_department_bonuses',
    description:
      'Rank DEPARTMENTS by the total bonuses actually awarded to their people (from the Payment Catalog applied bonuses). Use for "top N departments by bonuses", "which teams got the most bonus pay", or a Payment Catalog bonus report. Returns departments (default top 5) with total bonus amount, how many people received a bonus, and the bonus count, over the most recent N pay weeks (default 12). Amounts are the stored bonus amounts (mostly PHP) — treat cross-currency totals as approximate.',
    input_schema: {
      type: 'object',
      properties: {
        weeks: {
          type: 'integer',
          description: 'How many recent pay weeks to span (1–26). Default 12.',
        },
        limit: {
          type: 'integer',
          description: 'How many top departments to return (1–25). Default 5.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_employee_profile',
    description:
      "Get an employee's profile for a fair, balanced read on them: identity (name, department, employee ID, start date, work + personal email, home address), hourly rates (regular + OT, in PHP), their self-entered skill sets (role/title, skills, strengths, current projects), recognition (commendation count + recent notes = positive praise) AND concerns (manager 'flag for review' count + recent notes = red flags, CEO-visible only). Use this whenever the CEO asks you to assess, evaluate, or give an opinion on a person — it gives you BOTH their strengths and any concerns so you don't answer with praise alone. Also returns has_profile_photo so you know whether a roster section will show their avatar. Requires the exact work_email from find_employee. Note: bank/payout details are intentionally NOT included.",
    input_schema: {
      type: 'object',
      properties: {
        work_email: {
          type: 'string',
          description: "The employee's work email, exactly as returned by find_employee.",
        },
      },
      required: ['work_email'],
    },
  },
  {
    name: 'get_financial_summary',
    description:
      'Company payroll financials for a CALENDAR MONTH — use this to build a "financial statement for May 2026", answer "how much did payroll cost last month", or any monthly summary. Returns the month\'s totals (paid PHP + USD, outstanding, recipients paid, regular + OT hours), a per-week breakdown within the month, AND the prior month\'s headline totals with the % change, so you can write a trend/insight. Pass month as "YYYY-MM"; omit it for the most recent month on record.',
    input_schema: {
      type: 'object',
      properties: {
        month: {
          type: 'string',
          description: 'Calendar month as "YYYY-MM" (e.g. "2026-05"). Omit for the latest month with payroll data.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_employee_access',
    description:
      "Get a person's ADMIN PROVISIONS — what they are allowed to access in the system. Use for any access/permission question: \"how much access does X have\", \"what can X see or edit\", \"is X an admin\", \"which dashboards can X open\", \"what departments does X manage\", \"can X see pay rates\". Returns their active roles, the staff dashboards their roles let them open, the per-tab permission overlay (hidden/view/edit) for each dashboard, the departments they manage (if a manager), and flags for admin, elevated (can act on other employees' data), and pay-rate visibility. Requires the exact work_email from find_employee. This is about ACCESS RIGHTS, not pay or attendance.",
    input_schema: {
      type: 'object',
      properties: {
        work_email: {
          type: 'string',
          description: "The employee's work email, exactly as returned by find_employee.",
        },
      },
      required: ['work_email'],
    },
  },
  {
    name: 'get_hours_uploads',
    description:
      'List the weekly hours batches uploaded through the Payroll Wizard (newest first) — the raw Hubstaff time data each pay run is built from. Use for "is this week\'s hours data in yet", "when was the latest upload and who uploaded it", or to find the exact source_file to pass to get_uploaded_hours. Returns each batch\'s source_file, pay-period label and dates, upload time, uploader, row count, and which batch is the wizard\'s CURRENT working one.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'How many recent uploads to list (1–26). Default 8.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_uploaded_hours',
    description:
      'Read the raw HOURS inside one Payroll Wizard hours upload — time logged per person BEFORE rates or bonuses are applied (for money, use get_employee_pay / get_payroll_report instead). Use for "how many hours did X log this week", "who logged the most hours in the current upload", or "how many hours came in for this pay period". Defaults to the wizard\'s CURRENT batch; pass a source_file from get_hours_uploads for an older week. Pass work_email (from find_employee) to scope to one person; otherwise returns a company summary plus the top people by hours.',
    input_schema: {
      type: 'object',
      properties: {
        source_file: {
          type: 'string',
          description:
            'A batch source_file exactly as returned by get_hours_uploads. Omit for the current batch.',
        },
        work_email: {
          type: 'string',
          description:
            "One employee's work email (from find_employee) to return just their uploaded hours.",
        },
        limit: {
          type: 'integer',
          description:
            'How many top-by-hours people to include in the company view (1–25). Default 10. Ignored when work_email is given.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_payroll_wizard_notes',
    description:
      'Read the Payroll Wizard\'s carry-over Notes board — the running checklist payroll clerks keep between weekly runs (missed bonuses, staged rate changes, deductions to apply, follow-ups). Use for "anything pending for the next payroll", "what did the clerks flag", or "is there unfinished payroll business". Returns open items by default, grouped under the clerk who wrote them; set include_done=true to also see completed items.',
    input_schema: {
      type: 'object',
      properties: {
        include_done: {
          type: 'boolean',
          description: 'Also include items already ticked Done. Default false (open items only).',
        },
      },
      required: [],
    },
  },
];

// ── execution ────────────────────────────────────────────────────────────────

type ToolResult = Record<string, unknown>;

export async function runCeoTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'find_employee':
        return await findEmployee(str(input.query));
      case 'get_employee_pay':
        return await getEmployeePay(str(input.work_email), input.weeks);
      case 'get_payroll_report':
        return await getPayrollReport(input.weeks);
      case 'get_overtime_leaders':
        return await getOvertimeLeaders(input.weeks, input.limit);
      case 'get_department_bonuses':
        return await getDepartmentBonuses(input.weeks, input.limit);
      case 'get_employee_profile':
        return await getEmployeeProfile(str(input.work_email));
      case 'get_employee_access':
        return await getEmployeeAccess(str(input.work_email));
      case 'get_financial_summary':
        return await getFinancialSummary(input.month);
      case 'get_hours_uploads':
        return await getHoursUploads(input.limit);
      case 'get_uploaded_hours':
        return await getUploadedHours(input.source_file, input.work_email, input.limit);
      case 'get_payroll_wizard_notes':
        return await getPayrollWizardNotes(input.include_done);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Every `global_master_list` row that carries an off-board stamp. Read directly
 * from the table — `active_employees` cannot see these people by definition,
 * and `getEmployeeMasterRecord` deliberately refuses stamped rows (work emails
 * are recycled, so resolving a LOGIN identity to a leaver would surface the
 * wrong account). A SEARCH that labels each hit as off-boarded has neither
 * problem. Paged: 1,058 stamped rows on 2026-09-15, past the 1,000-row cap.
 */
async function listOffboardedMasterRows(): Promise<{ rows: OffboardedMasterRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Service-role client unavailable — off-boarded people were not searched.' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase
      .from('global_master_list')
      .select(
        'id, Name, Department, "Work Email", "Personal Email", employee_id, off_boarded_at, off_boarded_reason, off_boarded_by',
      )
      .not('off_boarded_at', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (error) return { rows: [], error };
  const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  return {
    rows: rows.map((r) => ({
      name: s(r['Name']),
      work_email: s(r['Work Email']),
      personal_email: s(r['Personal Email']),
      department: s(r['Department']),
      employee_id: s(r['employee_id']),
      off_boarded_at: s(r['off_boarded_at']),
      off_boarded_reason: s(r['off_boarded_reason']),
      off_boarded_by: s(r['off_boarded_by']),
    })),
    error: null,
  };
}

async function findEmployee(query: string): Promise<ToolResult> {
  const q = query.trim();
  if (!q) return { error: 'Empty search query.' };

  const { employees, error } = await getEmployeesForAuthorizedServerRoute();
  if (error) return { error };

  const activeCandidates: RosterCandidate[] = employees.map((e) => ({
    name: e.name ?? null,
    work_email: e.work_email ?? null,
    personal_email: e.personal_email ?? null,
    department: e.department ?? null,
    employee_id: e.employee_id ?? null,
    status: 'active',
    off_boarded_at: null,
    off_boarded_reason: null,
    off_boarded_by: null,
    departments: e.department ? [e.department] : [],
  }));
  const activeWorkEmails = new Set(
    employees.map((e) => (e.work_email ?? '').trim().toLowerCase()).filter(Boolean),
  );

  // Leavers too (Carla, 2026-09-15: a person off-boarded the day before was
  // reported as "not in the system"). The active roster stays the authority:
  // a stamped duplicate beside an active row never demotes anyone.
  const stamped = await listOffboardedMasterRows();
  const offboardedCandidates = collapseOffboardedRows(stamped.rows, activeWorkEmails);

  const matches = rankRosterMatches(
    [...activeCandidates, ...offboardedCandidates].filter((c) => matchesRosterQuery(c, q)),
  );

  const shown = matches.slice(0, 8).map((m) => ({
    name: m.name,
    work_email: m.work_email,
    department: m.department,
    employee_id: m.employee_id,
    status: m.status,
    ...(m.status === 'offboarded'
      ? {
          off_boarded_at: m.off_boarded_at,
          off_boarded_reason: m.off_boarded_reason,
          off_boarded_by: m.off_boarded_by,
          departments: m.departments,
        }
      : {}),
  }));

  return {
    match_count: matches.length,
    active_matches: matches.filter((m) => m.status === 'active').length,
    offboarded_matches: matches.filter((m) => m.status === 'offboarded').length,
    matches: shown,
    truncated: matches.length > shown.length,
    lookup_errors: stamped.error
      ? [`off-boarded people lookup failed: ${stamped.error} — these results cover ACTIVE people only`]
      : undefined,
    note: rosterMatchNote(matches),
  };
}

async function getEmployeePay(workEmail: string, weeksRaw: unknown): Promise<ToolResult> {
  const email = normEmail(workEmail);
  // Shape-guard: the value flows into a PostgREST or() filter, so reject
  // anything with commas/parens/quotes/whitespace that could malform the query.
  if (!email || !isSafeEmail(email)) return { error: 'Missing or invalid work_email.' };
  const weeks = clampInt(weeksRaw, 1, 26, 1);

  // Match disbursement rows by any of the employee's known addresses, since the
  // record may be keyed on a work alias or the personal email.
  const aliases = new Set<string>([email]);
  try {
    const { employee } = await getEmployeeMasterRecord(email);
    for (const a of [
      employee?.work_email,
      employee?.personal_email,
      employee?.alternate_work_email,
      employee?.alternate_work_email_2,
    ]) {
      const n = normEmail(a ?? '');
      if (n && isSafeEmail(n)) aliases.add(n);
    }
  } catch {
    // fall back to just the input email
  }

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  // PostgREST or() values are NOT quoted (emails contain no reserved chars).
  const orFilter = [...aliases].map((a) => `recipient_email.ilike.${a}`).join(',');
  const mesaOrFilter = [...aliases].map((a) => `email.ilike.${a}`).join(',');
  const [disbRes, dispatchRes, mesaRes] = await Promise.all([
    supabase
      .from('disbursement_records')
      .select(
        'cycle_period_start, cycle_period_end, recipient_name, total_hours, regular_hours, ot_hours, amount_php, amount_usd, status, paid_amount_usd, paid_at, source_file',
      )
      .or(orFilter)
      .order('cycle_period_start', { ascending: false })
      .limit(weeks),
    // The live dispatch log is the clerk's ground truth and leads the weekly
    // records: the NEWEST cycle's payments land here first and only mirror
    // into disbursement_records where that cycle was already seeded. Overlay
    // it so "was I paid this week?" is answered from the freshest data.
    //
    // `system_bonus_php` / `system_bonus_label` are selected because the bonus
    // folded into a paid amount is HERE, on a row this query already fetched.
    // Omitting them is why Penny once told the CEO a $79.88 gap was "almost
    // certainly a bonus" — a guess, standing on a labelled figure it never read.
    supabase
      .from('payment_dispatches')
      .select(
        'cycle_period_start, cycle_period_end, recipient_name, amount_usd, amount_php, amount_cop, status, sent_date, created_at, payee_type, system_bonus_php, system_bonus_label',
      )
      .or(orFilter)
      .eq('status', 'paid')
      .order('cycle_period_start', { ascending: false })
      .limit(40),
    // The third term in the payslip. A MESA member contributes ₱100 of their
    // own money each week, so hourly + bonus alone never equals what landed.
    // `simple_match_php` is Simple's ₱300 on top and is deliberately NOT read:
    // it is not the employee's money and netting it understates take-home.
    supabase
      .from('mesa_ledger')
      .select('deposit_date, worker_contribution_php')
      .or(mesaOrFilter)
      .not('deposit_date', 'is', null)
      .order('deposit_date', { ascending: false })
      .limit(120),
  ]);

  if (disbRes.error) return { error: disbRes.error.message };

  const rows = (disbRes.data ?? []) as Array<Record<string, unknown>>;

  const records: PayRecordInput[] = rows.map((r) => ({
    period_start: String(r.cycle_period_start ?? ''),
    period_end: (r.cycle_period_end as string | null) ?? null,
    recipient_name: (r.recipient_name as string | null) ?? null,
    total_hours: num(r.total_hours),
    regular_hours: num(r.regular_hours),
    ot_hours: num(r.ot_hours),
    // NOT "computed". `amount_php` / `amount_usd` are regular + OT pay and
    // nothing else; calling a partial figure "computed" is what sent the CEO
    // looking for an error that was never there.
    hourly_pay_php: numOrNull(r.amount_php),
    hourly_pay_usd: numOrNull(r.amount_usd),
    status: (r.status as string | null) ?? null,
    paid_usd: numOrNull(r.paid_amount_usd),
    paid_at: (r.paid_at as string | null) ?? null,
  }));

  // The bonus ITEMIZATION lives in the Payroll Wizard's final-pay snapshot,
  // reached by the cycle's own source file — `payment_dispatches` freezes only
  // a bonus TOTAL plus a label that names its PAB/Tech part, so quoting that
  // label as the bonus understates it (measured: ₱157,805 labelled "PAB ₱5,000").
  // The dispatch row's file is preferred because it is the row that paid.
  const fileByStart = new Map<string, string>();
  for (const r of rows) {
    const start = String(r.cycle_period_start ?? '');
    const file = String(r.source_file ?? '');
    if (start && file) fileByStart.set(start, file);
  }
  for (const d of (dispatchRes.data ?? []) as Array<Record<string, unknown>>) {
    const start = String(d.cycle_period_start ?? '');
    const file = String(d.cycle_source_file ?? '');
    if (start && file) fileByStart.set(start, file);
  }
  const snapshots = new Map<string, WizardSnapshotInput>();
  if (fileByStart.size > 0) {
    const keys = [...new Set([...fileByStart.values()].map(finalPaySnapshotKey))];
    const settings = await getAppSettingsWithMeta(keys).catch(() => ({}));
    for (const [start, file] of fileByStart) {
      const meta = (settings as Record<string, { value: string } | undefined>)[finalPaySnapshotKey(file)];
      if (!meta) continue;
      let entry: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(meta.value) as unknown;
        const finals =
          parsed && typeof parsed === 'object' && 'finals' in parsed
            ? ((parsed as { finals?: unknown }).finals as Record<string, unknown> | undefined)
            : undefined;
        if (!finals) continue;
        // `finals` keys the SAME entry under work and personal email.
        for (const a of aliases) {
          const hit = finals[a];
          if (hit && typeof hit === 'object') {
            entry = hit as Record<string, unknown>;
            break;
          }
        }
      } catch {
        // An unreadable snapshot leaves the week un-itemised, which the builder
        // reports as breakdown_unavailable rather than as a ₱0 breakdown.
        continue;
      }
      if (!entry) continue;
      snapshots.set(start, {
        source_file: file,
        regular_pay_php: numOrNull(entry.regularPay),
        ot_pay_php: numOrNull(entry.otPay),
        pab_php: numOrNull(entry.perfectAttendanceBonus),
        tech_php: numOrNull(entry.techBonus),
        other_bonuses_php: numOrNull(entry.otherBonuses),
        adjustment_php: numOrNull(entry.adjustment),
        adjustment_note: typeof entry.adjustmentNote === 'string' ? entry.adjustmentNote : null,
        orphanage_php: numOrNull(entry.orphanagePay),
        mesa_deduction_php: numOrNull(entry.mesaDeduction),
        mesa_disbursement_php: numOrNull(entry.mesaDisbursement),
        final_php: numOrNull(entry.final),
      });
    }
  }

  const { entries, recipient_name } = buildReconciledPayWeeks({
    records,
    snapshots,
    dispatches: ((dispatchRes.data ?? []) as Array<Record<string, unknown>>).map((d) => ({
      period_start: (d.cycle_period_start as string | null) ?? null,
      period_end: (d.cycle_period_end as string | null) ?? null,
      recipient_name: (d.recipient_name as string | null) ?? null,
      paid_usd: numOrNull(d.amount_usd),
      paid_php: numOrNull(d.amount_php),
      bonus_php: numOrNull(d.system_bonus_php),
      bonus_label: (d.system_bonus_label as string | null) ?? null,
      at: String(d.created_at ?? d.sent_date ?? ''),
      payee_type: (d.payee_type as string | null) ?? null,
    })),
    mesaDeposits: ((mesaRes.data ?? []) as Array<Record<string, unknown>>).map((m) => ({
      deposit_date: (m.deposit_date as string | null) ?? null,
      worker_contribution_php: numOrNull(m.worker_contribution_php),
    })),
    weeks,
  });

  if (entries.length === 0) {
    return {
      work_email: email,
      weeks: [],
      note: 'No payroll disbursement records found for this employee. They may be a new hire, on a non-payroll arrangement, or paid outside this system.',
    };
  }

  return {
    work_email: email,
    recipient_name: rows[0]?.recipient_name ?? recipient_name ?? null,
    currency: 'PHP (₱) and USD ($) as each field is labelled',
    field_notes:
      'EVERY WEEK ADDS UP, and this is the payroll\'s own identity — show the workings, not just the endpoints: ' +
      'hourly_pay_php + bonus_total_php + orphanage_php − deduction_php + mesa_disbursement_php = paid_php, and ' +
      'bonus_pab_php + bonus_tech_php + bonus_other_php + bonus_adjustment_php = bonus_total_php. ' +
      '**hourly_pay_php / hourly_pay_usd are REGULAR + OT PAY ONLY — hours × rate.** Call this "Hourly Pay", NEVER "computed", ' +
      '"computed pay" or "total": it is one line of a payslip, and naming a partial figure like a total is what made a CEO ' +
      'think the payroll was wrong. BONUSES: itemise them — bonus_pab_php (Perfect Attendance), bonus_tech_php, ' +
      'bonus_other_php (every earned KPI / department bonus) and bonus_adjustment_php (Accounting\'s SIGNED adjustment; ' +
      'NEGATIVE means money withheld — report it, never hide it or treat it as a bonus). ' +
      '**bonus_label is frozen from the dispatch and names only the PAB/Tech part — it is NOT the bonus.** When ' +
      'bonus_label_note is present the label understates the total; use the itemised fields and ignore the label. ' +
      'deduction_php = the MESA contribution withheld (the employee\'s OWN savings, not a charge — say so if asked); ' +
      'mesa_disbursement_php = MESA money paid back OUT to them; orphanage_php = orphanage pay added. ' +
      'paid_php / paid_usd = what actually left. reconciles=true means the identity closes exactly; if false, ' +
      'unexplained_php is the remainder — report it and DO NOT guess what it was. ' +
      'breakdown_unavailable=true means no wizard snapshot exists for that cycle, so the bonus could not be itemised — ' +
      'say the breakdown is unavailable rather than presenting ₱0 for a component nobody computed. ' +
      'A money field that is ABSENT is genuinely not on record — say "not recorded", never "₱0" and never ' +
      '"the system does not store this". A ZERO on an itemised week IS a real computed claim. ' +
      'status: paid = sent; pending = owed but not yet sent; not_paid/threshold/problem = held. ' +
      'source "live_dispatch_log" = straight from the live payment log (freshest; the weekly record is not seeded, so hours and ' +
      'hourly pay are missing and the paid amount is authoritative).',
    weeks: entries,
    totals: totalsFor(entries),
  };
}

async function getPayrollReport(weeksRaw: unknown): Promise<ToolResult> {
  const weeks = clampInt(weeksRaw, 1, 12, 4);
  const { reports, error } = await listDisbursementReports();
  if (error) return { error };
  const supabaseForReport = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabaseForReport) return { error: 'Database is not reachable.' };

  // Drop synthesized "urgent" (MESA / orphanage budget) buckets — they have no
  // hours/rate snapshots and would muddy a payroll total.
  const regular = reports.filter(
    (r) => !String(r.cycleId).includes('urgent') && !String(r.sourceFile ?? '').startsWith('urgent'),
  );
  const top = regular.slice(0, weeks);

  const weeksOut = top.map((r) => ({
    period: r.reportName,
    period_start: r.periodStart,
    period_end: r.periodEnd,
    is_current_cycle: r.isCurrent,
    paid_count: r.totals.paidCount,
    paid_usd: round2(r.totals.paidUSD),
    paid_php: round2(r.totals.paidPHP),
    outstanding_count: r.totals.outstandingCount,
    outstanding_usd: round2(r.totals.outstandingUSD),
    total_owed_usd: round2(r.totals.totalOwedUSD),
  }));

  // `listDisbursementReports()` tallies paidPHP from `disbursement_records.
  // amount_php`, which is REGULAR + OT ONLY, while paidUSD comes from
  // `paid_amount_usd` — what was actually disbursed. So the two money columns
  // of the same row were different money and the peso one silently dropped
  // every PAB, Tech, KPI and Accounting adjustment. Measured 2026-09-17 over
  // four weeks: ₱36,704,762.39 reported against ₱51,106,248.37 dispatched —
  // ₱14.4M, ~28%, missing. `disbursement_records` has no paid-PHP column, so
  // the figure is taken from the dispatch log instead. Both currencies come
  // from the same rows, or the implied FX rate is nobody's.
  const starts = weeksOut.map((w) => String(w.period_start ?? '')).filter(Boolean);
  if (starts.length > 0) {
    // PostgREST caps at 1000 rows even with .range() and a single cycle is
    // already ~1,050 payments — this MUST page (CLAUDE.md, selectAllPaged).
    const { rows: dispatchRows, error: dispatchError } = await selectAllPaged<Record<string, unknown>>(
      (from, to) =>
        supabaseForReport
          .from('payment_dispatches')
          .select('cycle_period_start, amount_php, amount_usd, payee_type')
          .eq('status', 'paid')
          .in('cycle_period_start', starts)
          .order('id', { ascending: true })
          .range(from, to),
    );
    if (!dispatchError) {
      const byCycle = rollUpDispatchedByCycle(
        dispatchRows.map((d) => ({
          period_start: (d.cycle_period_start as string | null) ?? null,
          amount_php: numOrNull(d.amount_php),
          amount_usd: numOrNull(d.amount_usd),
          payee_type: (d.payee_type as string | null) ?? null,
        })),
      );
      for (const w of weeksOut) applyDispatchedTotals(w, byCycle.get(String(w.period_start ?? '')));
    }
  }

  return {
    field_notes:
      'paid_count / paid_usd / paid_php = what this cycle ACTUALLY SENT, read from the live payment dispatch log, ' +
      '**with PAB, Tech, KPI/department bonuses and Accounting adjustments included** — paid_source says so per week. ' +
      'If a week carries paid_php_warning instead, no dispatch rows exist for that cycle and its paid_php is the weekly ' +
      'records\' regular + OT total, which UNDERSTATES what was paid — quote it only with that caveat. ' +
      'outstanding_* = recipients still owed (no payment sent yet); **outstanding_usd and total_owed_usd are regular + OT ' +
      'only and do NOT include any bonus still to be paid**, so they understate what is owed. ' +
      'total_owed_usd = full cycle snapshot (paid + outstanding). Amounts in USD and PHP as labelled.',
    weeks: weeksOut,
    totals: {
      weeks_returned: weeksOut.length,
      total_paid_usd: round2(sumNullable(weeksOut.map((w) => w.paid_usd))),
      total_paid_php: round2(sumNullable(weeksOut.map((w) => w.paid_php))),
      total_outstanding_usd: round2(sumNullable(weeksOut.map((w) => w.outstanding_usd))),
    },
  };
}

/**
 * The N most recent distinct period-start values present in `rows`, newest
 * first. Used to scope an aggregation to "the last N pay weeks".
 */
function recentPeriods(rows: Array<Record<string, unknown>>, field: string, weeks: number): Set<string> {
  const distinct = [...new Set(rows.map((r) => String(r[field] ?? '')).filter(Boolean))];
  distinct.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return new Set(distinct.slice(0, weeks));
}

/** ISO date `days` before `iso` (yyyy-mm-dd). */
function isoDaysBefore(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

type SbClient = NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;

/**
 * Fetch EVERY row in a date range, paging past PostgREST's ~1000-row server cap
 * (a plain `.limit(8000)` is silently truncated to 1000, which would corrupt any
 * aggregate spanning more than one ~800-row payroll week). Orders by a stable
 * unique column so range pages don't overlap or skip.
 */
async function fetchAllByDateRange(
  supabase: SbClient,
  table: string,
  select: string,
  dateCol: string,
  gte: string,
  lte: string,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const PAGE = 1000;
  for (let from = 0; from <= 60000; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .gte(dateCol, gte)
      .lte(dateCol, lte)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as unknown as Array<Record<string, unknown>>;
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

async function getOvertimeLeaders(weeksRaw: unknown, limitRaw: unknown): Promise<ToolResult> {
  const weeks = clampInt(weeksRaw, 1, 12, 1);
  const limit = clampInt(limitRaw, 1, 25, 5);
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  // Find the latest pay week, then fetch a date window generous enough to hold
  // the most-recent N weeks (plus slack for gaps) — paged past the 1000-row cap.
  const { data: latestRows, error: lErr } = await supabase
    .from('disbursement_records')
    .select('cycle_period_start')
    .order('cycle_period_start', { ascending: false })
    .limit(1);
  if (lErr) return { error: lErr.message };
  const latest = (latestRows ?? [])[0]?.cycle_period_start as string | undefined;
  if (!latest) return { leaders: [], note: 'No payroll records found to rank overtime from.' };
  const cutoff = isoDaysBefore(latest, weeks * 7 + 7);

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await fetchAllByDateRange(
      supabase,
      'disbursement_records',
      'cycle_period_start, cycle_period_end, recipient_email, recipient_name, regular_hours, ot_hours, total_hours, amount_php, amount_usd, status, kind, source_file',
      'cycle_period_start',
      cutoff,
      latest,
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  // Keep only real weekly payroll rows (drop special transfers, urgent buckets,
  // and the Hubstaff grand-total phantom row).
  const clean = rows.filter((rec) => {
    if (rec.kind === 'special') return false;
    const sf = String(rec.source_file ?? '');
    if (sf.startsWith('urgent') || sf.startsWith('special')) return false;
    if (num(rec.total_hours) > MAX_PLAUSIBLE_WEEKLY_HOURS) return false;
    return !!rec.cycle_period_start;
  });

  if (clean.length === 0) {
    return { leaders: [], note: 'No payroll records found to rank overtime from.' };
  }

  const inScope = recentPeriods(clean, 'cycle_period_start', weeks);
  const scoped = clean.filter((r) => inScope.has(String(r.cycle_period_start)));

  // Aggregate OT per person across the scoped weeks. Rows arrive newest-first,
  // so the first time we see an email carries the most-recent name/department.
  const byPerson = new Map<
    string,
    {
      name: unknown;
      department: unknown;
      ot_hours: number;
      regular_hours: number;
      total_hours: number;
      amount_php: number;
      amount_usd: number;
      weeks: number;
    }
  >();
  for (const r of scoped) {
    const key = String(r.recipient_email ?? '').toLowerCase();
    if (!key) continue;
    let g = byPerson.get(key);
    if (!g) {
      g = {
        name: r.recipient_name ?? null,
        department: null,
        ot_hours: 0,
        regular_hours: 0,
        total_hours: 0,
        amount_php: 0,
        amount_usd: 0,
        weeks: 0,
      };
      byPerson.set(key, g);
    }
    g.ot_hours += num(r.ot_hours);
    g.regular_hours += num(r.regular_hours);
    g.total_hours += num(r.total_hours);
    g.amount_php += num(r.amount_php);
    g.amount_usd += num(r.amount_usd);
    g.weeks += 1;
  }

  const leaders = [...byPerson.entries()]
    .map(([email, g]) => ({
      name: g.name,
      work_email: email,
      department: g.department,
      ot_hours: round2(g.ot_hours),
      regular_hours: round2(g.regular_hours),
      total_hours: round2(g.total_hours),
      amount_php: round2(g.amount_php),
      amount_usd: round2(g.amount_usd),
      weeks_counted: g.weeks,
    }))
    .sort((a, b) => b.ot_hours - a.ot_hours)
    .slice(0, limit);

  // disbursement_records has no department column, so enrich the top names +
  // departments from the active roster (best-effort).
  try {
    const { employees } = await getEmployeesForAuthorizedServerRoute();
    const byEmail = new Map<string, { name: string | null; department: string | null }>();
    for (const e of employees) {
      for (const a of [e.work_email, e.personal_email]) {
        const n = (a ?? '').trim().toLowerCase();
        if (n) byEmail.set(n, { name: e.name ?? null, department: e.department ?? null });
      }
    }
    for (const ld of leaders) {
      const hit = byEmail.get(ld.work_email);
      if (hit) {
        ld.department = hit.department;
        if (hit.name) ld.name = hit.name;
      }
    }
  } catch {
    // roster enrichment is optional — leaders still carry name + OT figures
  }

  const starts = scoped.map((r) => String(r.cycle_period_start)).sort();
  const ends = scoped.map((r) => String(r.cycle_period_end ?? '')).filter(Boolean).sort();

  return {
    weeks_in_scope: inScope.size,
    period_start: starts[0] ?? null,
    period_end: ends[ends.length - 1] ?? null,
    field_notes:
      'ot_hours/regular_hours/total_hours are SUMMED over the period. amount_php/amount_usd = summed computed regular+OT pay (no bonuses). Ranked by total OT hours, highest first. period_start/period_end give the covered range for labelling the report.',
    leaders,
  };
}

async function getDepartmentBonuses(weeksRaw: unknown, limitRaw: unknown): Promise<ToolResult> {
  const weeks = clampInt(weeksRaw, 1, 26, 12);
  const limit = clampInt(limitRaw, 1, 25, 5);
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  const { data: latestRows, error: lErr } = await supabase
    .from('bonus_catalog_applied')
    .select('period_start')
    .order('period_start', { ascending: false })
    .limit(1);
  if (lErr) return { error: lErr.message };
  const latest = (latestRows ?? [])[0]?.period_start as string | undefined;
  if (!latest) return { departments: [], note: 'No applied Payment-Catalog bonuses found.' };
  const cutoff = isoDaysBefore(latest, weeks * 7 + 7);

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await fetchAllByDateRange(
      supabase,
      'bonus_catalog_applied',
      'department, period_start, period_end, employee_email, amount',
      'period_start',
      cutoff,
      latest,
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const clean = rows.filter((rec) => !!rec.period_start && !!rec.department);

  if (clean.length === 0) {
    return { departments: [], note: 'No applied Payment-Catalog bonuses found.' };
  }

  const inScope = recentPeriods(clean, 'period_start', weeks);
  const scoped = clean.filter((r) => inScope.has(String(r.period_start)));

  const byDept = new Map<
    string,
    { total: number; emails: Set<string>; bonusCount: number; periods: Set<string> }
  >();
  for (const r of scoped) {
    const key = String(r.department);
    let g = byDept.get(key);
    if (!g) {
      g = { total: 0, emails: new Set(), bonusCount: 0, periods: new Set() };
      byDept.set(key, g);
    }
    g.total += num(r.amount);
    if (r.employee_email) g.emails.add(String(r.employee_email).toLowerCase());
    g.bonusCount += 1;
    g.periods.add(String(r.period_start));
  }

  const departments = [...byDept.entries()]
    .map(([key, g]) => ({
      department: deptDisplay(key),
      total_bonus: round2(g.total),
      people_with_bonus: g.emails.size,
      bonus_count: g.bonusCount,
      weeks_with_bonus: g.periods.size,
    }))
    .sort((a, b) => b.total_bonus - a.total_bonus)
    .slice(0, limit);

  const starts = scoped.map((r) => String(r.period_start)).sort();
  const ends = scoped.map((r) => String(r.period_end ?? '')).filter(Boolean).sort();

  return {
    weeks_in_scope: inScope.size,
    period_start: starts[0] ?? null,
    period_end: ends[ends.length - 1] ?? null,
    field_notes:
      'total_bonus = sum of applied Payment-Catalog bonus amounts for the department over the period (stored amounts, mostly PHP; cross-currency totals are approximate). Ranked highest first.',
    departments,
  };
}

/** Month bounds as ISO date strings (lexicographically comparable). m is 1–12. */
function monthBounds(y: number, m: number): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay)}` };
}

type FinAgg = {
  paid_php: number;
  paid_usd: number;
  outstanding_usd: number;
  regular_hours: number;
  ot_hours: number;
  recipients: Set<string>;
  paid_recipients: Set<string>;
};

function emptyFinAgg(): FinAgg {
  return {
    paid_php: 0,
    paid_usd: 0,
    outstanding_usd: 0,
    regular_hours: 0,
    ot_hours: 0,
    recipients: new Set(),
    paid_recipients: new Set(),
  };
}

function addToFinAgg(agg: FinAgg, r: Record<string, unknown>): void {
  const email = String(r.recipient_email ?? '').toLowerCase();
  const aPhp = num(r.amount_php);
  const aUsd = num(r.amount_usd);
  const pUsd = num(r.paid_amount_usd) || aUsd;
  agg.regular_hours += num(r.regular_hours);
  agg.ot_hours += num(r.ot_hours);
  if (email) agg.recipients.add(email);
  if (r.status === 'paid') {
    agg.paid_php += aPhp;
    agg.paid_usd += pUsd;
    if (email) agg.paid_recipients.add(email);
  } else {
    agg.outstanding_usd += aUsd;
  }
}

async function getFinancialSummary(monthRaw: unknown): Promise<ToolResult> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  // Resolve the target month ("YYYY-MM"); default to the latest month on record.
  let month = typeof monthRaw === 'string' && /^\d{4}-\d{2}$/.test(monthRaw.trim())
    ? monthRaw.trim()
    : '';
  if (!month) {
    const { data: latest } = await supabase
      .from('disbursement_records')
      .select('cycle_period_start')
      .order('cycle_period_start', { ascending: false })
      .limit(1);
    const top = (latest ?? [])[0] as { cycle_period_start?: string } | undefined;
    month = (top?.cycle_period_start ?? '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'No payroll data found to summarize.' };
  }

  const [yStr, mStr] = month.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const cur = monthBounds(y, m);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prev = monthBounds(prevY, prevM);

  // Pull this month + the prior month (assign a cycle to the month its period
  // STARTS in). Paged past the 1000-row cap — a month is several ~800-row weeks,
  // so a capped query would silently drop most of it. String comparison is valid
  // on ISO dates.
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await fetchAllByDateRange(
      supabase,
      'disbursement_records',
      'cycle_period_start, cycle_period_end, recipient_email, regular_hours, ot_hours, total_hours, amount_php, amount_usd, paid_amount_usd, status, kind, source_file',
      'cycle_period_start',
      prev.start,
      cur.end,
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const clean = rows.filter((rec) => {
    if (rec.kind === 'special') return false;
    const sf = String(rec.source_file ?? '');
    if (sf.startsWith('urgent') || sf.startsWith('special')) return false;
    if (num(rec.total_hours) > MAX_PLAUSIBLE_WEEKLY_HOURS) return false;
    return !!rec.cycle_period_start;
  });

  const monthAgg = emptyFinAgg();
  const priorAgg = emptyFinAgg();
  const byWeek = new Map<string, { period_start: string; period_end: string; agg: FinAgg }>();

  for (const r of clean) {
    const start = String(r.cycle_period_start);
    if (start >= cur.start && start <= cur.end) {
      addToFinAgg(monthAgg, r);
      const key = String(r.source_file ?? start);
      let wk = byWeek.get(key);
      if (!wk) {
        wk = { period_start: start, period_end: String(r.cycle_period_end ?? ''), agg: emptyFinAgg() };
        byWeek.set(key, wk);
      }
      addToFinAgg(wk.agg, r);
    } else if (start >= prev.start && start <= prev.end) {
      addToFinAgg(priorAgg, r);
    }
  }

  const weeks = [...byWeek.values()]
    .sort((a, b) => (a.period_start < b.period_start ? -1 : 1))
    .map((wk) => ({
      period_start: wk.period_start,
      period_end: wk.period_end,
      paid_recipients: wk.agg.paid_recipients.size,
      paid_php: round2(wk.agg.paid_php),
      paid_usd: round2(wk.agg.paid_usd),
      outstanding_usd: round2(wk.agg.outstanding_usd),
      regular_hours: round2(wk.agg.regular_hours),
      ot_hours: round2(wk.agg.ot_hours),
    }));

  const pct = (curV: number, prevV: number): number | null =>
    prevV > 0 ? round2(((curV - prevV) / prevV) * 100) : null;

  if (monthAgg.recipients.size === 0 && weeks.length === 0) {
    return { month, note: `No payroll records found for ${month}.` };
  }

  return {
    month,
    period: { start: cur.start, end: cur.end },
    totals: {
      paid_php: round2(monthAgg.paid_php),
      paid_usd: round2(monthAgg.paid_usd),
      outstanding_usd: round2(monthAgg.outstanding_usd),
      paid_recipients: monthAgg.paid_recipients.size,
      total_recipients: monthAgg.recipients.size,
      regular_hours: round2(monthAgg.regular_hours),
      ot_hours: round2(monthAgg.ot_hours),
    },
    weeks,
    prior_month: {
      month: `${prevY}-${String(prevM).padStart(2, '0')}`,
      paid_php: round2(priorAgg.paid_php),
      paid_usd: round2(priorAgg.paid_usd),
      ot_hours: round2(priorAgg.ot_hours),
    },
    trend: {
      paid_php_change_pct: pct(monthAgg.paid_php, priorAgg.paid_php),
      paid_usd_change_pct: pct(monthAgg.paid_usd, priorAgg.paid_usd),
      ot_hours_change_pct: pct(monthAgg.ot_hours, priorAgg.ot_hours),
    },
    field_notes:
      'Company payroll for the calendar month (a weekly cycle is counted in the month its period STARTS in). paid_* = disbursed; outstanding_usd = owed but not yet paid. Some recent weeks may show 0 paid amounts if those cycles were marked paid without being costed (a known data gap). prior_month + trend.*_change_pct are for writing the Insight. Money: ₱ for PHP, $ for USD, 2 decimals.',
  };
}

async function getEmployeeProfile(workEmailInput: string): Promise<ToolResult> {
  const email = normEmail(workEmailInput);
  if (!email || !isSafeEmail(email)) return { error: 'Missing or invalid work_email.' };

  // Identity + address come from the HR master record.
  const { employee, error: masterErr } = await getEmployeeMasterRecord(email);

  const aliases = new Set<string>([email]);
  for (const a of [
    employee?.work_email,
    employee?.personal_email,
    employee?.alternate_work_email,
    employee?.alternate_work_email_2,
  ]) {
    const n = normEmail(a ?? '');
    if (n && isSafeEmail(n)) aliases.add(n);
  }

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  // Hourly rates (PHP) — match on any known address.
  let regularRate: number | null = null;
  let otRate: number | null = null;
  {
    const orFilter = [...aliases]
      .flatMap((a) => [`work_email.ilike.${a}`, `personal_email.ilike.${a}`])
      .join(',');
    const { data } = await supabase
      .from('employee_hourly_rates')
      .select('regular_rate, ot_rate, work_email, personal_email')
      .or(orFilter)
      .limit(1);
    const r = (data ?? [])[0] as Record<string, unknown> | undefined;
    if (r) {
      regularRate = numOrNull(r.regular_rate);
      otRate = numOrNull(r.ot_rate);
    }
  }

  // Self-entered skill sets (keyed on work_email).
  let skillSet: ToolResult | null = null;
  try {
    const wEmail = normEmail(employee?.work_email ?? '') || email;
    const { row: ss } = await getSkillSet(wEmail);
    if (ss && (ss.role_title || ss.skills || ss.strengths || ss.projects?.length)) {
      skillSet = {
        role_title: ss.role_title || null,
        skills: ss.skills || null,
        strengths: ss.strengths || null,
        currently_working_on: ss.currently_working_on || null,
        projects: ss.projects ?? [],
        current_projects: ss.current_projects ?? [],
      };
    }
  } catch {
    // skill sets are optional — ignore lookup failures
  }

  // Recognition AND concerns. Managers award two kinds of medal: `commend`
  // (green flag, positive) and `flag` (red flag / "flag for review", a concern).
  // We surface BOTH so the assistant can give the CEO a fair, balanced read of a
  // person instead of only their praise. Commendations are shown publicly, so we
  // keep them public-only (mirrors the employee's own Profile tab). Flags are
  // managers' private review notes — invisible to the employee — but the CEO is
  // exactly who should see them, so we include private flags here.
  let commendationCount = 0;
  let recentCommendations: string[] = [];
  let flagCount = 0;
  let recentFlags: string[] = [];
  {
    const { data } = await supabase
      .from('employee_medals')
      .select('medal_type, note, is_private, awarded_at')
      .in('employee_email', [...aliases])
      .in('medal_type', ['commend', 'flag'])
      .order('awarded_at', { ascending: false })
      .limit(100);
    const rows = (data ?? []) as Array<Record<string, unknown>>;

    const commends = rows.filter((r) => r.medal_type === 'commend' && r.is_private === false);
    commendationCount = commends.length;
    recentCommendations = commends
      .slice(0, 3)
      .map((r) => String(r.note ?? '').trim())
      .filter(Boolean);

    const flags = rows.filter((r) => r.medal_type === 'flag');
    flagCount = flags.length;
    recentFlags = flags
      .slice(0, 3)
      .map((r) => String(r.note ?? '').trim())
      .filter(Boolean);
  }

  const photoUrl = await getProfilePhotoUrlForEmail(email);

  if (!employee && regularRate == null && !skillSet && commendationCount === 0 && flagCount === 0) {
    return { error: masterErr || 'No profile found for this email.' };
  }

  const address =
    employee?.full_address ||
    [employee?.street, employee?.city, employee?.province, employee?.postal_code]
      .filter(Boolean)
      .join(', ') ||
    null;

  return {
    work_email: employee?.work_email ?? email,
    name: employee?.name ?? null,
    personal_email: employee?.personal_email ?? null,
    department: employee?.department ?? null,
    employee_id: employee?.employee_id ?? null,
    start_date: employee?.start_date ?? null,
    address,
    has_profile_photo: !!photoUrl,
    compensation: { regular_rate_php: regularRate, ot_rate_php: otRate },
    skill_set: skillSet,
    recognition: { commendation_count: commendationCount, recent_notes: recentCommendations },
    concerns: { flag_count: flagCount, recent_notes: recentFlags },
    field_notes:
      "Identity + home address (HR master), hourly rates in PHP, self-entered skill sets. recognition = PUBLIC commendations (green flags) the employee can see; these are opt-in praise, so few or none does NOT mean poor performance. concerns = manager 'flag for review' notes (red flags) — PRIVATE, the employee cannot see them, shown to the CEO only; they are concerns raised for review, not proven verdicts, so weigh them as one signal. For a fair read of a person, consider BOTH recognition and concerns (and their actual hours/pay) — do not present only the positives. Bank/payout details are intentionally excluded. has_profile_photo = true means a roster section will render their uploaded/Google avatar.",
  };
}

/**
 * "How much access does <email> have?" — aggregates the three authorization
 * layers into one read-only picture:
 *   1. roles (employee_roles)            → which staff dashboards open
 *   2. feature permissions (overlay)     → per-tab hidden/view/edit
 *   3. department_managers               → which teams a manager oversees
 * plus the derived admin / elevated / rate-visibility flags. Mirrors the same
 * role + email-alias logic the live RBAC checks use, so it reflects reality.
 */
async function getEmployeeAccess(workEmailInput: string): Promise<ToolResult> {
  const email = normEmail(workEmailInput);
  if (!email || !isSafeEmail(email)) return { error: 'Missing or invalid work_email.' };

  // Identity + any alternate emails this person may be keyed under.
  const { employee } = await getEmployeeMasterRecord(email);
  const aliases = new Set<string>([email]);
  for (const a of [
    employee?.work_email,
    employee?.personal_email,
    employee?.alternate_work_email,
    employee?.alternate_work_email_2,
  ]) {
    const n = normEmail(a ?? '');
    if (n && isSafeEmail(n)) aliases.add(n);
  }

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { error: 'Database is not reachable.' };

  // (1) Active roles across all of this person's emails.
  const orFilter = [...aliases].map((a) => `work_email.ilike.${a}`).join(',');
  const { data: roleRows, error: roleErr } = await supabase
    .from('employee_roles')
    .select('role')
    .or(orFilter)
    .is('revoked_at', null);
  if (roleErr) return { error: roleErr.message };
  const roles = [...new Set((roleRows ?? []).map((r) => String((r as { role: string }).role)))];

  const isAdmin = roles.includes('admin');
  const elevated = hasElevatedRole(roles);
  const rateVisible = hasRateVisibility(roles);

  // (2) Departments this person manages (only meaningful for a manager).
  const deptSet = new Set<string>();
  for (const a of aliases) {
    const { rows } = await listDepartmentsForManager(a);
    for (const r of rows) deptSet.add(r.department);
  }
  const managedDepartments = [...deptSet];

  // (3) Privileged dashboards their roles can open. Everyone also has their own
  //     /employee self-service portal, which is not role-gated.
  const DASHBOARD_LABELS: Record<string, string> = {
    '/admin': 'Admin',
    '/ceo': 'CEO',
    '/accounting': 'Accounting',
    '/payroll-clerk': 'Payroll Clerk',
    '/hr': 'HR',
    '/orphanage': 'Orphanage',
    '/manager': 'Manager',
  };
  const dashboards = ROUTE_REQUIRED_ROLES.filter((r) =>
    r.roles.some((role) => roles.includes(role)),
  ).map((r) => DASHBOARD_LABELS[r.prefix] ?? r.prefix);

  // (4) Per-tab feature-permission overlay (hidden/view/edit) on top of roles.
  const perms: FeaturePermissionsMap = {};
  for (const a of aliases) {
    const m = await fetchFeaturePermissionsForEmail(a);
    for (const [view, tabs] of Object.entries(m)) {
      const v = view as FeatureViewKey;
      perms[v] = { ...(perms[v] ?? {}), ...(tabs ?? {}) };
    }
  }

  // Report the views behind this person's roles, any view they hold explicit
  // grants in, and — for an admin — every view (admins bypass tab gating).
  const views = new Set<FeatureViewKey>();
  for (const role of roles) {
    const v = ROLE_TO_FEATURE_VIEW[role];
    if (v) views.add(v);
  }
  for (const v of Object.keys(perms)) views.add(v as FeatureViewKey);
  if (isAdmin) for (const v of Object.keys(FEATURE_CATALOG)) views.add(v as FeatureViewKey);

  const featurePermissions: Record<string, Record<string, string>> = {};
  for (const v of views) {
    const catalog = FEATURE_CATALOG[v];
    if (!catalog) continue;
    const tabs: Record<string, string> = {};
    for (const t of catalog) {
      tabs[t.label] = isAdmin ? 'edit (admin bypass)' : resolveFeatureAccess(perms, v, t.key);
    }
    featurePermissions[v] = tabs;
  }

  const accessLevel = isAdmin
    ? 'Administrator — full access to every dashboard and tab (bypasses all permission gating).'
    : roles.length > 0
      ? `Staff member with role(s): ${roles.join(', ')}.`
      : 'Regular employee — only their own self-service portal (Time Adjustments, pay, leave/requests). No staff dashboards.';

  return {
    work_email: employee?.work_email ?? email,
    name: employee?.name ?? null,
    department: employee?.department ?? null,
    found_in_roster: !!employee,
    access_level: accessLevel,
    is_admin: isAdmin,
    is_elevated: elevated,
    can_see_pay_rates: rateVisible,
    roles,
    dashboards_can_open: dashboards,
    managed_departments: managedDepartments,
    feature_permissions: featurePermissions,
    field_notes:
      "ACCESS MODEL — three layers. (1) roles (from employee_roles) decide which staff DASHBOARDS a person can open (see dashboards_can_open); no role = a regular employee who only sees their own /employee self-service portal. (2) feature_permissions is a per-TAB overlay on top of the role: each tab is 'hidden' (not visible at all — the default for any tab without an explicit grant), 'view' (read-only), or 'edit' (can change things). (3) admin holds the keys to the castle: is_admin=true means every tab in every dashboard is effectively edit regardless of grants (shown as 'edit (admin bypass)'). is_elevated=true means they may view/act on OTHER employees' data (admin, accounting, hr_coordinator). can_see_pay_rates=true means they're allowed to see numeric pay rates (admin, accounting, ceo — NOT hr_coordinator). managed_departments lists the teams a manager oversees. This describes what the person CAN access, not what they have done.",
  };
}

/** The `YYYY-MM-DD_to_YYYY-MM-DD` block every wizard batch filename carries
 *  (manual CSV exports and API syncs alike) — parsed as plain strings so no
 *  timezone math can shift a day. */
function periodDatesFromSourceFile(
  file: string | null | undefined,
): { start: string | null; end: string | null } {
  const m = /(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(file ?? '');
  return { start: m?.[1] ?? null, end: m?.[2] ?? null };
}

async function getHoursUploads(limitRaw: unknown): Promise<ToolResult> {
  const limit = clampInt(limitRaw, 1, 26, 8);
  const uploads = await listHubstaffUploads();
  if (uploads.length === 0) {
    return { uploads: [], note: 'No hours batches have been uploaded through the Payroll Wizard yet.' };
  }

  const shown = uploads.slice(0, limit).map((u) => {
    const { start, end } = periodDatesFromSourceFile(u.source_file);
    return {
      source_file: u.source_file,
      period: periodLabelFromFilename(u.source_file),
      period_start: start,
      period_end: end,
      uploaded_at: u.uploaded_at,
      uploaded_by: u.uploaded_by,
      row_count: u.row_count,
      is_current: u.is_current,
    };
  });

  return {
    uploads_returned: shown.length,
    total_uploads: uploads.length,
    field_notes:
      'One entry per weekly hours batch uploaded through the Payroll Wizard, newest first. is_current = the batch the wizard is working from right now. period_start/period_end come from the filename\'s date block; uploaded_at is when it was loaded into the system (may be days after the period ended). Pass source_file to get_uploaded_hours to read the hours inside a batch.',
    uploads: shown,
  };
}

async function getUploadedHours(
  sourceFileRaw: unknown,
  workEmailRaw: unknown,
  limitRaw: unknown,
): Promise<ToolResult> {
  const limit = clampInt(limitRaw, 1, 25, 10);
  const sourceFile = typeof sourceFileRaw === 'string' ? sourceFileRaw.trim() : '';

  const { rows } = sourceFile
    ? await fetchHubstaffRowsBySourceFile(sourceFile)
    : await fetchHubstaffRowsOrdered();

  if (rows.length === 0) {
    return {
      note: sourceFile
        ? `No uploaded hours found for batch "${sourceFile}". Check the exact source_file via get_hours_uploads.`
        : 'No current hours batch found — the Payroll Wizard may not have this week\'s upload yet. Check get_hours_uploads.',
    };
  }

  const batchFile = sourceFile || String(rows[0]?.source_file ?? '') || null;
  const period = periodLabelFromFilename(batchFile);

  // Drop the Hubstaff grand-total phantom row before any aggregation.
  const people = rowsToPayrollRows(rows).filter(
    (r) => r.hoursDecimal <= MAX_PLAUSIBLE_WEEKLY_HOURS,
  );

  const batch = { source_file: batchFile, period, is_current_batch: !sourceFile };

  // One person's hours — match on any of their known email aliases, since a
  // Hubstaff row may be keyed on a work alias or the personal email.
  const workEmail = normEmail(str(workEmailRaw));
  if (workEmail) {
    if (!isSafeEmail(workEmail)) return { error: 'Invalid work_email.' };
    const aliases = new Set<string>([workEmail]);
    try {
      const { employee } = await getEmployeeMasterRecord(workEmail);
      for (const a of [
        employee?.work_email,
        employee?.personal_email,
        employee?.alternate_work_email,
        employee?.alternate_work_email_2,
      ]) {
        const n = normEmail(a ?? '');
        if (n) aliases.add(n);
      }
    } catch {
      // fall back to just the input email
    }
    const mine = people.filter((r) => {
      const n = normEmail(r.email ?? '');
      return !!n && aliases.has(n);
    });
    if (mine.length === 0) {
      return {
        ...batch,
        work_email: workEmail,
        note: 'This person has no row in this hours batch — they may not have tracked time that week, or their hours land under an email not on their record.',
      };
    }
    return {
      ...batch,
      work_email: workEmail,
      field_notes:
        'Raw hours from the uploaded batch, BEFORE rates and bonuses. hours = total worked (includes overtime); ot_hours = the overtime portion. For what this became in pay, use get_employee_pay.',
      entries: mine.map((r) => ({
        name: r.name,
        email: r.email,
        department: r.department,
        hours: round2(r.hoursDecimal),
        ot_hours: round2(r.overtimeDecimal),
      })),
      totals: {
        hours: round2(mine.reduce((s, r) => s + r.hoursDecimal, 0)),
        ot_hours: round2(mine.reduce((s, r) => s + r.overtimeDecimal, 0)),
      },
    };
  }

  // Company view — summary plus the top people by hours.
  const withEmail = people.filter((r) => !!normEmail(r.email ?? ''));
  const top = [...people]
    .sort((a, b) => b.hoursDecimal - a.hoursDecimal)
    .slice(0, limit)
    .map((r) => ({
      name: r.name,
      email: r.email,
      department: r.department,
      hours: round2(r.hoursDecimal),
      ot_hours: round2(r.overtimeDecimal),
    }));

  return {
    ...batch,
    field_notes:
      'Raw hours from the uploaded batch, BEFORE rates and bonuses (money lives in get_payroll_report / get_employee_pay). hours = total worked (includes overtime); ot_hours = the overtime portion. top_by_hours is ranked by total hours, highest first.',
    totals: {
      people: new Set(withEmail.map((r) => normEmail(r.email ?? ''))).size || people.length,
      rows: people.length,
      hours: round2(people.reduce((s, r) => s + r.hoursDecimal, 0)),
      ot_hours: round2(people.reduce((s, r) => s + r.overtimeDecimal, 0)),
    },
    top_by_hours: top,
  };
}

async function getPayrollWizardNotes(includeDoneRaw: unknown): Promise<ToolResult> {
  const includeDone = includeDoneRaw === true;
  const { rows, error } = await listPayrollWizardNotes();
  if (error) return { error };

  // The board keeps blank seeded lines waiting for each clerk — skip those.
  const blank = (v: string | null) => !(v ?? '').trim();
  const real = rows.filter(
    (r) => r.done || !blank(r.note_date) || !blank(r.worker) || !blank(r.adjustment) || !blank(r.notes),
  );

  const openCount = real.filter((r) => !r.done).length;
  const shown = real
    .filter((r) => includeDone || !r.done)
    .slice(0, 200)
    .map((r) => ({
      payroll_clerk: r.payroll_clerk,
      note_date: r.note_date,
      week_of: r.week_start,
      worker: r.worker,
      adjustment: r.adjustment,
      notes: r.notes,
      done: r.done,
    }));

  return {
    open_count: openCount,
    done_count: real.length - openCount,
    showing: includeDone ? 'open + done items' : 'open items only',
    field_notes:
      'The Payroll Wizard\'s carry-over notes board — free-form items payroll clerks stage for a following week (missed bonuses, rate changes, deductions). payroll_clerk = who wrote it; week_of = Sunday of the pay period the note belongs to (the just-completed Sunday–Saturday week being paid; payroll runs a week in arrears); worker = who it is about (free text); adjustment = the pay change called for (free text, e.g. "+₱500", "-$25"); done = already applied in a later run. These are working notes, not final records — verify money figures against the pay tools before quoting them.',
    notes: shown,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Basic email shape, excluding characters that are meaningful in a
 *  PostgREST or() filter (comma, parens, quotes, whitespace). */
function isSafeEmail(s: string): boolean {
  return /^[^\s@,()"']+@[^\s@,()"']+\.[^\s@,()"']+$/.test(s);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function numOrNull(v: unknown): number | null {
  // null/undefined in the DB → null; everything else (including a legitimate
  // 0 or "0.00") parses to its numeric value. Do NOT special-case zero.
  if (v == null) return null;
  return num(v);
}

function sumNullable(xs: Array<number | null>): number {
  return xs.reduce<number>((acc, x) => acc + (x ?? 0), 0);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
