/** Run: node --import tsx --test src/lib/accounting-scoreboard/meeting-pills.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { datesFor } from './week';
import {
  STREAK_AMBER_DAYS,
  dayName,
  meetingDaysOf,
  pillsCaption,
  pillAriaLabel,
  pillText,
  streakHeadline,
  streakIsLong,
  weekMeetingPills,
  type MeetingPillState,
} from './meeting-pills';

// Carla, 2026-10-07: "Can you make this prettier? Just like we want it to be like, yes, five days, no
// meeting. Keep it going, guys." Kane: "date pills". Display only: the streak is still noMeetingStreak.

const MON_FRI = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
const WEEK_OF_OCT_4 = datesFor('2026-10-04', MON_FRI);

test('Mon–Fri pills: clear, meeting, today, and the days still ahead', () => {
  const pills = weekMeetingPills(WEEK_OF_OCT_4, new Set(['2026-10-06']), '2026-10-07');
  assert.deepEqual(pills, [
    { day: '2026-10-05', state: 'clear', isToday: false },
    { day: '2026-10-06', state: 'meeting', isToday: false },
    { day: '2026-10-07', state: 'clear', isToday: true },
    { day: '2026-10-08', state: 'future', isToday: false },
    { day: '2026-10-09', state: 'future', isToday: false },
  ]);
});

test('a past week has no future pills and no today', () => {
  const pills = weekMeetingPills(datesFor('2026-09-27', MON_FRI), new Set(), '2026-10-07');
  assert.ok(pills.every((p) => p.state === 'clear' && !p.isToday));
});

test('a meeting ticked today turns today\'s pill into a meeting', () => {
  const pills = weekMeetingPills(WEEK_OF_OCT_4, new Set(['2026-10-07']), '2026-10-07');
  assert.deepEqual(pills[2], { day: '2026-10-07', state: 'meeting', isToday: true });
});

test('on a weekend the whole Mon–Fri is decided', () => {
  const pills = weekMeetingPills(WEEK_OF_OCT_4, new Set(), '2026-10-10');
  assert.ok(pills.every((p) => p.state === 'clear' && !p.isToday));
});

test('a week that has not started is all ahead', () => {
  const pills = weekMeetingPills(datesFor('2026-10-11', MON_FRI), new Set(['2026-10-12']), '2026-10-07');
  assert.ok(pills.every((p) => p.state === 'future'));
});

test('the pills follow the section\'s own days, not a hard-coded Mon–Fri', () => {
  const pills = weekMeetingPills(datesFor('2026-10-04', ['tue', 'fri']), new Set(), '2026-10-10');
  assert.deepEqual(pills.map((p) => p.day), ['2026-10-06', '2026-10-09']);
});

test('meetingDaysOf: a day counts when at least one PM was ticked "met"', () => {
  const days = meetingDaysOf(WEEK_OF_OCT_4, [0, 2, 0, 1, 0]);
  assert.deepEqual([...days].sort(), ['2026-10-06', '2026-10-08']);
});

test('meetingDaysOf refuses arrays that do not line up', () => {
  assert.throws(() => meetingDaysOf(WEEK_OF_OCT_4, [0, 1]), /line up/);
});

test('colour is never the only signal: every state has its own word', () => {
  const states: MeetingPillState[] = ['clear', 'meeting', 'future'];
  const words = states.map(pillText);
  assert.equal(new Set(words).size, states.length);
  assert.ok(words.every((w) => w.trim().length > 0));
});

test('aria-labels say the weekday, the date and the state', () => {
  assert.equal(pillAriaLabel({ day: '2026-10-05', state: 'clear', isToday: false }), 'Mon Oct 5: no meeting');
  assert.equal(pillAriaLabel({ day: '2026-10-06', state: 'meeting', isToday: false }), 'Tue Oct 6: meeting');
  assert.equal(pillAriaLabel({ day: '2026-10-08', state: 'future', isToday: false }), 'Thu Oct 8: still ahead');
  assert.equal(pillAriaLabel({ day: '2026-10-07', state: 'clear', isToday: true }), 'Wed Oct 7, today: no meeting so far');
  assert.equal(pillAriaLabel({ day: '2026-10-07', state: 'meeting', isToday: true }), 'Wed Oct 7, today: meeting');
});

const sentence = (h: { lead: string; sep: string; rest: string }) => `${h.lead}${h.sep}${h.rest}`;

test("the headline is Carla's sentence, with the number from noMeetingStreak", () => {
  assert.equal(sentence(streakHeadline(5)), '5 days, no meeting. Keep it going!');
  assert.equal(sentence(streakHeadline(1)), '1 day, no meeting. Keep it going!');
  assert.equal(streakHeadline(5).lead, '5 days');
});

test('a meeting ticked today never reads "0 days, no meeting"', () => {
  const s = sentence(streakHeadline(0));
  assert.doesNotMatch(s, /0 days|no meeting\. Keep/);
  assert.equal(s, 'Meeting today. The streak starts again tomorrow.');
});

test('never ticked stays "—" (the doc\'s rule), never 0', () => {
  const h = streakHeadline(null);
  assert.equal(h.lead, '—');
  assert.equal(sentence(h), '— No meeting has been ticked yet.');
});

test('dayName reads "Fri Oct 2" for the last-meeting line', () => {
  assert.equal(dayName('2026-10-02'), 'Fri Oct 2');
  assert.equal(dayName('2026-12-31'), 'Thu Dec 31');
});

test('the pills say which week they show: "This week" through Saturday, else its range', () => {
  assert.equal(pillsCaption('2026-10-04', '2026-10-07'), 'This week');
  assert.equal(pillsCaption('2026-10-04', '2026-10-10'), 'This week');
  assert.equal(pillsCaption('2026-09-27', '2026-10-07'), 'Sep 28 – Oct 2, 2026');
});

test('amber once a week has gone by: the existing rule, >= 7', () => {
  assert.equal(STREAK_AMBER_DAYS, 7);
  assert.equal(streakIsLong(null), false);
  assert.equal(streakIsLong(6), false);
  assert.equal(streakIsLong(7), true);
  assert.equal(streakIsLong(30), true);
});

/* ── Source pins: SectionGrid renders through this module ─────────────────── */

const GRID = readFileSync(
  join(process.cwd(), 'src', 'components', 'accounting-scoreboard', 'SectionGrid.tsx'),
  'utf8',
);

test('the streak is still computed by noMeetingStreak, never stored or re-derived', () => {
  assert.match(GRID, /noMeetingStreak\(lastMeetingDate, today\)/);
});

test('the grid builds its pills from this week\'s ticks through this module', () => {
  assert.match(GRID, /weekMeetingPills\(/);
  assert.match(GRID, /meetingDaysOf\(/);
  assert.match(GRID, /pillAriaLabel\(/);
});

test('the amber rule lives in one place', () => {
  assert.match(GRID, /streakIsLong\(/);
  assert.doesNotMatch(GRID, />=\s*7/);
});

test('the pills\' motion is gated on reduced motion', () => {
  assert.match(GRID, /useReducedMotion\(/);
});
