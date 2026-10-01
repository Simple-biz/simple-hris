/** Run: node --import tsx --test src/lib/accounting-scoreboard/board.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionHeadline, summarizeSection, type BoardContext } from './board';
import { buildLookup, type StoredEntry } from './scoring';
import { resolveSections, type SectionKey } from './sections';
import type { PayrollEvent } from './payroll-cycle';

const sections = resolveSections([]);
const sec = (k: SectionKey) => sections.find((s) => s.key === k)!;
const WEEK = '2026-09-27';
const LAST = '2026-09-20';

function ctx(over: Partial<BoardContext> & { entries?: StoredEntry[] } = {}): BoardContext {
  return {
    lookup: buildLookup(over.entries ?? []),
    collections: over.collections ?? [],
    payrollEvents: over.payrollEvents ?? [],
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
  const s = summarizeSection(sec('collections'), ['a', 'b'], c, WEEK, LAST);
  assert.equal(s.headline, 90);
  assert.equal(s.light, 'green');
  assert.equal(s.lastHeadline, 10);
  assert.equal(s.lastLight, 'red');
  assert.equal(sectionHeadline(sec('collections'), ['a'], ctx(), WEEK), null, 'nothing logged ≠ 0 points');
});

test("this week's collections are judged on pace (Thursday: Mon–Wed over)", () => {
  const c = ctx({ today: '2026-10-01', collections: [{ date: '2026-09-28', rowId: 'a', points: 51 }] });
  assert.equal(summarizeSection(sec('collections'), ['a'], c, WEEK, LAST).light, 'green', '51 ≥ 85 × 3/5');
});

test('payroll problems: over the goal is not green; a below goal gets amber when a little over', () => {
  const c = ctx({
    entries: [
      { rowId: 'g', date: '2026-09-28', slot: 'day', value: 12 },
      { rowId: 'g', date: '2026-09-29', slot: 'day', value: 9 },
    ],
  });
  const problems = summarizeSection(sec('payroll_problems'), ['g'], c, WEEK, LAST);
  assert.equal(problems.headline, 21);
  assert.equal(problems.light, 'amber');
  assert.equal(problems.lastHeadline, null);
  assert.equal(problems.lastLight, 'none');
});

test('payroll timing comes from the audit events, not from rows', () => {
  const events: PayrollEvent[] = [
    { action: 'payroll.dispatch.locked', at: '2026-09-22T17:21:00Z', sourceFile: null },
    { action: 'payment_cycle.closed', at: '2026-09-25T19:50:00Z', sourceFile: 'simple-biz_daily_report_2026-09-13_to_2026-09-19.csv' },
    { action: 'payroll.dispatch.locked', at: '2026-09-29T15:01:00Z', sourceFile: null },
  ];
  const s = summarizeSection(sec('payroll_timing'), [], ctx({ payrollEvents: events, nowIso: '2026-10-01T18:00:00Z', today: '2026-10-01' }), WEEK, LAST);
  assert.equal(s.headline, null, 'this week is not scored until Friday noon');
  assert.equal(s.light, 'green', 'started on time, close not due yet');
  assert.equal(s.lastHeadline, 0);
  assert.equal(s.lastLight, 'red');
});

test('buckets: the headline is the average row score; a switched goal is judged on its new value', () => {
  const c = ctx({
    entries: [
      { rowId: 'x', date: '2026-09-28', slot: 'am', value: 20 },
      { rowId: 'x', date: '2026-09-28', slot: 'pm', value: 0 },
    ],
  });
  assert.equal(sectionHeadline(sec('buckets'), ['x'], c, WEEK), 10);
  const strict = resolveSections([{ sectionKey: 'buckets', enabled: true, goal: 11 }]).find((s) => s.key === 'buckets')!;
  assert.equal(summarizeSection(strict, ['x'], c, WEEK, LAST).light, 'amber', '10 is within 80% of 11');
});
