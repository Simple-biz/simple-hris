/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/history.test.ts
 *
 * The History tab (docs/features/accounting-scoreboard-history.md). Synthetic board only: fictional rows, no
 * production data. The parity test replays two weeks through the Overview's own path (summarizeAll in
 * ScoreboardApp.tsx: summarizeSection + sectionCard + teamScore) and through historyWeeks, and they must agree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_MAX_WEEKS,
  historyHighlights,
  historyNotes,
  historyWeeks,
  historyWindows,
  parseHistoryWindow,
  rangeStart,
  weeksBetween,
  type HistoryInput,
  type HistoryWeek,
} from './history';
import { sectionCard, summarizeSection, type BoardContext } from './board';
import { buildLookup, type StoredEntry } from './scoring';
import { boardSections, overviewSections, rowSectionId, tabIdFor, type SectionSetting } from './sections';
import { weekPace, type Light } from './stoplight';
import { teamScore } from './team-score';
import type { BoardRow } from './types';
import { addDays, datesFor } from './week';

const W = '2026-10-04'; // this week (Sun key)
const LAST = '2026-09-27';
const TODAY = '2026-10-07'; // Wednesday: Mon and Tue are over
const NOW = '2026-10-07T18:00:00.000Z';

const row = (id: string, sectionKey: BoardRow['sectionKey'], archived = false): BoardRow => ({
  id, sectionKey, customSectionId: null, label: id, workEmail: null, sortOrder: 0, archived, bucketDay: null, dueSoon: false, outcome: null,
});
const rows: BoardRow[] = [row('b1', 'buckets'), row('b2', 'buckets', true), row('c1', 'compliance'), row('i1', 'inbox')];

function entries(): StoredEntry[] {
  const out: StoredEntry[] = [];
  const am = (rowId: string, date: string, a: number, p: number) => {
    out.push({ rowId, date, slot: 'am', value: a }, { rowId, date, slot: 'pm', value: p });
  };
  for (const d of datesFor(LAST, ['mon', 'tue', 'wed', 'thu', 'fri'])) {
    am('b1', d, 20, 4);
    am('b2', d, 10, 6); // an archived row still counts for the weeks it holds
    out.push({ rowId: 'c1', date: d, slot: 'day', value: 5 });
    am('i1', d, 20, 12);
  }
  for (const d of datesFor(W, ['mon', 'tue', 'wed'])) {
    am('b1', d, 18, 3);
    out.push({ rowId: 'c1', date: d, slot: 'day', value: 6 });
  }
  return out;
}

const input = (settings: SectionSetting[] = []): HistoryInput => ({
  sections: boardSections(settings, []),
  rows,
  entries: entries(),
  collections: [],
  problems: [],
  payrollEvents: [],
  // Close Pay Cycle's first close-out (production: Aug 8). A cycle that ended before it is never judged.
  firstClosedPeriodEnd: '2026-08-08',
  today: TODAY,
  nowIso: NOW,
});

test('window: Sunday keys, from ≤ to, at most 26 weeks, never past this week; every refusal names the rule', () => {
  assert.deepEqual(parseHistoryWindow({ from: LAST, to: W }, W), { ok: true, value: { from: LAST, to: W } });
  const refused = (from: string | null, to: string | null) => {
    const r = parseHistoryWindow({ from, to }, W);
    assert.equal(r.ok, false);
    return r.ok ? '' : r.error;
  };
  assert.match(refused(null, W), /both required/);
  assert.match(refused('2026-10-05', W), /from must be a Sunday/);
  assert.match(refused(LAST, '2026-10-06'), /to must be a Sunday/);
  assert.match(refused(W, LAST), /on or before/);
  assert.match(refused(W, addDays(W, 7)), /after this week/);
  assert.match(refused('2023-12-24', '2024-01-07'), /before 2023-12-31/);
  assert.match(refused(addDays(W, -7 * HISTORY_MAX_WEEKS), W), /at most 26 weeks at a time \(asked for 27\)/);
  assert.equal(parseHistoryWindow({ from: addDays(W, -7 * (HISTORY_MAX_WEEKS - 1)), to: W }, W).ok, true);
});

test('windows: newest first, contiguous, no overlap, cut at the first week with a number', () => {
  const ws = historyWindows(W, '2026-01-04', 13);
  assert.deepEqual(ws[0], { from: '2026-07-12', to: W });
  for (let i = 1; i < ws.length; i++) assert.equal(addDays(ws[i].to, 7), ws[i - 1].from, 'each window ends the week before the newer one starts');
  assert.equal(ws.at(-1)!.from, '2026-01-04', 'never before the first week');
  const all = ws.flatMap((w) => weeksBetween(w.from, w.to));
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, weeksBetween('2026-01-04', W).length);
  assert.deepEqual(historyWindows(W, null), [{ from: W, to: W }], 'an empty board still has this week');
});

test("parity: every week's card, light, card score and Team Score is the Overview's own", () => {
  const inp = input();
  const ctx: BoardContext = {
    lookup: buildLookup(inp.entries), collections: [], problems: [], payrollEvents: [], firstClosedPeriodEnd: inp.firstClosedPeriodEnd, today: TODAY, nowIso: NOW,
  };
  // summarizeAll (ScoreboardApp.tsx), line for line.
  const cards = overviewSections(inp.sections).map((s) => {
    const r = rows.filter((x) => rowSectionId(x) === s.id);
    const summary = summarizeSection(s, r, ctx, W, LAST);
    const groupId = tabIdFor(inp.sections, s);
    const groupLabel = inp.sections.find((x) => x.id === groupId)?.tab ?? s.tab;
    return {
      s, summary, groupId, groupLabel,
      card: sectionCard(s, summary.headline, ctx, W, weekPace(datesFor(W, s.days), TODAY)),
      lastCard: sectionCard(s, summary.lastHeadline, ctx, LAST, 1),
    };
  });
  const team = teamScore(cards.map((c) => ({ groupId: c.groupId, groupLabel: c.groupLabel, card: c.card })));
  const lastTeam = teamScore(cards.map((c) => ({ groupId: c.groupId, groupLabel: c.groupLabel, card: c.lastCard })));

  const [last, now] = historyWeeks(inp, { from: LAST, to: W });
  assert.equal(now.partial, true);
  assert.equal(last.partial, false);
  for (const c of cards) {
    assert.deepEqual(now.cells[c.s.id], { value: c.summary.headline, light: c.summary.light, score: c.card.score }, `${c.s.id} this week`);
    assert.deepEqual(last.cells[c.s.id], { value: c.summary.lastHeadline, light: c.summary.lastLight, score: c.lastCard.score }, `${c.s.id} last week`);
  }
  assert.deepEqual(now.team, { score: team.score, light: team.light });
  assert.deepEqual(last.team, { score: lastTeam.score, light: lastTeam.light });
  // And the fixture is not trivially empty: real numbers, real lights.
  assert.equal(last.cells.buckets.value !== null && last.cells.compliance.value === 25, true);
  assert.notEqual(last.team.score, null);
});

test('absence is never 0: a week with nothing typed has no value, no light, no score and no Team Score', () => {
  // 2025: before the Wizard stamped starts and before close-outs, so Payroll Timing has nothing to judge either.
  const [empty] = historyWeeks(input(), { from: '2025-09-14', to: '2025-09-14' });
  for (const cell of Object.values(empty.cells)) assert.deepEqual(cell, { value: null, light: 'none', score: null });
  assert.deepEqual(empty.team, { score: null, light: 'none' });
  // Payroll Timing is not typed: once close-outs exist, a week the Wizard never closed IS judged (missed), as on the
  // Overview. That is its own rule (accounting-scoreboard.md § Payroll Timing), not a blank read as 0.
  const [afterCloseOuts] = historyWeeks(input(), { from: '2026-09-13', to: '2026-09-13' });
  assert.equal(afterCloseOuts.cells.payroll_timing.light, 'red');
  assert.equal(afterCloseOuts.cells.buckets.value, null);
});

test("a card hidden from the Overview has no bar and is out of every week's Team Score", () => {
  const hidden = input([{ sectionKey: 'compliance', enabled: true, goal: null, showOnOverview: false }]);
  const [last] = historyWeeks(hidden, { from: LAST, to: LAST });
  assert.equal(last.cells.compliance, undefined);
  const [shown] = historyWeeks(input(), { from: LAST, to: LAST });
  assert.notEqual(last.team.score, shown.team.score, 'compliance was counted when shown');
});

// ---------------------------------------------------------------------------
// Highlights and notes, on hand-built weeks.
// ---------------------------------------------------------------------------

const wk = (weekStart: string, score: number | null, light: Light, cells: Record<string, [number | null, Light]> = {}, partial = false): HistoryWeek => ({
  weekStart,
  partial,
  team: { score, light },
  cells: Object.fromEntries(Object.entries(cells).map(([id, [value, l]]) => [id, { value, light: l, score: null }])),
});

const SERIES: HistoryWeek[] = [
  wk('2026-08-30', 70, 'red', { a: [1, 'green'], b: [1, 'red'], col: [40, 'red'] }),
  wk('2026-09-06', 92, 'green', { a: [1, 'green'], b: [1, 'red'], col: [90, 'green'] }),
  wk('2026-09-13', null, 'none', { a: [null, 'none'], b: [null, 'none'] }), // nothing typed: skipped, never behind
  wk('2026-09-20', 95, 'green', { a: [1, 'amber'], b: [1, 'red'], col: [90, 'green'] }),
  wk('2026-09-27', 95, 'green', { a: [1, 'green'], b: [1, 'red'], col: [60, 'red'] }),
  wk('2026-10-04', 40, 'red', { a: [1, 'red'], b: [1, 'red'], col: [200, 'green'] }, true), // this week: never picked
];

test('highlights: the last FULL week vs the one before; on track most; behind running beats behind most', () => {
  const h = historyHighlights(SERIES, ['a', 'b', 'col']);
  assert.deepEqual(h.team, {
    week: '2026-09-27', score: 95, light: 'green', previousWeek: '2026-09-20', delta: 0, average: 88, scoredWeeks: 4,
  });
  assert.equal(h.steadiest?.sectionId, 'a', 'a: 3 green of 4 judged; this week ignored');
  assert.equal(h.steadiest?.green, 3);
  assert.equal(h.attention?.sectionId, 'b');
  assert.equal(h.attention?.reason, 'running');
  assert.equal(h.attention?.behindRun, 4, 'the empty week is skipped, not a break');
  // No run of 2: the card behind the most weeks.
  const once = historyHighlights(SERIES.slice(0, 2).map((w) => ({ ...w, cells: { ...w.cells, b: { value: 1, light: 'green', score: null } } })), ['a', 'b', 'col']);
  assert.equal(once.attention?.sectionId, 'col');
  assert.equal(once.attention?.reason, 'most');
  // Nothing ever behind or on track.
  const none = historyHighlights([wk('2026-09-06', null, 'none', { a: [null, 'none'] })], ['a']);
  assert.equal(none.steadiest, null);
  assert.equal(none.attention, null);
  assert.equal(none.team.week, null);
});

test('notes: best and toughest go to the latest tie, the longest run, the biggest jump, the record, this week', () => {
  const notes = historyNotes(SERIES, 'col');
  assert.deepEqual(notes, [
    { kind: 'best_week', week: '2026-09-27', score: 95 },
    { kind: 'toughest_week', week: '2026-08-30', score: 70 },
    { kind: 'best_run', week: '2026-09-27', from: '2026-09-20', weeks: 2 },
    { kind: 'biggest_jump', week: '2026-09-06', from: '2026-08-30', delta: 22 },
    { kind: 'record', week: '2026-09-20', sectionId: 'col', value: 90 },
    { kind: 'this_week', week: '2026-10-04', score: 40, light: 'red' },
  ]);
  assert.deepEqual(historyNotes([], null), []);
});

test('ranges: the last N weeks through this week, never before the first week with a number', () => {
  assert.equal(rangeStart('12', W, '2025-01-12'), '2026-07-19');
  assert.equal(rangeStart('all', W, '2025-01-12'), '2025-01-12');
  assert.equal(rangeStart('52', W, '2026-06-07'), '2026-06-07');
  assert.equal(rangeStart('all', W, null), W);
});
