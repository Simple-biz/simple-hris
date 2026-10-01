/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/scoring.test.ts
 *
 * Fixtures are the live sheet's own numbers (read 2026-10-01, week Sep 28 – Oct 2), so a change
 * to the math has to be argued against what the team sees today.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amPmRowStats,
  amPmSectionStats,
  bucketScore,
  buildLookup,
  collectionsHistory,
  collectionsWeekStats,
  dailySectionStats,
  goalMet,
  goalText,
  inboxScore,
  minutesToClock,
  minutesToTimeInput,
  round2,
  timeInputToMinutes,
  timeSpanSectionHours,
  type StoredEntry,
} from './scoring';
import { sectionDef } from './sections';

const MON_FRI = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
const THU = '2026-10-01';

function amPm(rowId: string, pairs: Array<[number | null, number | null]>): StoredEntry[] {
  const out: StoredEntry[] = [];
  pairs.forEach(([am, pm], i) => {
    if (am !== null) out.push({ rowId, date: MON_FRI[i], slot: 'am', value: am });
    if (pm !== null) out.push({ rowId, date: MON_FRI[i], slot: 'pm', value: pm });
  });
  return out;
}

test("bucketScore is the sheet's tier formula", () => {
  assert.equal(bucketScore(-2), 1);
  assert.equal(bucketScore(0), 2);
  assert.equal(bucketScore(0.5), 4);
  assert.equal(bucketScore(5), 4);
  assert.equal(bucketScore(6), 6);
  assert.equal(bucketScore(10), 6);
  assert.equal(bucketScore(12), 8);
  assert.equal(bucketScore(15), 8);
  assert.equal(bucketScore(16), 10);
  assert.equal(bucketScore(94), 10);
});

test("inboxScore is the sheet's =IF(avg=0,10,IF(avg>=9,1,10-avg))", () => {
  assert.equal(inboxScore(0), 10);
  assert.equal(inboxScore(9), 1);
  assert.equal(inboxScore(17), 1);
  assert.equal(round2(inboxScore(5 / 3)), 8.33, "Tieg's row: PMs 2, 3, 0 → 8.3");
});

test('a complete week reproduces the sheet: Tues (Collections) cleared 81 but scores Comp 12 → 8', () => {
  // G10:N10 = 7/76, 81/0, 0/0, 0/0 — the fill on Monday counts against the Tuesday bucket (sheet rule, kept).
  const lookup = buildLookup(amPm('tue', [[7, 76], [81, 0], [0, 0], [0, 0], [null, null]]));
  const s = amPmRowStats('tue', MON_FRI, lookup, 'bucket', '2026-10-02');
  assert.equal(s.comp, 12);
  assert.equal(s.score, 8);
});

test("a day with AM and no PM is NOT credited (the sheet's blank-as-0 credited +68)", () => {
  // Thurs (Collections) on Oct 1: 1/1, 1/5, 5/66, then Thu AM 68 with no PM yet.
  const lookup = buildLookup(amPm('thu', [[1, 1], [1, 5], [5, 66], [68, null], [null, null]]));
  const today = amPmRowStats('thu', MON_FRI, lookup, 'bucket', THU);
  assert.equal(today.comp, -65, 'only the three complete days count');
  assert.equal(today.score, 1);
  assert.equal(today.days[3].state, 'pm_pending');
  assert.equal(today.days[4].state, 'future');

  const nextDay = amPmRowStats('thu', MON_FRI, lookup, 'bucket', '2026-10-02');
  assert.equal(nextDay.days[3].state, 'pm_missing', 'once the day is over the missing PM is flagged');
  assert.equal(nextDay.comp, -65, 'and still never credited');
});

test('a PM with no AM is left out of Comp, flagged, and still feeds the inbox average', () => {
  const lookup = buildLookup(amPm('x', [[null, 4], [3, 1], [null, null], [null, null], [null, null]]));
  const s = amPmRowStats('x', MON_FRI, lookup, 'inbox', '2026-10-02');
  assert.equal(s.days[0].state, 'am_missing');
  assert.equal(s.comp, 2);
  assert.equal(s.pmAverage, 2.5);
  assert.equal(s.score, 7.5);
});

test('an empty bucket all week scores 2 when zeros are typed, and nothing when nothing is typed', () => {
  const zeros = buildLookup(amPm('rto', [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]));
  assert.equal(amPmRowStats('rto', MON_FRI, zeros, 'bucket', '2026-10-02').score, 2, "the sheet's rule, kept for Carla");
  const blank = amPmRowStats('rto', MON_FRI, new Map(), 'bucket', '2026-10-02');
  assert.equal(blank.score, null);
  assert.equal(blank.comp, null);
});

test('section headline: buckets = mean of row scores; inbox = score of the team average; chargebacks = Comp total', () => {
  const lookup = buildLookup([
    ...amPm('a', [[10, 0], [null, null], [null, null], [null, null], [null, null]]), // comp 10 → 6
    ...amPm('b', [[3, 1], [null, null], [null, null], [null, null], [null, null]]), // comp 2 → 4
  ]);
  const buckets = amPmSectionStats(['a', 'b'], MON_FRI, lookup, 'bucket', '2026-10-02');
  assert.equal(buckets.headline, 5);
  assert.equal(buckets.compTotal, 12);
  assert.deepEqual(buckets.dayTotals[0], { date: MON_FRI[0], am: 13, pm: 1 });
  assert.deepEqual(buckets.dayTotals[1], { date: MON_FRI[1], am: null, pm: null });

  const inbox = amPmSectionStats(['a', 'b'], MON_FRI, lookup, 'inbox', '2026-10-02');
  assert.equal(inbox.teamPmAverage, 0.5);
  assert.equal(inbox.headline, 9.5);

  const cb = amPmSectionStats(['a', 'b'], MON_FRI, lookup, undefined, '2026-10-02');
  assert.equal(cb.headline, 12);
});

test("a section's totals include EVERY row (the sheet's WTD total dropped its last rep)", () => {
  const ids = ['r1', 'r2', 'r3'];
  const logs = ids.map((rowId, i) => ({ date: MON_FRI[0], rowId, points: i + 1 }));
  const s = collectionsWeekStats(ids, logs, MON_FRI);
  assert.equal(s.week.points, 6);
  assert.equal(s.byDay[0].points, 6);
});

test('collections: points and accounts per rep and day, weekend logs ignored, podium in order', () => {
  const ids = ['april', 'ruth', 'shayla', 'rick'];
  const logs = [
    { date: MON_FRI[0], rowId: 'april', points: 1 },
    { date: MON_FRI[0], rowId: 'april', points: 1 },
    { date: MON_FRI[1], rowId: 'ruth', points: 12 }, // a 12-point account
    { date: MON_FRI[2], rowId: 'shayla', points: 2 },
    { date: MON_FRI[2], rowId: 'shayla', points: 0 },
    { date: '2026-10-03', rowId: 'rick', points: 5 }, // Saturday: not on the board
    { date: MON_FRI[3], rowId: 'ghost', points: 9 }, // not a row of this section
  ];
  const s = collectionsWeekStats(ids, logs, MON_FRI);
  assert.deepEqual(s.byDay.map((d) => d.points), [2, 12, 2, 0, 0]);
  assert.deepEqual(s.byDay.map((d) => d.accounts), [2, 1, 2, 0, 0]);
  assert.deepEqual(s.week, { points: 16, accounts: 5 });
  assert.deepEqual(s.rows.get('shayla')?.week, { points: 2, accounts: 2 });
  assert.deepEqual(s.podium, [
    { rowId: 'ruth', points: 12 },
    { rowId: 'april', points: 2 },
    { rowId: 'shayla', points: 2 },
  ]);
  assert.equal(s.rows.get('rick')?.week.points, 0);
});

test('collections history: all-time per rep and the record team week', () => {
  const logs = [
    { date: '2026-09-21', rowId: 'a', points: 30 },
    { date: '2026-09-22', rowId: 'b', points: 99 },
    { date: '2026-09-28', rowId: 'a', points: 50 },
    { date: '2026-09-29', rowId: 'b', points: 1.5 },
  ];
  const h = collectionsHistory(logs);
  assert.equal(h.allTimeByRow.get('a'), 80);
  assert.equal(h.allTimeByRow.get('b'), 100.5);
  assert.deepEqual(h.record, { weekStart: '2026-09-20', points: 129 });
  assert.equal(collectionsHistory([]).record, null);
});

test('daily sections: week sums, PM Buckets averages and meetings', () => {
  const lookup = buildLookup([
    { rowId: 'adrian', date: MON_FRI[0], slot: 'day', value: 3 },
    { rowId: 'adrian', date: MON_FRI[1], slot: 'day', value: 2 },
    { rowId: 'adrian', date: MON_FRI[1], slot: 'mtg', value: 1 },
    { rowId: 'adrian', date: MON_FRI[2], slot: 'mtg', value: 0 },
    { rowId: 'audrey', date: MON_FRI[0], slot: 'day', value: 1 },
  ]);
  const s = dailySectionStats(['adrian', 'audrey'], MON_FRI, lookup);
  assert.equal(s.rows.get('adrian')?.week, 5);
  assert.equal(s.rows.get('adrian')?.average, 2.5);
  assert.equal(s.rows.get('adrian')?.meetings, 1);
  assert.deepEqual(s.rows.get('adrian')?.met, [null, true, false, null, null]);
  assert.deepEqual(s.dayTotals, [4, 2, null, null, null]);
  assert.deepEqual(s.meetingsByDay, [0, 1, 0, 0, 0]);
  assert.equal(s.weekTotal, 6);
  assert.equal(s.averageTotal, 3.5);
});

test('payroll timing: hours from start/end, an end before the start is shown but never counted', () => {
  const days = ['2026-09-27', '2026-09-28'];
  const lookup = buildLookup([
    { rowId: 'p', date: days[0], slot: 'start', value: 9 * 60 },
    { rowId: 'p', date: days[0], slot: 'end', value: 17 * 60 + 30 },
    { rowId: 'p', date: days[1], slot: 'start', value: 14 * 60 },
    { rowId: 'p', date: days[1], slot: 'end', value: 13 * 60 },
  ]);
  const s = timeSpanSectionHours(['p'], days, lookup);
  assert.equal(s.rows.get('p')?.days[0].hours, 8.5);
  assert.equal(s.rows.get('p')?.days[1].invalid, true);
  assert.equal(s.rows.get('p')?.days[1].hours, null);
  assert.equal(s.total, 8.5);
});

test('clock helpers round-trip', () => {
  assert.equal(minutesToClock(545), '9:05 AM');
  assert.equal(minutesToClock(0), '12:00 AM');
  assert.equal(minutesToClock(12 * 60), '12:00 PM');
  assert.equal(timeInputToMinutes('17:30'), 1050);
  assert.equal(timeInputToMinutes('24:00'), null);
  assert.equal(minutesToTimeInput(1050), '17:30');
  assert.equal(minutesToTimeInput(null), '');
});

test('goals: at least vs below, and nothing to judge yet', () => {
  const collections = sectionDef('collections').goal;
  const problems = sectionDef('payroll_problems').goal;
  assert.equal(goalMet(collections, 85), true);
  assert.equal(goalMet(collections, 84.5), false);
  assert.equal(goalMet(problems, 19), true);
  assert.equal(goalMet(problems, 20), false, '"< 20" is strictly below');
  assert.equal(goalMet(problems, null), null);
  assert.equal(goalMet(undefined, 5), null);
  assert.equal(goalText(collections!), '≥ 85 points');
  assert.equal(goalText(problems!), '< 20 problems');
});
