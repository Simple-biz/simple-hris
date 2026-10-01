/** Run: node --import tsx --test src/lib/accounting-scoreboard/board.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionHeadline, summarizeSection } from './board';
import { buildLookup } from './scoring';
import { resolveSections, type SectionKey } from './sections';

const sections = resolveSections([]);
const sec = (k: SectionKey) => sections.find((s) => s.key === k)!;
const WEEK = '2026-09-27';
const LAST = '2026-09-20';
const TODAY = '2026-10-02';

test('collections: the headline is team points, and absent until anything is logged', () => {
  const logs = [
    { date: '2026-09-28', rowId: 'a', points: 50 },
    { date: '2026-09-29', rowId: 'b', points: 40 },
    { date: '2026-09-22', rowId: 'a', points: 10 },
  ];
  const s = summarizeSection(sec('collections'), ['a', 'b'], new Map(), logs, WEEK, LAST, TODAY);
  assert.deepEqual(s, { headline: 90, lastHeadline: 10, met: true, lastMet: false });
  assert.equal(sectionHeadline(sec('collections'), ['a'], new Map(), [], WEEK, TODAY), null, 'nothing logged ≠ 0 points');
});

test('payroll problems: below the goal is met; payroll timing sums hours', () => {
  const lookup = buildLookup([
    { rowId: 'g', date: '2026-09-28', slot: 'day', value: 12 },
    { rowId: 'g', date: '2026-09-29', slot: 'day', value: 9 },
    { rowId: 'p', date: '2026-09-27', slot: 'start', value: 480 },
    { rowId: 'p', date: '2026-09-27', slot: 'end', value: 1080 },
  ]);
  const problems = summarizeSection(sec('payroll_problems'), ['g'], lookup, [], WEEK, LAST, TODAY);
  assert.equal(problems.headline, 21);
  assert.equal(problems.met, false);
  assert.equal(problems.lastHeadline, null);
  assert.equal(problems.lastMet, null);
  assert.equal(sectionHeadline(sec('payroll_timing'), ['p'], lookup, [], WEEK, TODAY), 10);
});

test('buckets: the headline is the average row score; a switched goal is judged on its new value', () => {
  const lookup = buildLookup([
    { rowId: 'x', date: '2026-09-28', slot: 'am', value: 20 },
    { rowId: 'x', date: '2026-09-28', slot: 'pm', value: 0 },
  ]);
  assert.equal(sectionHeadline(sec('buckets'), ['x'], lookup, [], WEEK, TODAY), 10);
  const strict = resolveSections([{ sectionKey: 'buckets', enabled: true, goal: 11 }]).find((s) => s.key === 'buckets')!;
  assert.equal(summarizeSection(strict, ['x'], lookup, [], WEEK, LAST, TODAY).met, false);
});
