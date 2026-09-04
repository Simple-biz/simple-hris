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
  measureCycle,
  monthKeyOf,
  monthLabel,
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
