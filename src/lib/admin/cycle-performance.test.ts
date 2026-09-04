/**
 * buildCyclePerformance — payroll cycle success rate from close-out records.
 *
 * The properties pinned here are the ones that cost money to get wrong:
 *
 *  - The denominator is `paid + unpaid` from the RECORD. Nothing infers a
 *    denominator from `disbursement_records` or `payment_dispatches` (live data
 *    2026-09-04 proves both lie — see the module header).
 *  - `unpaid.truncated` is IN the unpaid count. Dropping it makes a week's rate
 *    improve as its unpaid list grows past the storage cap.
 *  - A record with nothing payable is UNMEASURABLE, not 0% and not 100%, and is
 *    still listed.
 *  - Month rates are POOLED, never a mean of the weekly rates.
 *  - `records_outstanding` never touches the rate — it counts excluded people.
 *
 * Run:  npx tsx --test src/lib/admin/cycle-performance.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CycleCloseoutSummary } from '@/lib/payroll/cycle-closeout-store';
import {
  buildCyclePerformance,
  formatCycleLabel,
  measureCycle,
  monthKeyOf,
  monthLabel,
  summariseObservedCycle,
  type ObservedCycle,
} from '@/lib/admin/cycle-performance';

function rec(over: {
  file: string;
  label?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  closedAt?: string;
  paid?: number;
  employees?: number;
  contractors?: number;
  unpaid?: number;
  truncated?: number;
  reconciledPaid?: number;
  outstanding?: number | null;
  paidUSD?: number;
  paidPHP?: number;
}): CycleCloseoutSummary {
  return {
    version: 1,
    closed_at: over.closedAt ?? '2026-08-14T04:00:00.000Z',
    closed_by: 'Clerk',
    closed_by_email: 'clerk@simple.biz',
    source_file: over.file,
    cycle_id: null,
    label: over.label ?? over.file,
    period_start: over.periodStart ?? null,
    period_end: over.periodEnd ?? null,
    paid: {
      payeeCount: over.paid ?? 0,
      employeeCount: over.employees ?? over.paid ?? 0,
      contractorCount: over.contractors ?? 0,
      dispatchCount: over.paid ?? 0,
      paidUSD: over.paidUSD ?? 0,
      paidPHP: over.paidPHP ?? 0,
    },
    byProcessor: {},
    unpaid: {
      source: 'dispatch_screen',
      count: over.unpaid ?? 0,
      employeeCount: over.unpaid ?? 0,
      contractorCount: 0,
      totalUSD: 0,
      totalPHP: 0,
      truncated: over.truncated ?? 0,
      dropped: 0,
      reconciledPaid: over.reconciledPaid ?? 0,
    },
    records_outstanding:
      over.outstanding === null || over.outstanding === undefined
        ? null
        : {
            notPaid: over.outstanding,
            threshold: 0,
            problem: 0,
            neverDispatched: 0,
            total: over.outstanding,
          },
  };
}

/** The three live records, 2026-09-04. */
const LIVE: CycleCloseoutSummary[] = [
  rec({ file: 'a.csv', label: 'Aug 2 – 8, 2026', periodStart: '2026-08-02', periodEnd: '2026-08-08', paid: 1051, unpaid: 17, outstanding: 0 }),
  rec({ file: 'b.csv', label: 'Aug 9 – 15, 2026', periodStart: '2026-08-09', periodEnd: '2026-08-15', paid: 1014, unpaid: 12, outstanding: 32 }),
  rec({ file: 'c.csv', label: 'Aug 16 – 22, 2026', periodStart: '2026-08-16', periodEnd: '2026-08-22', paid: 1023, unpaid: 19, outstanding: 47 }),
];

test('the denominator is paid + unpaid from the record', () => {
  const row = measureCycle(rec({ file: 'x', paid: 300, unpaid: 700 }));
  assert.equal(row.payable, 1000);
  assert.equal(row.rate, 0.3);
  assert.equal(row.measurable, true);
});

test('truncated unpaid rows are counted as unpaid, not dropped', () => {
  // A week whose unpaid list overflowed MAX_STORED_UNPAID: 1000 stored + 200
  // dropped by the cap. The debt is 1200, so the rate must be 300/1500.
  const row = measureCycle(rec({ file: 'x', paid: 300, unpaid: 1000, truncated: 200 }));
  assert.equal(row.unpaid, 1200);
  assert.equal(row.payable, 1500);
  assert.equal(row.rate, 0.2);
});

test('a record with nothing payable is unmeasurable, not 0% and not 100%', () => {
  const row = measureCycle(rec({ file: 'empty', paid: 0, unpaid: 0 }));
  assert.equal(row.measurable, false);
  assert.equal(row.rate, null);
  // and it is still carried
  const built = buildCyclePerformance([rec({ file: 'empty' })]);
  assert.equal(built.cycles.length, 1);
  assert.equal(built.totals.unmeasurableCycles, 1);
  assert.equal(built.totals.measuredCycles, 0);
  assert.equal(built.totals.rate, null);
});

test('an unmeasurable cycle never enters a total or a month denominator', () => {
  const built = buildCyclePerformance([
    rec({ file: 'good', periodEnd: '2026-08-08', paid: 90, unpaid: 10 }),
    rec({ file: 'empty', periodEnd: '2026-08-15', paid: 0, unpaid: 0 }),
  ]);
  assert.equal(built.totals.payable, 100);
  assert.equal(built.totals.rate, 0.9);
  const aug = built.months.find((m) => m.month === '2026-08');
  assert.ok(aug);
  assert.equal(aug.payable, 100);
  assert.equal(aug.rate, 0.9);
  // both cycles are still listed under the month
  assert.equal(aug.cycles, 2);
});

test('records_outstanding never touches the rate', () => {
  // It counts EXCLUDED people too, so it is normally larger than unpaid.
  const row = measureCycle(rec({ file: 'x', paid: 1023, unpaid: 19, outstanding: 47 }));
  assert.equal(row.recordsOutstanding, 47);
  assert.equal(row.payable, 1042);
  assert.equal(row.rate, 1023 / 1042);
});

test('a failed records_outstanding read stays null, never zero', () => {
  assert.equal(measureCycle(rec({ file: 'x', outstanding: null })).recordsOutstanding, null);
});

test('month rate is pooled, not a mean of the weekly rates', () => {
  // 100% on a 1-person week and 50% on a 1000-person week is NOT 75%.
  const built = buildCyclePerformance([
    rec({ file: 'tiny', periodEnd: '2026-08-08', paid: 1, unpaid: 0 }),
    rec({ file: 'big', periodEnd: '2026-08-15', paid: 500, unpaid: 500 }),
  ]);
  const aug = built.months.find((m) => m.month === '2026-08');
  assert.ok(aug);
  assert.equal(aug.paid, 501);
  assert.equal(aug.payable, 1001);
  assert.equal(aug.rate, 501 / 1001);
  assert.notEqual(aug.rate, 0.75);
});

test('the month is the period END, not the close date', () => {
  // Aug 2–8 was closed Aug 14; a Jul 26 – Aug 1 week closed in August belongs
  // to JULY, because that is when the work happened.
  const row = measureCycle(
    rec({ file: 'x', periodStart: '2026-07-26', periodEnd: '2026-08-01', closedAt: '2026-08-07T00:00:00.000Z' }),
  );
  assert.equal(row.month, '2026-08');
  const row2 = measureCycle(
    rec({ file: 'y', periodStart: '2026-07-19', periodEnd: '2026-07-25', closedAt: '2026-08-02T00:00:00.000Z' }),
  );
  assert.equal(row2.month, '2026-07');
});

test('a record with no period end is listed but filed under no month', () => {
  const built = buildCyclePerformance([rec({ file: 'x', periodEnd: null, paid: 5, unpaid: 5 })]);
  assert.equal(built.cycles.length, 1);
  assert.equal(built.cycles[0]!.month, null);
  assert.equal(built.months.length, 0);
  // still counted in the all-time total
  assert.equal(built.totals.payable, 10);
});

test('cycles come back newest first; months newest first', () => {
  const built = buildCyclePerformance(LIVE);
  assert.deepEqual(built.cycles.map((c) => c.periodEnd), ['2026-08-22', '2026-08-15', '2026-08-08']);
  const built2 = buildCyclePerformance([
    rec({ file: 'jul', periodEnd: '2026-07-25', paid: 1, unpaid: 0 }),
    rec({ file: 'aug', periodEnd: '2026-08-08', paid: 1, unpaid: 0 }),
  ]);
  assert.deepEqual(built2.months.map((m) => m.month), ['2026-08', '2026-07']);
});

test('the worst cycle in a month is named', () => {
  const built = buildCyclePerformance(LIVE);
  const aug = built.months.find((m) => m.month === '2026-08');
  assert.ok(aug);
  // Aug 16–22 is 1023/1042 = 98.18%, the weakest of the three.
  assert.equal(aug.worstCycleLabel, 'Aug 16 – 22, 2026');
  assert.equal(aug.worstCycleRate, 1023 / 1042);
});

test('the live August 2026 numbers', () => {
  const built = buildCyclePerformance(LIVE);
  const aug = built.months.find((m) => m.month === '2026-08');
  assert.ok(aug);
  assert.equal(aug.cycles, 3);
  assert.equal(aug.paid, 3088);
  assert.equal(aug.unpaid, 48);
  assert.equal(aug.payable, 3136);
  assert.equal(Math.round(aug.rate! * 10000) / 100, 98.47);
  assert.equal(built.totals.firstPeriodEnd, '2026-08-08');
  assert.equal(built.totals.lastPeriodEnd, '2026-08-22');
});

test('nonsense counts degrade to zero rather than NaN', () => {
  const bad = rec({ file: 'x', paid: 10, unpaid: 5 });
  // simulate a hand-edited / legacy record
  (bad.paid as { payeeCount: number }).payeeCount = Number.NaN;
  (bad.unpaid as { count: number }).count = -3;
  const row = measureCycle(bad);
  assert.equal(row.paid, 0);
  assert.equal(row.unpaid, 0);
  assert.equal(row.measurable, false);
  assert.equal(row.rate, null);
});

test('monthKeyOf refuses anything that is not a date-only string', () => {
  assert.equal(monthKeyOf('2026-08-22'), '2026-08');
  assert.equal(monthKeyOf('2026-08-22T04:00:00Z'), '2026-08');
  assert.equal(monthKeyOf('2026-13-01'), null);
  assert.equal(monthKeyOf('august'), null);
  assert.equal(monthKeyOf(''), null);
  assert.equal(monthKeyOf(null), null);
  assert.equal(monthKeyOf(undefined), null);
});

test('monthLabel is human, and echoes back anything it cannot parse', () => {
  assert.equal(monthLabel('2026-08'), 'August 2026');
  assert.equal(monthLabel('2026-01'), 'January 2026');
  assert.equal(monthLabel('2026-12'), 'December 2026');
  assert.equal(monthLabel('nope'), 'nope');
});

test('an empty input is an empty summary, not a zero rate', () => {
  const built = buildCyclePerformance([]);
  assert.deepEqual(built.cycles, []);
  assert.deepEqual(built.months, []);
  assert.equal(built.totals.rate, null);
  assert.equal(built.totals.firstPeriodEnd, null);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Unclosed cycles (added 2026-09-04).
 *
 * Kane: "can we add the unclosed? even though they aren't closed lets just
 * label unclosed" / "and still add the data in there".
 *
 * The failure classes these pin, in order of how much they would cost:
 *   1. an undeclared cycle's paid count entering a rate or any denominator
 *   2. `unpaid: 0` on an undeclared cycle — a CLAIM that nobody was owed
 *   3. a pre-feature cycle labelled as an Accounting failure
 *   4. a month reading 98% while most of it is undeclared
 *   5. one cycle listed twice, closed AND unclosed
 *   6. a reopened cycle still counted as closed
 * ──────────────────────────────────────────────────────────────────────────── */

function obs(over: Partial<ObservedCycle> & { sourceFile: string }): ObservedCycle {
  const pick = <K extends keyof ObservedCycle>(k: K, fb: ObservedCycle[K]): ObservedCycle[K] =>
    k in over ? (over[k] as ObservedCycle[K]) : fb;
  return {
    sourceFile: over.sourceFile,
    sourceFiles: pick('sourceFiles', [over.sourceFile]),
    periodStart: pick('periodStart', '2026-08-23'),
    periodEnd: pick('periodEnd', '2026-08-29'),
    paid: pick('paid', 1051),
    employeesPaid: pick('employeesPaid', 1047),
    contractorsPaid: pick('contractorsPaid', 4),
    paidUSD: pick('paidUSD', 0),
    paidPHP: pick('paidPHP', 0),
    recordsOutstanding: pick('recordsOutstanding', null),
    lastActivityAt: pick('lastActivityAt', '2026-08-30T02:00:00.000Z'),
  };
}

test('an unclosed cycle is listed, carries its paid data, and has NO rate', () => {
  const built = buildCyclePerformance(LIVE, [obs({ sourceFile: 'open.csv' })]);
  const row = built.cycles.find((c) => c.sourceFile === 'open.csv');
  assert.ok(row);
  assert.equal(row.status, 'unclosed');
  assert.equal(row.paid, 1051); // the data IS there
  assert.equal(row.employeesPaid, 1047);
  assert.equal(row.contractorsPaid, 4);
  assert.equal(row.rate, null);
  assert.equal(row.measurable, false);
});

test('an unclosed cycle reports unpaid and payable as NULL, never 0', () => {
  // 0 would be a claim that nobody was owed. Only a close-out knows that.
  const row = summariseObservedCycle(obs({ sourceFile: 'open.csv' }), '2026-08-08');
  assert.equal(row.unpaid, null);
  assert.equal(row.payable, null);
  assert.notEqual(row.unpaid, 0);
  assert.notEqual(row.payable, 0);
});

test('an unclosed cycle NEVER enters the all-time denominator', () => {
  const withOnlyClosed = buildCyclePerformance(LIVE);
  const withOpen = buildCyclePerformance(LIVE, [obs({ sourceFile: 'open.csv', paid: 5000 })]);
  assert.equal(withOpen.totals.payable, withOnlyClosed.totals.payable);
  assert.equal(withOpen.totals.paid, withOnlyClosed.totals.paid);
  assert.equal(withOpen.totals.rate, withOnlyClosed.totals.rate);
  // reported, but separately
  assert.equal(withOpen.totals.paidOnUnclosed, 5000);
  assert.equal(withOpen.totals.unclosedCycles, 1);
});

test('an unclosed cycle NEVER enters a month denominator, but IS counted in the month', () => {
  const built = buildCyclePerformance(LIVE, [
    obs({ sourceFile: 'open.csv', periodStart: '2026-08-23', periodEnd: '2026-08-29', paid: 9999 }),
  ]);
  const aug = built.months.find((m) => m.month === '2026-08');
  assert.ok(aug);
  // rate still the three closed cycles only
  assert.equal(aug.paid, 3088);
  assert.equal(aug.payable, 3136);
  assert.equal(Math.round(aug.rate! * 10000) / 100, 98.47);
  // but the month knows it is not fully declared
  assert.equal(aug.cycles, 4);
  assert.equal(aug.closedCycles, 3);
  assert.equal(aug.unclosedCycles, 1);
  assert.equal(aug.fullyDeclared, false);
});

test('a month with every cycle closed is fullyDeclared', () => {
  const built = buildCyclePerformance(LIVE);
  const aug = built.months.find((m) => m.month === '2026-08');
  assert.ok(aug);
  assert.equal(aug.fullyDeclared, true);
  assert.equal(aug.unclosedCycles, 0);
  assert.equal(aug.preCloseoutCycles, 0);
});

test('a cycle that ended before the first close-out is pre_closeout, not a failure', () => {
  // Labelling ~20 pre-feature weeks "unclosed" reads as 20 Accounting failures.
  const built = buildCyclePerformance(LIVE, [
    obs({ sourceFile: 'march.csv', periodStart: '2026-03-01', periodEnd: '2026-03-07' }),
    obs({ sourceFile: 'late.csv', periodStart: '2026-08-23', periodEnd: '2026-08-29' }),
  ]);
  assert.equal(built.cycles.find((c) => c.sourceFile === 'march.csv')!.status, 'pre_closeout');
  assert.equal(built.cycles.find((c) => c.sourceFile === 'late.csv')!.status, 'unclosed');
  assert.equal(built.totals.preCloseoutCycles, 1);
  assert.equal(built.totals.unclosedCycles, 1);
});

test('the pre-feature boundary is the FIRST CLOSED period end, inclusive', () => {
  // A cycle ending exactly on the first closed period end is NOT pre-feature.
  const same = summariseObservedCycle(obs({ sourceFile: 'x', periodEnd: '2026-08-08' }), '2026-08-08');
  assert.equal(same.status, 'unclosed');
  const before = summariseObservedCycle(obs({ sourceFile: 'y', periodEnd: '2026-08-07' }), '2026-08-08');
  assert.equal(before.status, 'pre_closeout');
});

test('with nothing closed yet, nothing is called pre_closeout', () => {
  // No first-close boundary exists, so no cycle can be "before" it.
  const built = buildCyclePerformance([], [obs({ sourceFile: 'x', periodEnd: '2026-03-07' })]);
  assert.equal(built.cycles[0]!.status, 'unclosed');
  assert.equal(built.totals.preCloseoutCycles, 0);
});

test('a declaration outranks an observation — a cycle is never listed twice', () => {
  const built = buildCyclePerformance(LIVE, [
    obs({ sourceFile: 'a.csv', paid: 1 }), // same source_file as a closed cycle
    obs({ sourceFile: 'open.csv' }),
  ]);
  assert.equal(built.cycles.filter((c) => c.sourceFile === 'a.csv').length, 1);
  const a = built.cycles.find((c) => c.sourceFile === 'a.csv')!;
  assert.equal(a.status, 'closed');
  assert.equal(a.paid, 1051); // the RECORD's frozen figure, not the observation's 1
  assert.equal(built.cycles.length, LIVE.length + 1);
});

test('a reopened cycle reappears as unclosed', () => {
  // reopenCycle archives the record under a DIFFERENT prefix and frees the live
  // key, so listCycleCloseouts no longer returns it — the week is undeclared again.
  const reopened = LIVE.filter((r) => r.source_file !== 'c.csv');
  const built = buildCyclePerformance(reopened, [
    obs({ sourceFile: 'c.csv', periodStart: '2026-08-16', periodEnd: '2026-08-22', paid: 1023 }),
  ]);
  const c = built.cycles.find((x) => x.sourceFile === 'c.csv')!;
  assert.equal(c.status, 'unclosed');
  assert.equal(c.rate, null);
  assert.equal(built.totals.measuredCycles, 2);
});

test('unclosed cycles sort into the same newest-first order as closed ones', () => {
  const built = buildCyclePerformance(LIVE, [
    obs({ sourceFile: 'open.csv', periodStart: '2026-08-23', periodEnd: '2026-08-29' }),
    obs({ sourceFile: 'old.csv', periodStart: '2026-07-26', periodEnd: '2026-08-01' }),
  ]);
  assert.deepEqual(
    built.cycles.map((c) => c.periodEnd),
    ['2026-08-29', '2026-08-22', '2026-08-15', '2026-08-08', '2026-08-01'],
  );
});

test('the declared window still describes CLOSED cycles only', () => {
  const built = buildCyclePerformance(LIVE, [
    obs({ sourceFile: 'march.csv', periodStart: '2026-03-01', periodEnd: '2026-03-07' }),
    obs({ sourceFile: 'open.csv', periodStart: '2026-08-23', periodEnd: '2026-08-29' }),
  ]);
  // "since we started declaring" is unmoved by undeclared cycles either side
  assert.equal(built.totals.firstPeriodEnd, '2026-08-08');
  assert.equal(built.totals.lastPeriodEnd, '2026-08-22');
  // but we still know how far the data itself goes back
  assert.equal(built.totals.firstObservedPeriodEnd, '2026-03-07');
});

test('an unclosed cycle keeps records_outstanding as an audit count, never a rate', () => {
  const row = summariseObservedCycle(obs({ sourceFile: 'x', recordsOutstanding: 47 }), '2026-08-08');
  assert.equal(row.recordsOutstanding, 47);
  assert.equal(row.rate, null);
  assert.equal(row.payable, null);
});

test('a failed outstanding read on an unclosed cycle stays null, never zero', () => {
  assert.equal(
    summariseObservedCycle(obs({ sourceFile: 'x', recordsOutstanding: null }), null)
      .recordsOutstanding,
    null,
  );
});

test('an unclosed cycle with no period dates still lists, under no month', () => {
  const built = buildCyclePerformance(
    [],
    [obs({ sourceFile: 'weird.csv', periodStart: null, periodEnd: null })],
  );
  assert.equal(built.cycles.length, 1);
  assert.equal(built.cycles[0]!.month, null);
  assert.equal(built.cycles[0]!.label, 'weird.csv'); // falls back to the file name
  assert.equal(built.months.length, 0);
});

test('formatCycleLabel matches the close-out record label form', () => {
  assert.equal(formatCycleLabel('2026-08-02', '2026-08-08', 'x'), 'Aug 2 – 8, 2026');
  assert.equal(formatCycleLabel('2026-07-26', '2026-08-01', 'x'), 'Jul 26 – Aug 1, 2026');
  assert.equal(formatCycleLabel('2026-12-27', '2027-01-02', 'x'), 'Dec 27 – Jan 2, 2027');
  assert.equal(formatCycleLabel(null, '2026-08-08', 'fallback'), 'fallback');
  assert.equal(formatCycleLabel('nope', 'nope', 'fallback'), 'fallback');
});

test('passing no observed cycles is identical to the old single-argument call', () => {
  const a = buildCyclePerformance(LIVE);
  const b = buildCyclePerformance(LIVE, []);
  assert.deepEqual(a, b);
  assert.equal(a.totals.unclosedCycles, 0);
  assert.equal(a.totals.paidOnUnclosed, 0);
});

/* ── Three defects that only appeared when the tab was run against production
 *    on 2026-09-04. Unit tests over hand-made fixtures had all passed. ── */

test('a paid count of NULL means unknown and renders as such — never 0', () => {
  // payment_dispatches only reaches back to 2026-05-24; the ledger holds cycles
  // from 2026-03-01. Reporting 0 paid for those would announce that ~700 people
  // went unpaid in each of a dozen weeks that in fact paid everyone.
  const row = summariseObservedCycle(
    obs({ sourceFile: 'march.csv', periodEnd: '2026-03-07', paid: null, employeesPaid: null, contractorsPaid: null }),
    '2026-08-08',
  );
  assert.equal(row.paid, null);
  assert.equal(row.employeesPaid, null);
  assert.equal(row.contractorsPaid, null);
  assert.notEqual(row.paid, 0);
});

test('an unknown paid count contributes nothing to paidOnUnclosed, and never NaN', () => {
  const built = buildCyclePerformance(LIVE, [
    obs({ sourceFile: 'march.csv', periodEnd: '2026-03-07', paid: null }),
    obs({ sourceFile: 'open.csv', periodEnd: '2026-08-29', paid: 40 }),
  ]);
  assert.equal(built.totals.paidOnUnclosed, 40);
  assert.ok(Number.isFinite(built.totals.paidOnUnclosed));
});

test('a genuine zero is kept — a cycle WITH dispatch rows that paid nobody', () => {
  const row = summariseObservedCycle(obs({ sourceFile: 'x', paid: 0 }), '2026-08-08');
  assert.equal(row.paid, 0);
  assert.notEqual(row.paid, null);
});

test('one pay week is one row even when the source file was renamed', () => {
  // Production: dispatch rows for Aug 9–15 sit under a source file the
  // close-out does not use (a re-upload renames it), which listed that week
  // twice — closed at 98.8%, and again as "unclosed, 2 paid".
  const built = buildCyclePerformance(LIVE, [
    obs({
      sourceFile: 'b-REUPLOAD.csv',
      periodStart: '2026-08-09',
      periodEnd: '2026-08-15',
      paid: 2,
    }),
  ]);
  const aug9 = built.cycles.filter((c) => c.periodEnd === '2026-08-15');
  assert.equal(aug9.length, 1);
  assert.equal(aug9[0]!.status, 'closed');
  // the record's FROZEN figure stands — a close-out is a snapshot, not a running total
  assert.equal(aug9[0]!.paid, 1014);
  assert.equal(built.totals.unclosedCycles, 0);
});

test('period-matching only suppresses a week that IS declared', () => {
  const built = buildCyclePerformance(LIVE, [
    obs({ sourceFile: 'other.csv', periodStart: '2026-08-23', periodEnd: '2026-08-29', paid: 7 }),
  ]);
  assert.equal(built.cycles.filter((c) => c.periodEnd === '2026-08-29').length, 1);
  assert.equal(built.totals.unclosedCycles, 1);
});

test('an observed cycle with no dates is never suppressed by period-matching', () => {
  // Null periods must not collide into one another as "the same week".
  const built = buildCyclePerformance(LIVE, [
    obs({ sourceFile: 'p.csv', periodStart: null, periodEnd: null }),
    obs({ sourceFile: 'q.csv', periodStart: null, periodEnd: null }),
  ]);
  assert.equal(built.cycles.filter((c) => c.periodEnd === null).length, 2);
});

test('a week declared under ANY of its source files is not listed again', () => {
  // A re-upload renames the CSV, so one week can span several file names while
  // the close-out key is only ever one of them.
  const built = buildCyclePerformance(LIVE, [
    obs({
      sourceFile: 'b-REUPLOAD.csv',
      sourceFiles: ['a.csv', 'b-REUPLOAD.csv'],
      periodStart: null,
      periodEnd: null,
      paid: 3,
    }),
  ]);
  assert.equal(built.totals.unclosedCycles, 0);
  assert.equal(built.cycles.length, LIVE.length);
});

test('sourceFiles absent falls back to the single sourceFile', () => {
  const built = buildCyclePerformance(LIVE, [
    { ...obs({ sourceFile: 'a.csv' }), sourceFiles: [] },
  ]);
  // 'a.csv' is declared, so it is still suppressed
  assert.equal(built.totals.unclosedCycles, 0);
});
