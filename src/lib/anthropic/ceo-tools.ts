import 'server-only';

import type Anthropic from '@anthropic-ai/sdk';
import { normEmail } from '@/lib/email/norm-email';
import {
  getEmployeesForAuthorizedServerRoute,
  getEmployeeMasterRecord,
} from '@/lib/supabase/employees';
import {
  createSupabaseServiceRoleClient,
  createSupabaseServerClient,
} from '@/lib/supabase/server';
import { listDisbursementReports } from '@/lib/payroll/disbursement-reports';

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
      "Resolve a person's name or email to their employee record(s). ALWAYS call this first whenever the user names a person (e.g. \"Kane\", \"kane@simple.biz\") — you need the exact work_email it returns before you can look up their pay. Returns 0, 1, or several matches. If several match, ask the user which one (by department or work email) before continuing; never guess.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A name, partial name, or email address to search the active employee roster for.',
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
          description: 'How many recent pay weeks to return (1–12). Default 1 (the latest pay).',
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
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function findEmployee(query: string): Promise<ToolResult> {
  const q = query.trim().toLowerCase();
  if (!q) return { error: 'Empty search query.' };

  const { employees, error } = await getEmployeesForAuthorizedServerRoute();
  if (error) return { error };

  const isEmail = q.includes('@');
  const matches = employees.filter((e) => {
    const name = (e.name ?? '').toLowerCase();
    const we = (e.work_email ?? '').toLowerCase();
    const pe = (e.personal_email ?? '').toLowerCase();
    if (isEmail) return we === q || pe === q;
    const local = we.split('@')[0] ?? '';
    return name.includes(q) || local.includes(q);
  });

  const shown = matches.slice(0, 8).map((e) => ({
    name: e.name,
    work_email: e.work_email ?? null,
    department: e.department,
    employee_id: e.employee_id,
  }));

  return {
    match_count: matches.length,
    matches: shown,
    truncated: matches.length > shown.length,
    note:
      matches.length === 0
        ? 'No active employee matched. Try a different spelling, or ask the user for their work email.'
        : matches.length > 1
          ? 'Multiple matches — ask the user which person (department or work email) before looking up pay.'
          : undefined,
  };
}

async function getEmployeePay(workEmail: string, weeksRaw: unknown): Promise<ToolResult> {
  const email = normEmail(workEmail);
  // Shape-guard: the value flows into a PostgREST or() filter, so reject
  // anything with commas/parens/quotes/whitespace that could malform the query.
  if (!email || !isSafeEmail(email)) return { error: 'Missing or invalid work_email.' };
  const weeks = clampInt(weeksRaw, 1, 12, 1);

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
  const { data, error } = await supabase
    .from('disbursement_records')
    .select(
      'cycle_period_start, cycle_period_end, recipient_name, total_hours, regular_hours, ot_hours, amount_php, amount_usd, status, paid_amount_usd, paid_at',
    )
    .or(orFilter)
    .order('cycle_period_start', { ascending: false })
    .limit(weeks);

  if (error) return { error: error.message };

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    return {
      work_email: email,
      weeks: [],
      note: 'No payroll disbursement records found for this employee. They may be a new hire, on a non-payroll arrangement, or paid outside this system.',
    };
  }

  const entries = rows.map((r) => ({
    period_start: r.cycle_period_start,
    period_end: r.cycle_period_end,
    total_hours: num(r.total_hours),
    regular_hours: num(r.regular_hours),
    ot_hours: num(r.ot_hours),
    amount_php: numOrNull(r.amount_php),
    amount_usd: numOrNull(r.amount_usd),
    status: r.status,
    paid_amount_usd: numOrNull(r.paid_amount_usd),
    paid_at: r.paid_at,
  }));

  return {
    work_email: email,
    recipient_name: rows[0].recipient_name ?? null,
    currency: 'amounts are in PHP (amount_php) and USD (amount_usd / paid_amount_usd)',
    field_notes:
      'amount_php / amount_usd = computed regular + OT pay for that week (does NOT include PAB/Tech bonuses). paid_amount_usd = the amount actually disbursed, set only when status="paid" (this is what was really sent, and includes any bonuses). status: paid = sent; pending = owed but not yet sent; not_paid/threshold/problem = held.',
    weeks: entries,
    totals: {
      weeks_returned: entries.length,
      sum_amount_php: round2(sumNullable(entries.map((e) => e.amount_php))),
      sum_amount_usd: round2(sumNullable(entries.map((e) => e.amount_usd))),
      sum_paid_usd: round2(sumNullable(entries.map((e) => e.paid_amount_usd))),
    },
  };
}

async function getPayrollReport(weeksRaw: unknown): Promise<ToolResult> {
  const weeks = clampInt(weeksRaw, 1, 12, 4);
  const { reports, error } = await listDisbursementReports();
  if (error) return { error };

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

  return {
    field_notes:
      'paid_* = already disbursed this week. outstanding_* = recipients still owed (no payment sent yet). total_owed_usd = full cycle snapshot (paid + outstanding). Amounts in USD and PHP as labelled.',
    weeks: weeksOut,
    totals: {
      weeks_returned: weeksOut.length,
      total_paid_usd: round2(sumNullable(weeksOut.map((w) => w.paid_usd))),
      total_paid_php: round2(sumNullable(weeksOut.map((w) => w.paid_php))),
      total_outstanding_usd: round2(sumNullable(weeksOut.map((w) => w.outstanding_usd))),
    },
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
