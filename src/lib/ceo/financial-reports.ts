import 'server-only';

import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from '@/lib/supabase/server';
import { listHubstaffUploads } from '@/lib/supabase/hubstaff-hours-db';
import { formatDisbursementReportName } from '@/lib/payroll/disbursement-reports';
import { normEmail } from '@/lib/email/norm-email';
import { applyDeptOverrideToRawRow } from '@/lib/departments/dept-email-overrides';

/**
 * Executive "Financial Reports" data layer — the company's payout history over
 * time, read from the flat `disbursement_records` table (one row per
 * (pay-week, recipient)). Each Hubstaff weekly upload that has been seeded into
 * `disbursement_records` becomes one point on the timeline; summing the computed
 * pay across every recipient in a cycle gives that week's total payroll cost,
 * and the running total is the company's cumulative spend on the people it pays.
 *
 * This is the CEO's growth lens: today it is PAYOUTS (what we pay our people);
 * revenue can be layered on later without changing this contract.
 *
 * Design choices (documented so they don't silently drift):
 *   - "payout" = the FULL cycle payroll cost: Σ amount across ALL recipients in
 *     the cycle regardless of dispatch status. This is the stable growth signal —
 *     it does not shrink just because a recent week hasn't been fully dispatched
 *     yet. `paid` / `outstanding` are surfaced separately as a progress view.
 *   - PHP is the primary currency (the ledger currency); USD is the ≈ companion,
 *     mirroring the rest of the app.
 *   - Urgent (MESA / orphanage-budget) weeks are NOT in `disbursement_records`,
 *     so they are intentionally excluded — this is regular weekly payroll only.
 */

/** Columns we actually read from `disbursement_records` (keeps the scan lean). */
interface DisbRow {
  source_file: string | null;
  cycle_period_start: string | null;
  cycle_period_end: string | null;
  recipient_email: string | null;
  total_hours: number | string | null;
  amount_php: number | string | null;
  amount_usd: number | string | null;
  paid_amount_usd: number | string | null;
  status: string | null;
}

/** Per-department slice of a single pay period. */
export interface FinancialDeptSlice {
  department: string;
  peopleCount: number;
  payoutPhp: number;
  payoutUsd: number;
  hours: number;
}

/** One point on the payout timeline (one pay week / CSV cycle). */
export interface FinancialPeriodPoint {
  /** The Hubstaff CSV that anchors this cycle — the selector's stable key. */
  sourceFile: string;
  /** "April 12-18, 2026" */
  reportName: string;
  /** ISO YYYY-MM-DD. */
  periodStart: string | null;
  periodEnd: string | null;
  /** True for the cycle currently being paid (the live `is_current` upload). */
  isCurrent: boolean;

  /** Full cycle payroll cost — Σ over every recipient, all statuses. */
  payoutPhp: number;
  payoutUsd: number;

  /** Already dispatched + marked paid. */
  paidPhp: number;
  paidUsd: number;
  paidCount: number;
  /** Owed but not yet paid (payout − paid). */
  outstandingPhp: number;
  outstandingUsd: number;

  /** Distinct recipients in this cycle. */
  peopleCount: number;
  /** Σ total worked hours across the cycle. */
  totalHours: number;
  /** payoutPhp / peopleCount (0 when nobody). */
  avgPerHeadPhp: number;
  avgHoursPerHead: number;

  /** Running total oldest → this period (the "growth" curve). */
  cumulativePayoutPhp: number;
  cumulativePayoutUsd: number;

  /** Period-over-period % change vs the previous cycle. Null for the first. */
  payoutDeltaPct: number | null;
  peopleDeltaPct: number | null;

  /** Headcount + spend split by department, largest payout first. */
  byDepartment: FinancialDeptSlice[];
}

export interface FinancialReports {
  /** Chronological, OLDEST first (so the chart reads left → right in time). */
  periods: FinancialPeriodPoint[];
  allTime: {
    totalPayoutPhp: number;
    totalPayoutUsd: number;
    /** Distinct people ever paid across all cycles. */
    distinctPeople: number;
    periodCount: number;
    /** Mean payout per cycle (PHP). */
    avgPeriodPayoutPhp: number;
    firstPeriod: string | null;
    lastPeriod: string | null;
    /** % change of the most recent full period vs the one before it. */
    latestPayoutDeltaPct: number | null;
  };
  error: string | null;
}

/** One recipient in a single period's detail table. */
export interface FinancialPeriodRecipient {
  email: string;
  name: string | null;
  department: string;
  hours: number;
  payoutPhp: number;
  payoutUsd: number;
  status: string;
}

function num(v: number | string | null | undefined): number {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** % change from `prev` → `curr`, null when there's no meaningful baseline. */
function pctDelta(prev: number, curr: number): number | null {
  if (!(prev > 0)) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10; // 1 decimal place
}

/** Skip non-weekly artifacts that should never have seeded a cycle but might
 *  linger as stray rows (backfills, the multi-week export, "(2)" re-uploads,
 *  urgent buckets). Mirrors `isSeedableWeeklyUpload` in disbursement-reports.ts. */
function isRegularWeeklyCycle(sourceFile: string): boolean {
  return !/backfill|time-activity|\(\d+\)|copy|^urgent_/i.test(sourceFile);
}

type Supabase = NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;

/** Page through every `disbursement_records` row (PostgREST caps a select at
 *  1000), selecting only the columns the timeline needs. */
async function loadAllRecords(supabase: Supabase): Promise<DisbRow[]> {
  const PAGE = 1000;
  const out: DisbRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('disbursement_records')
      .select(
        'source_file, cycle_period_start, cycle_period_end, recipient_email, total_hours, amount_php, amount_usd, paid_amount_usd, status',
      )
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as DisbRow[];
    out.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/** email → department, from the active-employees master view (work + personal
 *  email keys). Recipients not found bucket as "Unassigned". */
async function loadDeptByEmail(supabase: Supabase): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('active_employees')
      .select('"Work Email", "Personal Email", "Department"')
      .range(from, from + PAGE - 1);
    if (error || !data) break;
    for (const raw of data as Array<Record<string, unknown>>) {
      // Effective department (Sales/Sales-Assistant email split).
      const r = applyDeptOverrideToRawRow(raw);
      const dept = String(r.Department ?? '').trim();
      if (!dept) continue;
      const we = normEmail(r['Work Email'] as string | null);
      const pe = normEmail(r['Personal Email'] as string | null);
      if (we && !out.has(we)) out.set(we, dept);
      if (pe && !out.has(pe)) out.set(pe, dept);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/** Which cycle is "current" (live, being paid). Best-effort — an unavailable
 *  uploads list just leaves every point non-current. */
async function currentSourceFile(): Promise<string | null> {
  try {
    const uploads = await listHubstaffUploads();
    return uploads.find((u) => u.is_current && u.source_file)?.source_file ?? null;
  } catch {
    return null;
  }
}

/** Internal accumulator for one cycle bucket. */
interface Bucket {
  sourceFile: string;
  periodStart: string | null;
  periodEnd: string | null;
  payoutPhp: number;
  payoutUsd: number;
  paidPhp: number;
  paidUsd: number;
  paidCount: number;
  totalHours: number;
  people: Set<string>;
  dept: Map<string, { people: Set<string>; payoutPhp: number; payoutUsd: number; hours: number }>;
}

/**
 * Build the full payout timeline: one point per seeded weekly cycle, sorted
 * oldest → newest, with cumulative totals, period-over-period deltas, and a
 * per-department split. Powers the CEO Financial Reports tab.
 */
export async function buildFinancialReports(): Promise<FinancialReports> {
  const empty: FinancialReports = {
    periods: [],
    allTime: {
      totalPayoutPhp: 0,
      totalPayoutUsd: 0,
      distinctPeople: 0,
      periodCount: 0,
      avgPeriodPayoutPhp: 0,
      firstPeriod: null,
      lastPeriod: null,
      latestPayoutDeltaPct: null,
    },
    error: null,
  };

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { ...empty, error: 'Supabase client unavailable' };

  let records: DisbRow[];
  let deptByEmail: Map<string, string>;
  let currentFile: string | null;
  try {
    [records, deptByEmail, currentFile] = await Promise.all([
      loadAllRecords(supabase),
      loadDeptByEmail(supabase),
      currentSourceFile(),
    ]);
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }

  const buckets = new Map<string, Bucket>();
  const distinctPeople = new Set<string>();

  for (const r of records) {
    const sourceFile = r.source_file;
    if (!sourceFile || !isRegularWeeklyCycle(sourceFile)) continue;

    let b = buckets.get(sourceFile);
    if (!b) {
      b = {
        sourceFile,
        periodStart: r.cycle_period_start || null,
        periodEnd: r.cycle_period_end || null,
        payoutPhp: 0,
        payoutUsd: 0,
        paidPhp: 0,
        paidUsd: 0,
        paidCount: 0,
        totalHours: 0,
        people: new Set(),
        dept: new Map(),
      };
      buckets.set(sourceFile, b);
    }

    const email = (r.recipient_email ?? '').trim().toLowerCase();
    const php = num(r.amount_php);
    const usd = num(r.amount_usd);
    const hours = num(r.total_hours);

    b.payoutPhp += php;
    b.payoutUsd += usd;
    b.totalHours += hours;
    if (email) {
      b.people.add(email);
      distinctPeople.add(email);
    }

    if (r.status === 'paid') {
      b.paidPhp += php;
      b.paidUsd += num(r.paid_amount_usd) || usd;
      b.paidCount += 1;
    }

    // Per-department slice — dedupe headcount per department by email.
    const dept = (email && deptByEmail.get(email)) || 'Unassigned';
    let slice = b.dept.get(dept);
    if (!slice) {
      slice = { people: new Set(), payoutPhp: 0, payoutUsd: 0, hours: 0 };
      b.dept.set(dept, slice);
    }
    if (email) slice.people.add(email);
    slice.payoutPhp += php;
    slice.payoutUsd += usd;
    slice.hours += hours;
  }

  // Chronological order — oldest first. Fall back to source-file name when a
  // period start is missing so ordering is still deterministic.
  const ordered = Array.from(buckets.values()).sort((a, b) => {
    const as = a.periodStart ?? a.sourceFile;
    const bs = b.periodStart ?? b.sourceFile;
    return as < bs ? -1 : as > bs ? 1 : 0;
  });

  const periods: FinancialPeriodPoint[] = [];
  let cumPhp = 0;
  let cumUsd = 0;
  let prevPayout = 0;
  let prevPeople = 0;

  for (const b of ordered) {
    cumPhp += b.payoutPhp;
    cumUsd += b.payoutUsd;
    const peopleCount = b.people.size;
    const payoutPhp = round2(b.payoutPhp);
    const payoutUsd = round2(b.payoutUsd);

    const byDepartment: FinancialDeptSlice[] = Array.from(b.dept.entries())
      .map(([department, s]) => ({
        department,
        peopleCount: s.people.size,
        payoutPhp: round2(s.payoutPhp),
        payoutUsd: round2(s.payoutUsd),
        hours: round2(s.hours),
      }))
      .sort((x, y) => y.payoutPhp - x.payoutPhp || x.department.localeCompare(y.department));

    periods.push({
      sourceFile: b.sourceFile,
      reportName: formatDisbursementReportName(
        b.periodStart,
        b.periodEnd,
        b.sourceFile.replace(/\.csv$/i, ''),
      ),
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      isCurrent: currentFile != null && b.sourceFile === currentFile,
      payoutPhp,
      payoutUsd,
      paidPhp: round2(b.paidPhp),
      paidUsd: round2(b.paidUsd),
      paidCount: b.paidCount,
      outstandingPhp: round2(Math.max(0, b.payoutPhp - b.paidPhp)),
      outstandingUsd: round2(Math.max(0, b.payoutUsd - b.paidUsd)),
      peopleCount,
      totalHours: round2(b.totalHours),
      avgPerHeadPhp: peopleCount > 0 ? round2(b.payoutPhp / peopleCount) : 0,
      avgHoursPerHead: peopleCount > 0 ? round2(b.totalHours / peopleCount) : 0,
      cumulativePayoutPhp: round2(cumPhp),
      cumulativePayoutUsd: round2(cumUsd),
      payoutDeltaPct: pctDelta(prevPayout, b.payoutPhp),
      peopleDeltaPct: pctDelta(prevPeople, peopleCount),
      byDepartment,
    });

    prevPayout = b.payoutPhp;
    prevPeople = peopleCount;
  }

  const periodCount = periods.length;
  const totalPayoutPhp = round2(cumPhp);
  const totalPayoutUsd = round2(cumUsd);
  const latest = periods[periodCount - 1] ?? null;

  return {
    periods,
    allTime: {
      totalPayoutPhp,
      totalPayoutUsd,
      distinctPeople: distinctPeople.size,
      periodCount,
      avgPeriodPayoutPhp: periodCount > 0 ? round2(totalPayoutPhp / periodCount) : 0,
      firstPeriod: periods[0]?.periodStart ?? null,
      lastPeriod: latest?.periodStart ?? null,
      latestPayoutDeltaPct: latest?.payoutDeltaPct ?? null,
    },
    error: null,
  };
}

/**
 * Per-recipient detail for ONE cycle — lazy-loaded when the CEO opens the
 * "Recipients" table for the selected pay period, so the timeline payload stays
 * small. Sorted by payout, largest first.
 */
export async function buildPeriodRecipients(
  sourceFile: string,
): Promise<{ recipients: FinancialPeriodRecipient[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { recipients: [], error: 'Supabase client unavailable' };

  let deptByEmail: Map<string, string>;
  try {
    deptByEmail = await loadDeptByEmail(supabase);
  } catch {
    deptByEmail = new Map();
  }

  const PAGE = 1000;
  const rows: Array<{
    recipient_email: string;
    recipient_name: string | null;
    total_hours: number | string | null;
    amount_php: number | string | null;
    amount_usd: number | string | null;
    status: string | null;
  }> = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('disbursement_records')
      .select('recipient_email, recipient_name, total_hours, amount_php, amount_usd, status')
      .eq('source_file', sourceFile)
      .range(from, from + PAGE - 1);
    if (error) return { recipients: [], error: error.message };
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }

  // One entry per recipient (defensive against duplicate rows for a cycle).
  const byEmail = new Map<string, FinancialPeriodRecipient>();
  for (const r of rows) {
    const key = (r.recipient_email ?? '').trim().toLowerCase();
    if (!key || byEmail.has(key)) continue;
    byEmail.set(key, {
      email: r.recipient_email,
      name: r.recipient_name,
      department: deptByEmail.get(key) || 'Unassigned',
      hours: round2(num(r.total_hours)),
      payoutPhp: round2(num(r.amount_php)),
      payoutUsd: round2(num(r.amount_usd)),
      status: r.status ?? 'pending',
    });
  }

  const recipients = Array.from(byEmail.values()).sort((a, b) => b.payoutPhp - a.payoutPhp);
  return { recipients, error: null };
}
