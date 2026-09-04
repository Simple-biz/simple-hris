/**
 * Payroll cycle performance — what fraction of the people a pay week owed money
 * to actually got paid, per cycle and per month.
 *
 * ── The one source, and why there is only one ───────────────────────────────
 * A cycle's success rate is read from its CLOSE-OUT RECORD and nowhere else.
 * The close-out is the only artifact that carries a PAYABLE DENOMINATOR: paid
 * (server-computed via `tallyPaidDispatches`) plus the payable-but-unpaid list
 * the Payment Dispatch queue reported at close time. See
 * `docs/features/cycle-closeout.md`.
 *
 * Two other tables look like they could answer this and CANNOT:
 *
 *   `disbursement_records` — measured live 2026-09-04 over 20,075 rows:
 *     2026-06-21 / 06-28 / 07-05 are 100% `pending` (2,916 rows) for weeks that
 *     were certainly paid; every cycle from 2026-03-01 to 2026-05-17 carries
 *     `status='paid'` with `paid_at` NULL; and 2026-08-02 / 2026-08-23 have no
 *     rows at all. A rate over that table reports three fully-paid weeks as 0%.
 *     It appears here ONLY as the `records_outstanding` cross-check the record
 *     already stores, rendered as a raw count — never as a percentage.
 *
 *   `payment_dispatches` — its denominator is "rows staged into dispatch", so it
 *     structurally cannot see a payable person who was never dispatched. It sits
 *     at 97–99% by construction and would flatter every week. Kane, 2026-09-04:
 *     the series starts when close-outs started, and nothing earlier is inferred.
 *
 * ── A cycle with no close-out has NO rate ───────────────────────────────────
 * It is not 0% and it is not 100%. {@link CyclePerformanceRow.measurable} is
 * false, the row renders "Not closed", and it is excluded from every denominator
 * — the same rule `src/lib/hr/orientation-week-stats.ts` carries for an
 * unmeasurable orientation week (Kane, 2026-08-26: *"only produce data when it
 * has been passed... if it hasn't been marked then just put a note on it"*).
 * Since the only rows this module ever receives ARE close-outs, an unmeasurable
 * row can only arrive as a record whose own numbers are internally empty; it is
 * still carried and labelled rather than dropped.
 *
 * ── The Excluded tab is not "unpaid" ────────────────────────────────────────
 * Inherited from the record itself (Kane's rule). People with no bank, no rate,
 * a wizard exclusion or a USD track were set aside deliberately; counting them
 * as failures would turn an intentional hold into an apparent one. The declared
 * rate therefore reads ~98%, not a dramatic number, and that is correct.
 *
 * I/O-free and framework-free: the route reads `listCycleCloseouts()`, this
 * decides what the numbers mean.
 */

import type { CycleCloseoutSummary } from '@/lib/payroll/cycle-closeout-store';

/** One closed pay cycle, measured. */
export interface CyclePerformanceRow {
  /** `app_settings` key suffix — the cycle's identity. */
  sourceFile: string;
  /** "Aug 2 – 8, 2026", straight from the record. */
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  closedAt: string;
  /** Month bucket, `YYYY-MM`, from `periodEnd`. Null when the record has none. */
  month: string | null;

  /** Distinct payees the record says were paid. Server-computed at close time. */
  paid: number;
  /**
   * Payable people the record says were NOT paid — `unpaid.count` PLUS
   * `unpaid.truncated`. The cap-dropped rows are real debts; folding them in is
   * the difference between an honest rate and one that improves when the list
   * gets too long to store.
   */
  unpaid: number;
  /** `paid + unpaid`. The denominator, and the only one. */
  payable: number;
  /** `paid / payable`, 0–1. Null when `payable` is 0 (see `measurable`). */
  rate: number | null;
  /**
   * False when the record carries no payable people at all, so no percentage
   * can be honest. Such a row is still listed — never silently dropped.
   */
  measurable: boolean;

  employeesPaid: number;
  contractorsPaid: number;
  /** Reported-unpaid entries the server disproved. 0 on pre-2026-09-02 records. */
  reconciledPaid: number;
  /**
   * `disbursement_records` cross-check stored in the record. Counts people
   * Accounting EXCLUDED too, so it is normally larger than `unpaid` — an audit
   * number, never a rate, never the headline. Null when that read failed.
   */
  recordsOutstanding: number | null;
  paidUSD: number;
  paidPHP: number;
}

/** One calendar month of closed cycles. */
export interface MonthPerformanceRow {
  /** `YYYY-MM`. */
  month: string;
  /** "August 2026". */
  label: string;
  /** Closed cycles in the month. */
  cycles: number;
  paid: number;
  unpaid: number;
  payable: number;
  /** Pooled `paid / payable` across the month — NOT a mean of the cycle rates. */
  rate: number | null;
  measurable: boolean;
  /** Worst single cycle rate in the month, for the "weakest week" callout. */
  worstCycleRate: number | null;
  worstCycleLabel: string | null;
}

export interface CyclePerformanceSummary {
  cycles: CyclePerformanceRow[];
  months: MonthPerformanceRow[];
  totals: {
    /** Cycles with a usable rate. */
    measuredCycles: number;
    /** Cycles carried but unmeasurable. */
    unmeasurableCycles: number;
    paid: number;
    unpaid: number;
    payable: number;
    /** Pooled all-time rate over every measurable cycle. */
    rate: number | null;
    /** Earliest / latest `periodEnd` seen — what "since we started" means. */
    firstPeriodEnd: string | null;
    lastPeriodEnd: string | null;
  };
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `YYYY-MM` from a `YYYY-MM-DD`. Null on anything else — never a guess. */
export function monthKeyOf(dateOnly: string | null | undefined): string | null {
  if (typeof dateOnly !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(dateOnly.trim());
  if (!m) return null;
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  return `${m[1]}-${m[2]}`;
}

/** "2026-08" → "August 2026". Echoes the key back if it is not a month. */
export function monthLabel(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  const idx = Number(m[2]) - 1;
  const name = MONTH_NAMES[idx];
  return name ? `${name} ${m[1]}` : monthKey;
}

function safeInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function safeMoney(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Measure one close-out.
 *
 * `unpaid` deliberately includes `unpaid.truncated`: the `MAX_STORED_UNPAID` cap
 * drops rows from the stored LIST, not from the debt. A rate computed over the
 * stored list alone would improve as a week got worse.
 */
export function measureCycle(rec: CycleCloseoutSummary): CyclePerformanceRow {
  const paid = safeInt(rec.paid?.payeeCount);
  const unpaid = safeInt(rec.unpaid?.count) + safeInt(rec.unpaid?.truncated);
  const payable = paid + unpaid;
  const measurable = payable > 0;

  return {
    sourceFile: rec.source_file,
    label: rec.label,
    periodStart: rec.period_start ?? null,
    periodEnd: rec.period_end ?? null,
    closedAt: rec.closed_at,
    month: monthKeyOf(rec.period_end),
    paid,
    unpaid,
    payable,
    rate: measurable ? paid / payable : null,
    measurable,
    employeesPaid: safeInt(rec.paid?.employeeCount),
    contractorsPaid: safeInt(rec.paid?.contractorCount),
    reconciledPaid: safeInt(rec.unpaid?.reconciledPaid),
    recordsOutstanding:
      rec.records_outstanding && Number.isFinite(rec.records_outstanding.total)
        ? rec.records_outstanding.total
        : null,
    paidUSD: safeMoney(rec.paid?.paidUSD),
    paidPHP: safeMoney(rec.paid?.paidPHP),
  };
}

/**
 * Every closed cycle, newest first, plus monthly rollups.
 *
 * Month rates are POOLED (`Σpaid / Σpayable`), never a mean of the weekly rates:
 * a 40-person week and a 1,050-person week are not equal votes on how the month
 * went.
 */
export function buildCyclePerformance(
  records: readonly CycleCloseoutSummary[],
): CyclePerformanceSummary {
  const cycles = records.map(measureCycle);
  // Newest first by period end, falling back to close time so a record with no
  // period still sorts somewhere deterministic instead of drifting.
  cycles.sort((a, b) => {
    const ak = a.periodEnd ?? a.closedAt;
    const bk = b.periodEnd ?? b.closedAt;
    if (ak === bk) return a.sourceFile < b.sourceFile ? 1 : -1;
    return ak < bk ? 1 : -1;
  });

  const byMonth = new Map<string, CyclePerformanceRow[]>();
  for (const c of cycles) {
    if (!c.month) continue; // no period end → cannot be filed under a month
    const bucket = byMonth.get(c.month);
    if (bucket) bucket.push(c);
    else byMonth.set(c.month, [c]);
  }

  const months: MonthPerformanceRow[] = [...byMonth.entries()]
    .map(([month, rows]) => {
      let paid = 0;
      let unpaid = 0;
      let worstCycleRate: number | null = null;
      let worstCycleLabel: string | null = null;
      for (const r of rows) {
        paid += r.paid;
        unpaid += r.unpaid;
        if (r.rate === null) continue;
        if (worstCycleRate === null || r.rate < worstCycleRate) {
          worstCycleRate = r.rate;
          worstCycleLabel = r.label;
        }
      }
      const payable = paid + unpaid;
      return {
        month,
        label: monthLabel(month),
        cycles: rows.length,
        paid,
        unpaid,
        payable,
        rate: payable > 0 ? paid / payable : null,
        measurable: payable > 0,
        worstCycleRate,
        worstCycleLabel,
      };
    })
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));

  let paid = 0;
  let unpaid = 0;
  let measuredCycles = 0;
  let unmeasurableCycles = 0;
  let firstPeriodEnd: string | null = null;
  let lastPeriodEnd: string | null = null;
  for (const c of cycles) {
    if (c.measurable) {
      measuredCycles += 1;
      paid += c.paid;
      unpaid += c.unpaid;
    } else {
      unmeasurableCycles += 1;
    }
    if (c.periodEnd) {
      if (!firstPeriodEnd || c.periodEnd < firstPeriodEnd) firstPeriodEnd = c.periodEnd;
      if (!lastPeriodEnd || c.periodEnd > lastPeriodEnd) lastPeriodEnd = c.periodEnd;
    }
  }
  const payable = paid + unpaid;

  return {
    cycles,
    months,
    totals: {
      measuredCycles,
      unmeasurableCycles,
      paid,
      unpaid,
      payable,
      rate: payable > 0 ? paid / payable : null,
      firstPeriodEnd,
      lastPeriodEnd,
    },
  };
}
