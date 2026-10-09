/** Run: node --import tsx --test src/lib/accounting-scoreboard/board.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionHeadline, summarizeSection, type BoardContext } from './board';
import { buildLookup, type AmPmRowMeta, type StoredEntry } from './scoring';
import { resolveSections, type SectionKey } from './sections';
import { eventCycleStart, type AuditPayrollEvent, type PayrollEvent } from './payroll-cycle';

const sections = resolveSections([]);
const sec = (k: SectionKey) => sections.find((s) => s.key === k)!;
const WEEK = '2026-09-27';
const rows = (...ids: string[]): AmPmRowMeta[] => ids.map((id) => ({ id, bucketDay: null, dueSoon: false }));
const LAST = '2026-09-20';

function ctx(over: Partial<BoardContext> & { entries?: StoredEntry[] } = {}): BoardContext {
  return {
    lookup: buildLookup(over.entries ?? []),
    collections: over.collections ?? [],
    problems: over.problems ?? [],
    payrollEvents: over.payrollEvents ?? [],
    firstClosedPeriodEnd: over.firstClosedPeriodEnd ?? '2026-08-08',
    today: over.today ?? '2026-10-03',
    nowIso: over.nowIso ?? '2026-10-03T16:00:00Z',
  };
}

test('collections: the headline is team points, absent until anything is logged', () => {
  const c = ctx({
    collections: [
      { date: '2026-09-28', rowId: 'a', points: 50 },
      { date: '2026-09-29', rowId: 'b', points: 40 },
      { date: '2026-09-22', rowId: 'a', points: 10 },
    ],
  });
  const s = summarizeSection(sec('collections'), rows('a', 'b'), c, WEEK, LAST);
  assert.equal(s.headline, 90);
  assert.equal(s.light, 'green');
  assert.equal(s.lastHeadline, 10);
  assert.equal(s.lastLight, 'red');
  assert.equal(sectionHeadline(sec('collections'), rows('a'), ctx(), WEEK), null, 'nothing logged ≠ 0 points');
});

test("this week's collections are judged on pace (Thursday: Mon–Wed over)", () => {
  const c = ctx({ today: '2026-10-01', collections: [{ date: '2026-09-28', rowId: 'a', points: 51 }] });
  assert.equal(summarizeSection(sec('collections'), rows('a'), c, WEEK, LAST).light, 'green', '51 ≥ 85 × 3/5');
});

test('payroll problems: the log plus the old grid; over the goal is not green; a little over is amber', () => {
  const c = ctx({
    entries: [{ rowId: 'g', date: '2026-09-28', slot: 'day', value: 12 }], // typed into the old grid
    problems: [{ date: '2026-09-29', rowId: 'g', typeId: 'acct', count: 9 }],
  });
  const problems = summarizeSection(sec('payroll_problems'), rows('g'), c, WEEK, LAST);
  assert.equal(problems.headline, 21);
  assert.equal(problems.light, 'amber');
  assert.equal(problems.lastHeadline, null, 'nothing logged last week: not 0 problems');
  assert.equal(problems.lastLight, 'none');
  const more = ctx({ problems: [{ date: '2026-09-29', rowId: 'g', typeId: 'acct', count: 24 }] });
  assert.equal(summarizeSection(sec('payroll_problems'), rows('g'), more, WEEK, LAST).light, 'red');
});

test('payroll timing comes from the Wizard and close-out events, not from rows', () => {
  const ev = (action: AuditPayrollEvent['action'], at: string, sourceFile: string): PayrollEvent => ({
    action,
    at,
    sourceFile,
    cycleStart: eventCycleStart(null, sourceFile),
  });
  const events: PayrollEvent[] = [
    ev('dispatch.lock_acquired', '2026-09-22T17:21:00Z', 'simple-biz_daily_report_2026-09-13_to_2026-09-19.csv'),
    ev('payment_cycle.closed', '2026-09-25T19:50:00Z', 'simple-biz_daily_report_2026-09-13_to_2026-09-19.csv'),
    ev('dispatch.lock_acquired', '2026-09-29T15:01:00Z', 'simple-biz_daily_report_2026-09-20_to_2026-09-26.csv'),
  ];
  const s = summarizeSection(sec('payroll_timing'), [], ctx({ payrollEvents: events, nowIso: '2026-10-01T18:00:00Z', today: '2026-10-01' }), WEEK, LAST);
  assert.equal(s.headline, null, 'this week is not scored until Friday noon');
  assert.equal(s.light, 'green', 'started on time, close not due yet');
  assert.equal(s.lastHeadline, 0);
  assert.equal(s.lastLight, 'red');
});

test("buckets: the headline is Carla's overall score; a switched goal is judged on its new value", () => {
  const c = ctx({
    entries: [
      { rowId: 'x', date: '2026-09-28', slot: 'am', value: 20 },
      { rowId: 'x', date: '2026-09-28', slot: 'pm', value: 0 },
    ],
  });
  assert.equal(sectionHeadline(sec('buckets'), rows('x'), c, WEEK), 10);
  const strict = resolveSections([{ sectionKey: 'buckets', enabled: true, goal: 11, showOnOverview: true }]).find((s) => s.key === 'buckets')!;
  assert.equal(summarizeSection(strict, rows('x'), c, WEEK, LAST).light, 'amber', '10 is within 80% of 11');
});

test('Open Disputes (2026-10-07): the headline is the Buckets score; it is judged only once a goal is set in Setup', () => {
  const entries: StoredEntry[] = [
    { rowId: 'open', date: '2026-09-28', slot: 'am', value: 10 },
    { rowId: 'open', date: '2026-09-28', slot: 'pm', value: 8 },
    { rowId: 'open', date: '2026-09-29', slot: 'am', value: 9 },
    { rowId: 'open', date: '2026-09-29', slot: 'pm', value: 6 },
    { rowId: 'due', date: '2026-09-28', slot: 'am', value: 3 },
    { rowId: 'due', date: '2026-09-29', slot: 'pm', value: 1 },
  ];
  const r: AmPmRowMeta[] = [
    { id: 'open', bucketDay: null, dueSoon: false },
    { id: 'due', bucketDay: null, dueSoon: true },
  ];
  const c = ctx({ entries });
  assert.equal(summarizeSection(sec('chargebacks'), r, c, WEEK, LAST).headline, 4.5);
  assert.equal(summarizeSection(sec('chargebacks'), r, c, WEEK, LAST).light, 'none', 'no goal set: no call');
  const withGoal = resolveSections([{ sectionKey: 'chargebacks', enabled: true, goal: 5, showOnOverview: true }]).find((s) => s.key === 'chargebacks')!;
  assert.equal(summarizeSection(withGoal, r, c, WEEK, LAST).light, 'amber', '4.5 of a 5 goal is within 80%');
});

test('Outcomes (2026-10-07): the headline is the win ratio, judged on ≥ 50% and never paced', () => {
  const r: AmPmRowMeta[] = [
    { id: 'w', bucketDay: null, dueSoon: false, outcome: 'win' },
    { id: 'l', bucketDay: null, dueSoon: false, outcome: 'loss' },
    { id: 'p', bucketDay: null, dueSoon: false, outcome: null },
  ];
  const monday = (w: number, l: number): StoredEntry[] => [
    { rowId: 'w', date: '2026-09-28', slot: 'count', value: w },
    { rowId: 'l', date: '2026-09-28', slot: 'count', value: l },
    { rowId: 'p', date: '2026-09-28', slot: 'count', value: 7 },
  ];
  // Tuesday: one day of five is over. A paced goal would want 10%; a ratio is judged whole.
  const even = summarizeSection(sec('chargeback_outcomes'), r, ctx({ today: '2026-09-29', entries: monday(1, 1) }), WEEK, LAST);
  assert.equal(even.headline, 50);
  assert.equal(even.light, 'green');
  const third = summarizeSection(sec('chargeback_outcomes'), r, ctx({ today: '2026-09-29', entries: monday(1, 2) }), WEEK, LAST);
  assert.equal(third.headline, 33.3);
  assert.equal(third.light, 'red', '33% is under 80% of 50%');
  assert.equal(summarizeSection(sec('chargeback_outcomes'), r, ctx(), WEEK, LAST).light, 'none', 'nothing decided: no call');
});

test("PM Buckets (Carla, 2026-10-07): below 30 on the Σ of the PMs' averages, an average and never paced", () => {
  const r = rows('a', 'b');
  const day = (id: string, date: string, value: number): StoredEntry => ({ rowId: id, date, slot: 'day', value });
  const tue = { today: '2026-09-29' };
  const over = ctx({ ...tue, entries: [day('a', '2026-09-28', 20), day('a', '2026-09-29', 20), day('b', '2026-09-28', 12)] });
  const s = summarizeSection(sec('pm_buckets'), r, over, WEEK, LAST);
  assert.equal(s.headline, 32);
  assert.equal(s.light, 'amber', 'a little over 30; a paced "below" goal would already be red on Tuesday');
  const under = ctx({ ...tue, entries: [day('a', '2026-09-28', 20), day('b', '2026-09-28', 5)] });
  assert.equal(summarizeSection(sec('pm_buckets'), r, under, WEEK, LAST).light, 'green');
});
