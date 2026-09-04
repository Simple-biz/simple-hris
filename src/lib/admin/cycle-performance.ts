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
 * ── A cycle with no close-out is LISTED, with data, and has NO rate ─────────
 * Added 2026-09-04 (Kane: *"can we add the unclosed? even though they aren't
 * closed lets just label unclosed"* / *"and still add the data in there"*).
 *
 * An undeclared cycle appears in the table with its real paid figures, tallied
 * by the SAME shared rule a closed cycle uses, and with:
 *
 *   `unpaid`   null — NOT zero
 *   `payable`  null — NOT zero
 *   `rate`     null
 *
 * Null rather than zero because zero is a CLAIM: it says nobody was owed. Only
 * a close-out knows who Payment Dispatch still had queued, held or flagged —
 * "payable but unpaid" is a fact about that client-side queue and no server
 * table reproduces it (cycle-closeout.md § "The paid side is server-computed;
 * the unpaid side cannot be"). So the missing denominator is the REASON there
 * is no rate, and the screen says so rather than showing a suspicious 100%.
 *
 * An undeclared cycle therefore **never enters a denominator** — not a month's,
 * not the all-time one. Its paid count is reported separately as
 * `totals.paidOnUnclosed`. Adding it to `paid` would raise the numerator of a
 * rate whose denominator cannot see those cycles at all.
 *
 * This is the same rule `src/lib/hr/orientation-week-stats.ts` carries for an
 * unmeasurable orientation week (Kane, 2026-08-26: *"only produce data when it
 * has been passed... if it hasn't been marked then just put a note on it"*).
 *
 * A **reopened** cycle correctly reappears as unclosed: `reopenCycle` archives
 * the record under a different prefix and frees the live key, so the week is
 * genuinely undeclared again (cycle-closeout.ts § CYCLE_REOPENED_PREFIX).
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

/**
 * What we know about a cycle's declaration.
 *
 *   `closed`        a close-out record exists. This is the ONLY status that can
 *                   carry a rate, because it is the only one with a payable
 *                   denominator.
 *   `unclosed`      the cycle happened after close-outs existed and was never
 *                   closed (or was closed and then REOPENED — a reopen archives
 *                   the record under a different prefix and frees the key, so
 *                   the cycle is genuinely undeclared again).
 *   `pre_closeout`  the cycle ended before the first close-out was ever filed.
 *                   It could not have been closed; the feature did not exist.
 *
 * The last two are separated deliberately. Both lack a rate for the same
 * mechanical reason, but calling twenty pre-feature weeks "unclosed" reads as
 * twenty Accounting failures, which is a lie about people. A status that
 * describes the system's history is not the same as one that describes a
 * clerk's omission.
 */
export type CycleDeclarationStatus = 'closed' | 'unclosed' | 'pre_closeout';

/**
 * A cycle observed in the dispatch/ledger tables, with no close-out record.
 *
 * `paid` MUST come from the shared `tallyPaidDispatches` — see
 * {@link summariseObservedCycle}. Everything absent from this shape is absent
 * because the server genuinely cannot know it.
 */
export interface ObservedCycle {
  /** Representative key for React and for close-out matching. */
  sourceFile: string;
  /**
   * EVERY source file this pay week's rows were found under, usually one.
   *
   * A week can span several file names — a re-upload renames the CSV — and the
   * close-out key is a file name. So a week is declared if ANY of its files has
   * a close-out, and matching only the representative one would list a closed
   * week again as unclosed.
   */
  sourceFiles: string[];
  periodStart: string | null;
  periodEnd: string | null;
  /**
   * Distinct paid payees, by the SHARED tally rule — or **null when the cycle
   * has no `payment_dispatches` rows at all**, which means UNKNOWN, not zero.
   *
   * This distinction is not pedantry; it was measured. `payment_dispatches`
   * only goes back to 2026-05-24, while the ledger holds cycles from
   * 2026-03-01. Reporting `0` for the earlier ones would say "we paid nobody
   * that week" about weeks that paid ~700 people each — the exact lie the rate
   * rules exist to prevent, just relocated into a different cell.
   */
  paid: number | null;
  employeesPaid: number | null;
  contractorsPaid: number | null;
  paidUSD: number;
  paidPHP: number;
  /**
   * `disbursement_records` cross-check, same meaning as a closed cycle's
   * `records_outstanding.total`: counts EXCLUDED people, audit only, never a
   * rate. Null when the read failed or the cycle has no ledger rows.
   */
  recordsOutstanding: number | null;
  /** Newest dispatch timestamp seen, for the "last activity" column. */
  lastActivityAt: string | null;
}

/** One pay cycle, measured if it can be. */
export interface CyclePerformanceRow {
  /** `app_settings` key suffix — the cycle's identity. */
  sourceFile: string;
  /** "Aug 2 – 8, 2026" — from the record when closed, derived otherwise. */
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  /** Only a closed cycle has one. */
  closedAt: string | null;
  /** Month bucket, `YYYY-MM`, from `periodEnd`. Null when there is none. */
  month: string | null;

  status: CycleDeclarationStatus;

  /**
   * Distinct payees paid. For a CLOSED cycle this is the frozen figure the
   * clerk approved; for an unclosed one it is a LIVE tally by the same shared
   * rule, and it will move if anyone is paid later.
   *
   * **Null means UNKNOWN, not zero** — a cycle with no dispatch rows at all
   * (every week before `payment_dispatches` existed). See {@link ObservedCycle.paid}.
   */
  paid: number | null;
  /**
   * Payable people NOT paid — `unpaid.count` PLUS `unpaid.truncated`. The
   * cap-dropped rows are real debts; folding them in is the difference between
   * an honest rate and one that improves when the list gets too long to store.
   *
   * **Null on an unclosed cycle, and that is the whole point.** "Payable but
   * unpaid" only exists in Payment Dispatch's client queue; no server table
   * reproduces it (cycle-closeout.md § "The paid side is server-computed"). An
   * undeclared cycle has no denominator, so it can have no rate.
   */
  unpaid: number | null;
  /** `paid + unpaid`. The denominator, and the only one. Null when unclosed. */
  payable: number | null;
  /** `paid / payable`, 0–1. Null unless the cycle is closed AND has payable people. */
  rate: number | null;
  /**
   * False when no percentage can be honest — either the cycle was never closed
   * (no denominator exists) or its record carries no payable people at all.
   * Such a row is still listed — never silently dropped.
   */
  measurable: boolean;

  /** Null when `paid` is null — the same unknown, not a zero. */
  employeesPaid: number | null;
  contractorsPaid: number | null;
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
  /** Newest dispatch activity, on unclosed cycles only. Null when closed. */
  lastActivityAt: string | null;
}

/** One calendar month. */
export interface MonthPerformanceRow {
  /** `YYYY-MM`. */
  month: string;
  /** "August 2026". */
  label: string;
  /**
   * Every cycle filed under the month, closed or not — so the card can say what
   * fraction of the month the rate actually speaks for.
   */
  cycles: number;
  /** Of `cycles`: closed. The ONLY ones behind `rate`. */
  closedCycles: number;
  /** Of `cycles`: happened after close-outs existed, never closed. */
  unclosedCycles: number;
  /** Of `cycles`: predate the close-out feature entirely. */
  preCloseoutCycles: number;
  /**
   * True when every cycle in the month is closed. When false the card MUST say
   * so: a 98% headline over one closed week of four is not a 98% month, and a
   * reader who cannot see the gap will assume it is.
   */
  fullyDeclared: boolean;
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
    /** Cycles carried but unmeasurable — closed-but-empty, unclosed, pre-feature. */
    unmeasurableCycles: number;
    /** Closed cycles never closed since close-outs existed. */
    unclosedCycles: number;
    /** Cycles that predate the close-out feature. */
    preCloseoutCycles: number;
    /**
     * Paid payees on UNCLOSED cycles. Deliberately its own field and NEVER
     * added to `paid`: it is a live tally with no denominator beside it, and
     * mixing it into the rate's numerator would inflate a percentage whose
     * denominator cannot see those cycles at all.
     */
    paidOnUnclosed: number;
    paid: number;
    unpaid: number;
    payable: number;
    /** Pooled all-time rate over every measurable (closed) cycle. */
    rate: number | null;
    /** Earliest / latest `periodEnd` over CLOSED cycles — "since we started". */
    firstPeriodEnd: string | null;
    lastPeriodEnd: string | null;
    /** Earliest `periodEnd` of any cycle at all, closed or not. */
    firstObservedPeriodEnd: string | null;
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
    status: 'closed',
    lastActivityAt: null,
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

/** "2026-08-02" + "2026-08-08" → "Aug 2 – 8, 2026", matching the record's own label form. */
export function formatCycleLabel(
  periodStart: string | null,
  periodEnd: string | null,
  fallback: string,
): string {
  const s = parseDateOnly(periodStart);
  const e = parseDateOnly(periodEnd);
  if (!s || !e) return fallback;
  const mon = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const sameMonth = s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear();
  const left = `${mon(s)} ${s.getUTCDate()}`;
  const right = sameMonth ? `${e.getUTCDate()}` : `${mon(e)} ${e.getUTCDate()}`;
  return `${left} – ${right}, ${e.getUTCFullYear()}`;
}

function parseDateOnly(v: string | null | undefined): Date | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Turn a cycle that has NO close-out record into a listed row.
 *
 * It carries its real paid numbers — Kane, 2026-09-04: *"still add the data in
 * there"* — and **no denominator, therefore no rate**. `unpaid` and `payable`
 * are `null` rather than `0`: zero would be a claim that nobody was owed, which
 * is exactly what an undeclared cycle cannot tell you. Only a close-out knows
 * who Payment Dispatch still had queued, held or flagged.
 *
 * `firstClosedPeriodEnd` splits `unclosed` from `pre_closeout`. A cycle that
 * ended before the first close-out ever filed could not have been closed, and
 * labelling it a failure would be a lie about a clerk.
 */
export function summariseObservedCycle(
  obs: ObservedCycle,
  firstClosedPeriodEnd: string | null,
): CyclePerformanceRow {
  const preFeature =
    firstClosedPeriodEnd != null &&
    obs.periodEnd != null &&
    obs.periodEnd < firstClosedPeriodEnd;

  return {
    sourceFile: obs.sourceFile,
    label: formatCycleLabel(obs.periodStart, obs.periodEnd, obs.sourceFile),
    periodStart: obs.periodStart,
    periodEnd: obs.periodEnd,
    closedAt: null,
    month: monthKeyOf(obs.periodEnd),
    status: preFeature ? 'pre_closeout' : 'unclosed',
    paid: obs.paid == null ? null : safeInt(obs.paid),
    unpaid: null,
    payable: null,
    rate: null,
    measurable: false,
    employeesPaid: obs.employeesPaid == null ? null : safeInt(obs.employeesPaid),
    contractorsPaid: obs.contractorsPaid == null ? null : safeInt(obs.contractorsPaid),
    reconciledPaid: 0,
    recordsOutstanding:
      obs.recordsOutstanding != null && Number.isFinite(obs.recordsOutstanding)
        ? obs.recordsOutstanding
        : null,
    paidUSD: safeMoney(obs.paidUSD),
    paidPHP: safeMoney(obs.paidPHP),
    lastActivityAt: obs.lastActivityAt ?? null,
  };
}

/**
 * Every cycle, newest first, plus monthly rollups.
 *
 * Closed cycles carry a rate. Observed-but-undeclared cycles are LISTED with
 * their paid figures and no rate, and **never enter a denominator** — not the
 * month's, not the all-time one. A cycle whose payable count is unknowable
 * cannot make a percentage more accurate; it can only make one up.
 *
 * A `source_file` present in BOTH inputs is the close-out's: a declaration
 * outranks an observation, and listing the same week twice (once at 98%, once
 * as "unclosed") would be worse than either alone.
 *
 * Month rates are POOLED (`Σpaid / Σpayable`), never a mean of the weekly rates:
 * a 40-person week and a 1,050-person week are not equal votes on how the month
 * went.
 */
export function buildCyclePerformance(
  records: readonly CycleCloseoutSummary[],
  observed: readonly ObservedCycle[] = [],
): CyclePerformanceSummary {
  const closed = records.map(measureCycle);

  // "Since we started" is defined by the CLOSED cycles alone — it is the date
  // the declaration habit began, not the date payroll began.
  let firstClosedPeriodEnd: string | null = null;
  for (const c of closed) {
    if (!c.periodEnd) continue;
    if (!firstClosedPeriodEnd || c.periodEnd < firstClosedPeriodEnd) {
      firstClosedPeriodEnd = c.periodEnd;
    }
  }

  // A declaration outranks an observation for the same cycle — matched on the
  // source file AND on the period.
  //
  // The period arm is not belt-and-braces; it was measured. Production holds
  // dispatch rows for Aug 9–15 under a source file the close-out does not use
  // (a re-upload renames the file), so file-matching alone listed that week
  // twice: once closed at 98.8%, and once "unclosed, 2 paid" — implying a
  // second, undeclared Aug 9–15 cycle that does not exist. One pay week is one
  // row. That the record's frozen paid figure excludes those two later payments
  // is expected: a close-out is a snapshot, not a running total.
  const declaredFiles = new Set(closed.map((c) => c.sourceFile));
  const declaredPeriods = new Set(
    closed
      .filter((c) => c.periodStart && c.periodEnd)
      .map((c) => `${c.periodStart}|${c.periodEnd}`),
  );
  const open = observed
    .filter((o) => {
      const files = o.sourceFiles?.length ? o.sourceFiles : [o.sourceFile];
      if (files.some((f) => declaredFiles.has(f))) return false;
      if (o.periodStart && o.periodEnd) {
        return !declaredPeriods.has(`${o.periodStart}|${o.periodEnd}`);
      }
      return true;
    })
    .map((o) => summariseObservedCycle(o, firstClosedPeriodEnd));

  const cycles = [...closed, ...open];
  // Newest first by period end, falling back to close time, then to the source
  // file — a TOTAL order, so a row with neither date still sorts deterministically
  // instead of drifting between renders. An undeclared cycle has no close time,
  // hence the empty-string floor rather than a non-null assertion.
  const sortKey = (c: CyclePerformanceRow): string => c.periodEnd ?? c.closedAt ?? '';
  cycles.sort((a, b) => {
    const ak = sortKey(a);
    const bk = sortKey(b);
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
      let closedCycles = 0;
      let unclosedCycles = 0;
      let preCloseoutCycles = 0;
      let worstCycleRate: number | null = null;
      let worstCycleLabel: string | null = null;
      for (const r of rows) {
        if (r.status === 'closed') closedCycles += 1;
        else if (r.status === 'unclosed') unclosedCycles += 1;
        else preCloseoutCycles += 1;
        // ONLY a closed cycle contributes to the month's numbers. An undeclared
        // cycle's paid count has no denominator beside it, so adding it here
        // would raise the numerator of a rate that cannot see it.
        if (r.status !== 'closed') continue;
        paid += r.paid ?? 0;
        unpaid += r.unpaid ?? 0;
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
        closedCycles,
        unclosedCycles,
        preCloseoutCycles,
        fullyDeclared: closedCycles === rows.length,
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
  let paidOnUnclosed = 0;
  let measuredCycles = 0;
  let unmeasurableCycles = 0;
  let unclosedCycles = 0;
  let preCloseoutCycles = 0;
  let firstPeriodEnd: string | null = null;
  let lastPeriodEnd: string | null = null;
  let firstObservedPeriodEnd: string | null = null;

  for (const c of cycles) {
    if (c.status === 'unclosed') unclosedCycles += 1;
    if (c.status === 'pre_closeout') preCloseoutCycles += 1;

    if (c.measurable) {
      measuredCycles += 1;
      paid += c.paid ?? 0;
      unpaid += c.unpaid ?? 0;
    } else {
      unmeasurableCycles += 1;
      // Kept out of `paid` on purpose — see the field doc.
      if (c.status !== 'closed') paidOnUnclosed += c.paid ?? 0;
    }

    if (!c.periodEnd) continue;
    if (!firstObservedPeriodEnd || c.periodEnd < firstObservedPeriodEnd) {
      firstObservedPeriodEnd = c.periodEnd;
    }
    // The declared window is CLOSED cycles only: it answers "since when have we
    // been declaring", which an unclosed cycle says nothing about.
    if (c.status !== 'closed') continue;
    if (!firstPeriodEnd || c.periodEnd < firstPeriodEnd) firstPeriodEnd = c.periodEnd;
    if (!lastPeriodEnd || c.periodEnd > lastPeriodEnd) lastPeriodEnd = c.periodEnd;
  }
  const payable = paid + unpaid;

  return {
    cycles,
    months,
    totals: {
      measuredCycles,
      unmeasurableCycles,
      unclosedCycles,
      preCloseoutCycles,
      paidOnUnclosed,
      paid,
      unpaid,
      payable,
      rate: payable > 0 ? paid / payable : null,
      firstPeriodEnd,
      lastPeriodEnd,
      firstObservedPeriodEnd,
    },
  };
}
