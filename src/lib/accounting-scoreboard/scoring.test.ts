/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/scoring.test.ts
 *
 * Fixtures are the live sheet's own numbers (read 2026-10-01, week Sep 28 – Oct 2), so a change
 * to the math has to be argued against what the team sees today.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amountCountSectionStats,
  amPmRowStats,
  amPmSectionStats,
  buildLookup,
  clearedFromReadings,
  collectionsHistory,
  collectionsWeekStats,
  dailySectionStats,
  daysBetween,
  goalMet,
  goalText,
  inboxScore,
  minutesToClock,
  minutesToTimeInput,
  noMeetingStreak,
  problemsWeekStats,
  round2,
  timeInputToMinutes,
  timeSpanSectionHours,
  UNTYPED_PROBLEMS,
  winRatio,
  type AmPmRowMeta,
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

test("inboxScore is the sheet's =IF(avg=0,10,IF(avg>=9,1,10-avg))", () => {
  assert.equal(inboxScore(0), 10);
  assert.equal(inboxScore(9), 1);
  assert.equal(inboxScore(17), 1);
  assert.equal(round2(inboxScore(5 / 3)), 8.33, "Tieg's row: PMs 2, 3, 0 → 8.3");
});


const row = (id: string, over: Partial<AmPmRowMeta> = {}): AmPmRowMeta => ({ id, bucketDay: null, dueSoon: false, ...over });

/** Carla's reference code from "SCOREBOARD UPDATES" (2026-10-02), verbatim, as the oracle. */
function carlaReference(cells: Array<number | '' | null | undefined>): number | null {
  const readings = cells.filter((v) => v !== '' && v != null) as number[];
  let completed = 0;
  for (let i = 1; i < readings.length; i++) completed += Math.max(0, readings[i - 1] - readings[i]);
  const open = readings.at(-1)!;
  const score = completed + open === 0 ? null : +((10 * completed) / (completed + open)).toFixed(1);
  return score;
}

test('clearedFromReadings is Carla\'s reference code: decreases count (overnight too), increases never do', () => {
  // Mon AM 10 → PM 4 (−6), overnight → Tue AM 9 (+5, new work: not against it), → PM 2 (−7): completed 13, open 2.
  assert.deepEqual(clearedFromReadings([10, 4, 9, 2]), { completed: 13, open: 2, score: 8.7 });
  assert.equal(clearedFromReadings([10, 4, 9, 2])?.score, carlaReference([10, 4, 9, 2]));
  // 80% cleared = 8.0, which meets the goal of 8.
  assert.equal(clearedFromReadings([10, 2])?.score, 8);
  // Rising all week: nothing completed, everything open → 0 (not N/A).
  assert.deepEqual(clearedFromReadings([1, 3, 5]), { completed: 0, open: 5, score: 0 });
  // 0 all week → N/A (null), left out of the overall.
  assert.deepEqual(clearedFromReadings([0, 0, 0, 0]), { completed: 0, open: 0, score: null });
  assert.equal(carlaReference([0, 0, 0, 0]), null);
  // Nothing typed → no stats at all ("—", not N/A).
  assert.equal(clearedFromReadings([]), null);
});

test('the score matches the reference on every shape, with 2-decimal readings too', () => {
  const cases: number[][] = [
    [7, 76, 81, 0, 0, 0, 0, 0],
    [1, 1, 1, 5, 5, 66, 68],
    [23, 20, 25, 18, 30, 12, 12, 0, 4, 1],
    [94, 0],
    [3.5, 1.25, 2.75, 0.5],
    [5],
  ];
  for (const c of cases) assert.equal(clearedFromReadings(c)?.score ?? null, carlaReference(c), JSON.stringify(c));
});

test('a blank reading is SKIPPED, never read as 0 (the sheet credited a whole AM as cleared)', () => {
  // Thurs (Collections) on Oct 1: 1/1, 1/5, 5/66, then Thu AM 68 with no PM yet. The sheet showed +68.
  const lookup = buildLookup(amPm('thu', [[1, 1], [1, 5], [5, 66], [68, null], [null, null]]));
  const s = amPmRowStats(row('thu'), MON_FRI, lookup, 'cleared', THU);
  assert.equal(s.completed, 0, 'every reading rose: nothing completed, and no blank PM was read as 0');
  assert.equal(s.open, 68);
  assert.equal(s.score, 0);
  assert.equal(s.days[3].state, 'pm_pending');
  assert.equal(s.days[4].state, 'future');
  // The overnight drop across a missing PM is measured between two typed numbers only.
  const gap = buildLookup(amPm('b', [[50, null], [40, 30], [null, null], [null, null], [null, null]]));
  const g = amPmRowStats(row('b'), MON_FRI, gap, 'cleared', '2026-10-02');
  assert.equal(g.completed, 20, 'Mon AM 50 → Tue AM 40 → Tue PM 30; the blank Mon PM is skipped');
  assert.equal(g.days[0].state, 'pm_missing', 'the missing PM is still flagged on screen');
  assert.equal(g.score, carlaReference([50, '', 40, 30]));
});

test('a bucket that was 0 all week is N/A; nothing typed is empty; neither is a number', () => {
  const zeros = buildLookup(amPm('rto', [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]));
  const z = amPmRowStats(row('rto'), MON_FRI, zeros, 'cleared', '2026-10-02');
  assert.equal(z.status, 'na');
  assert.equal(z.score, null);
  const blank = amPmRowStats(row('rto'), MON_FRI, new Map(), 'cleared', '2026-10-02');
  assert.equal(blank.status, 'empty');
  assert.equal(blank.score, null);
  assert.equal(blank.completed, null);
});

test("a weekday Collections bucket is Pending until its own day's PM is in, then scored", () => {
  // Wed (Collections): fills Mon/Tue, worked on Wed.
  const before = buildLookup(amPm('wed', [[0, 20], [20, 45], [45, null], [null, null], [null, null]]));
  const pending = amPmRowStats(row('wed', { bucketDay: 'wed' }), MON_FRI, before, 'cleared', '2026-09-30');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.score, null);
  const monday = amPmRowStats(row('wed', { bucketDay: 'wed' }), MON_FRI, new Map(), 'cleared', '2026-09-28');
  assert.equal(monday.status, 'pending', 'still Pending before anything is typed, while its day is ahead');

  const after = buildLookup(amPm('wed', [[0, 20], [20, 45], [45, 3], [null, null], [null, null]]));
  const scored = amPmRowStats(row('wed', { bucketDay: 'wed' }), MON_FRI, after, 'cleared', '2026-09-30');
  assert.equal(scored.status, 'scored');
  assert.equal(scored.completed, 42);
  assert.equal(scored.score, carlaReference([0, 20, 20, 45, 45, 3]));

  const missed = amPmRowStats(row('wed', { bucketDay: 'wed' }), MON_FRI, before, 'cleared', '2026-10-02');
  assert.equal(missed.status, 'pm_missing', 'its day is over with no PM: not Pending any more, still not scored');
  assert.equal(missed.score, null);
});

test("Buckets' overall = 10 × Σ completed ÷ Σ(completed + open) over the scored buckets only", () => {
  const lookup = buildLookup([
    ...amPm('a', [[10, 0], [null, null], [null, null], [null, null], [null, null]]), // completed 10, open 0
    ...amPm('b', [[3, 1], [null, null], [null, null], [null, null], [null, null]]), // completed 2, open 1
    ...amPm('z', [[0, 0], [0, 0], [null, null], [null, null], [null, null]]), // N/A
    ...amPm('w', [[9, 9], [9, null], [null, null], [null, null], [null, null]]), // Tue bucket, Tue PM missing → pending today
  ]);
  const rows = [row('a'), row('b'), row('z'), row('w', { bucketDay: 'tue' })];
  const s = amPmSectionStats(rows, MON_FRI, lookup, 'cleared', '2026-09-29');
  assert.equal(s.rows.get('w')?.status, 'pending');
  assert.equal(s.completedTotal, 12);
  assert.equal(s.openTotal, 1);
  assert.equal(s.headline, 9.2, '10 × 12 ÷ 13, not the average of the row scores (10 and 6.7)');
  assert.deepEqual(s.dayTotals[0], { date: MON_FRI[0], am: 22, pm: 10 });

  const inbox = amPmSectionStats([row('a'), row('b')], MON_FRI, lookup, 'inbox', '2026-10-02');
  assert.equal(inbox.teamPmAverage, 0.5);
  assert.equal(inbox.headline, 9.5);

  const none = amPmSectionStats([row('z')], MON_FRI, lookup, 'cleared', '2026-10-02');
  assert.equal(none.headline, null, 'no scored bucket: no overall');
});

test('a PM with no AM still feeds the inbox average', () => {
  const lookup = buildLookup(amPm('x', [[null, 4], [3, 1], [null, null], [null, null], [null, null]]));
  const s = amPmRowStats(row('x'), MON_FRI, lookup, 'inbox', '2026-10-02');
  assert.equal(s.days[0].state, 'am_missing');
  assert.equal(s.pmAverage, 2.5);
  assert.equal(s.score, 7.5);
});

test('Open Disputes: the headline is open now; the "due in 7 days" line is called out, never added to it', () => {
  const lookup = buildLookup([
    ...amPm('open', [[7, 6], [8, 7], [null, null], [null, null], [null, null]]),
    ...amPm('due', [[3, 2], [4, 3], [null, null], [null, null], [null, null]]),
  ]);
  const s = amPmSectionStats([row('open'), row('due', { dueSoon: true })], MON_FRI, lookup, undefined, '2026-09-30');
  assert.equal(s.openNow, 7);
  assert.equal(s.dueSoonNow, 3);
  assert.equal(s.headline, 7);
  const empty = amPmSectionStats([row('open')], MON_FRI, new Map(), undefined, '2026-09-30');
  assert.equal(empty.headline, null, 'nothing typed is not 0 open');
});

test('Chargeback Outcomes: $ and # per outcome per day, week totals per outcome', () => {
  const lookup = buildLookup([
    { rowId: 'wins', date: MON_FRI[0], slot: 'usd', value: 99 },
    { rowId: 'wins', date: MON_FRI[0], slot: 'count', value: 1 },
    { rowId: 'wins', date: MON_FRI[2], slot: 'usd', value: 150.5 },
    { rowId: 'wins', date: MON_FRI[2], slot: 'count', value: 2 },
    { rowId: 'losses', date: MON_FRI[1], slot: 'count', value: 0 },
  ]);
  const s = amountCountSectionStats(['wins', 'losses', 'prearb'], MON_FRI, lookup);
  assert.deepEqual(s.rows.get('wins')?.usd, [99, null, 150.5, null, null]);
  assert.equal(s.rows.get('wins')?.weekUsd, 249.5);
  assert.equal(s.rows.get('wins')?.weekCount, 3);
  assert.equal(s.rows.get('losses')?.weekCount, 0, 'a typed 0 is a real 0');
  assert.equal(s.rows.get('losses')?.weekUsd, null);
  assert.equal(s.rows.get('prearb')?.weekCount, null);
  assert.equal(s.weekCount, 3);
});

test('Payroll Problems: log lines add up per person and day; the old grid counts as "No type"; nothing is —', () => {
  const lookup = buildLookup([
    { rowId: 'grace', date: MON_FRI[0], slot: 'day', value: 4 }, // typed into the old grid
    { rowId: 'carla', date: MON_FRI[0], slot: 'day', value: 0 }, // a typed 0 is a real 0
  ]);
  const logs = [
    { date: MON_FRI[0], rowId: 'grace', typeId: 'acct', count: 2 },
    { date: MON_FRI[1], rowId: 'grace', typeId: 'score', count: 1 },
    { date: MON_FRI[1], rowId: 'carla', typeId: 'acct', count: 51 },
    { date: '2026-10-03', rowId: 'grace', typeId: 'acct', count: 9 }, // Saturday: not on the board
    { date: MON_FRI[2], rowId: 'ghost', typeId: 'acct', count: 9 }, // not a row of this section
  ];
  const s = problemsWeekStats(['grace', 'carla', 'alivia'], logs, lookup, MON_FRI);
  assert.deepEqual(s.rows.get('grace')?.byDay, [6, 1, null, null, null]);
  assert.deepEqual(s.rows.get('carla')?.byDay, [0, 51, null, null, null]);
  assert.equal(s.rows.get('alivia')?.week, null);
  assert.deepEqual(s.byDay, [6, 52, null, null, null]);
  assert.equal(s.week, 58);
  assert.deepEqual(s.byType, [
    { typeId: 'acct', count: 53 },
    { typeId: UNTYPED_PROBLEMS, count: 4 },
    { typeId: 'score', count: 1 },
  ]);
  assert.equal(problemsWeekStats(['alivia'], [], new Map(), MON_FRI).week, null, 'nothing logged is not 0 problems');
});

test('No Meeting Streak: calendar days since any meeting was ticked; 0 on the day; none ever = null', () => {
  assert.equal(noMeetingStreak('2026-10-02', '2026-10-06'), 4);
  assert.equal(noMeetingStreak('2026-10-06', '2026-10-06'), 0);
  assert.equal(noMeetingStreak('2026-09-22', '2026-10-06'), 14, 'across weeks: it never resets on a Monday');
  assert.equal(noMeetingStreak(null, '2026-10-06'), null);
  assert.equal(daysBetween('2026-02-27', '2026-03-02'), 3);
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

test("collections history from the weekly view's rows equals the history from every line", () => {
  // server.ts reads accounting_scoreboard_collection_weeks (one row per rep row and Sunday week),
  // not every log line. Feeding a week's Sunday as the date must give the same All Time and record.
  const lines = [
    { date: '2026-09-21', rowId: 'a', points: 1 },
    { date: '2026-09-25', rowId: 'a', points: 12 },
    { date: '2026-09-22', rowId: 'b', points: 2 },
    { date: '2026-09-28', rowId: 'a', points: 3 },
    { date: '2026-10-02', rowId: 'b', points: 14 },
  ];
  const weekRows = [
    { date: '2026-09-20', rowId: 'a', points: 13 },
    { date: '2026-09-20', rowId: 'b', points: 2 },
    { date: '2026-09-27', rowId: 'a', points: 3 },
    { date: '2026-09-27', rowId: 'b', points: 14 },
  ];
  const fromLines = collectionsHistory(lines);
  const fromWeeks = collectionsHistory(weekRows);
  assert.deepEqual([...fromWeeks.allTimeByRow].sort(), [...fromLines.allTimeByRow].sort());
  assert.deepEqual(fromWeeks.record, fromLines.record);
  assert.deepEqual(fromWeeks.record, { weekStart: '2026-09-27', points: 17 });
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

test('Open Disputes scored like Buckets (Carla, 2026-10-07): the "due in 7 days" line is called out, never scored, never in the overall or a Day total', () => {
  const lookup = buildLookup([
    ...amPm('open', [[10, 8], [9, 6], [null, null], [null, null], [null, null]]),
    ...amPm('due', [[3, 2], [4, 3], [null, null], [null, null], [null, null]]),
  ]);
  const s = amPmSectionStats([row('open'), row('due', { dueSoon: true })], MON_FRI, lookup, 'cleared', '2026-09-30');
  // Readings 10, 8, 9, 6: completed 2 + 3 (8 → 9 is new work), open 6 → 10 × 5 ÷ 11 = 4.5.
  assert.equal(s.rows.get('open')?.score, carlaReference([10, 8, 9, 6]));
  assert.equal(s.rows.get('open')?.score, 4.5);
  assert.equal(s.rows.get('due')?.status, 'due_soon');
  assert.equal(s.rows.get('due')?.score, null);
  assert.equal(s.rows.get('due')?.open, 3, 'its readings still show');
  assert.equal(s.completedTotal, 5);
  assert.equal(s.openTotal, 6);
  assert.equal(s.headline, 4.5, 'the due-soon line is not in the overall');
  assert.equal(s.openNow, 6);
  assert.equal(s.dueSoonNow, 3);
  assert.deepEqual(
    s.dayTotals.slice(0, 2).map((d) => [d.am, d.pm]),
    [
      [10, 8],
      [9, 6],
    ],
    'Day totals leave the due-soon line out: it is part of open',
  );
  const onlyDue = amPmSectionStats([row('due', { dueSoon: true })], MON_FRI, lookup, 'cleared', '2026-09-30');
  assert.equal(onlyDue.headline, null, 'no scored line = no score, never a 0');
});

test('win ratio (Carla, 2026-10-07): wins ÷ (wins + losses) by COUNT, flagged lines only, absence is never 0%', () => {
  const lookup = buildLookup([
    { rowId: 'wins', date: MON_FRI[0], slot: 'count', value: 2 },
    { rowId: 'wins', date: MON_FRI[0], slot: 'usd', value: 5000 },
    { rowId: 'wins', date: MON_FRI[2], slot: 'count', value: 1 },
    { rowId: 'losses', date: MON_FRI[1], slot: 'count', value: 1 },
    { rowId: 'losses', date: MON_FRI[1], slot: 'usd', value: 10 },
    { rowId: 'prearb', date: MON_FRI[1], slot: 'count', value: 9 },
  ]);
  const rows = [row('wins', { outcome: 'win' }), row('losses', { outcome: 'loss' }), row('prearb', { outcome: null })];
  assert.deepEqual(winRatio(rows, MON_FRI, lookup), { won: 3, lost: 1, ratio: 75 }, 'Pre-arb is not decided; dollars never weigh in');
  assert.equal(winRatio(rows.map((r) => ({ ...r, outcome: null })), MON_FRI, lookup).ratio, null, 'nothing flagged = nothing decided');
  assert.deepEqual(winRatio(rows, MON_FRI, new Map()), { won: null, lost: null, ratio: null });
  const zeros = buildLookup([
    { rowId: 'wins', date: MON_FRI[0], slot: 'count', value: 0 },
    { rowId: 'losses', date: MON_FRI[0], slot: 'count', value: 0 },
  ]);
  assert.deepEqual(winRatio(rows, MON_FRI, zeros), { won: 0, lost: 0, ratio: null }, '0 of 0 decided is not 0%');
  const third = buildLookup([
    { rowId: 'wins', date: MON_FRI[0], slot: 'count', value: 1 },
    { rowId: 'losses', date: MON_FRI[0], slot: 'count', value: 2 },
  ]);
  assert.equal(winRatio(rows, MON_FRI, third).ratio, 33.3);
  const allLost = buildLookup([{ rowId: 'losses', date: MON_FRI[0], slot: 'count', value: 2 }]);
  assert.deepEqual(winRatio(rows, MON_FRI, allLost), { won: null, lost: 2, ratio: 0 }, 'all lost is a real 0%');
  const twoWinLines = [...rows, row('wins2', { outcome: 'win' })];
  const more = buildLookup([
    { rowId: 'wins', date: MON_FRI[0], slot: 'count', value: 1 },
    { rowId: 'wins2', date: MON_FRI[0], slot: 'count', value: 1 },
    { rowId: 'losses', date: MON_FRI[0], slot: 'count', value: 2 },
  ]);
  assert.equal(winRatio(twoWinLines, MON_FRI, more).ratio, 50, 'every line marked "win" counts');
});

test('Payroll Problems: a logged 0 is a real 0 problems (Kane, 2026-10-07); nothing logged is still —', () => {
  const zero = problemsWeekStats(['p'], [{ date: MON_FRI[0], rowId: 'p', typeId: 't', count: 0 }], new Map(), MON_FRI);
  assert.equal(zero.week, 0);
  assert.deepEqual(zero.rows.get('p')?.byDay, [0, null, null, null, null]);
  assert.equal(problemsWeekStats(['p'], [], new Map(), MON_FRI).week, null);
});
