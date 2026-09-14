/**
 * Week-scoping the recently-offboarded list. The module had no test at all
 * before 2026-09-14, which is how two fail-open branches survived as long as
 * they did: nothing described the intended behaviour except the branches.
 *
 * The anchor is Carla, 2026-09-14: "If I was offboarded today, I should be on
 * the list next week, but then after that I am gone."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offboardedRelevantToWeek, type OffboardedWeekEvidence } from './offboarded-week-relevance';

/** Pay weeks are Sunday-anchored. */
const W_AUG_30 = '2026-08-30';
const W_SEP_06 = '2026-09-06';
const W_SEP_13 = '2026-09-13';
const W_SEP_20 = '2026-09-20';

const who = (off: string | null, hours: string[] = []): OffboardedWeekEvidence => ({
  off_boarded_at: off,
  hours_week_starts: hours,
});

test("Carla's rule end to end: offboarded Monday 2026-09-14", () => {
  // Stamped 09-14. Payroll is a week in arrears, so the run happening now pays
  // 09-06 and the next one pays 09-13 — both still owe them.
  const leaver = who('2026-09-14', ['2026-09-06', '2026-09-13']);
  assert.equal(offboardedRelevantToWeek(leaver, W_SEP_06), true, 'the week being scored now');
  assert.equal(offboardedRelevantToWeek(leaver, W_SEP_13), true, 'the part-week they were stamped in');
  assert.equal(offboardedRelevantToWeek(leaver, W_SEP_20), false, '"but then after that I am gone"');
});

test('stamped BEFORE the week began — already paid out in an earlier run', () => {
  assert.equal(offboardedRelevantToWeek(who('2026-09-05'), W_SEP_06), false);
  assert.equal(offboardedRelevantToWeek(who('2026-06-01'), W_SEP_06), false);
});

test('stamped ON the first day of the week is kept (inclusive lower bound)', () => {
  assert.equal(offboardedRelevantToWeek(who(W_SEP_06), W_SEP_06), true);
});

test('the upper bound is ONE payroll cycle past the week end, inclusive', () => {
  // Week 2026-09-06 ends 09-12 and is paid during 09-13..09-19, so 09-19 is the
  // last stamp that still owes it.
  assert.equal(offboardedRelevantToWeek(who('2026-09-19'), W_SEP_06), true);
  assert.equal(offboardedRelevantToWeek(who('2026-09-20'), W_SEP_06), false);
});

test('a leaver does not reappear on every older week', () => {
  // The old rule was `off >= weekStart` with no upper bound, so a September
  // stamp was offered for every week back to June.
  const sept = who('2026-09-14');
  // 2026-08-30 ends 09-05 and was paid out before they left.
  assert.equal(offboardedRelevantToWeek(sept, W_AUG_30), false);
  assert.equal(offboardedRelevantToWeek(sept, '2026-06-21'), false);
});

test('hours in the scored week keep someone whose stamp says otherwise', () => {
  // A late or early stamp must never hide somebody who demonstrably worked the
  // week being paid.
  assert.equal(offboardedRelevantToWeek(who('2026-06-01', [W_SEP_06]), W_SEP_06), true);
});

test('the hours test is MEMBERSHIP, not ">= the newest week"', () => {
  // The old rule compared the newest hours week with `>=`, so hours in W+1
  // vouched for W — something the timesheet never said.
  const workedLaterOnly = who(null, [W_SEP_13]);
  assert.equal(offboardedRelevantToWeek(workedLaterOnly, W_SEP_13), true, 'the week they worked');
  assert.equal(offboardedRelevantToWeek(workedLaterOnly, W_SEP_06), false, 'a week they did not');
});

test('NO evidence at all is no longer a free pass on every week', () => {
  // The removed fail-open kept an undated, hours-less person on every week
  // forever. The recovery path is Add External Member, which is unscoped.
  const nothing = who(null, []);
  for (const w of [W_AUG_30, W_SEP_06, W_SEP_13, W_SEP_20]) {
    assert.equal(offboardedRelevantToWeek(nothing, w), false, w);
  }
  assert.equal(offboardedRelevantToWeek({ off_boarded_at: null }, W_SEP_06), false, 'undefined hours');
  assert.equal(offboardedRelevantToWeek({ off_boarded_at: null, hours_week_starts: null }, W_SEP_06), false);
});

test('an unresolved week disables scoping entirely — never filters on a guess', () => {
  // Both calculators pass `weekResolved ? weekStart : ''`; the Monday
  // local-clock seed must never be used as a filter.
  const leaver = who('2026-09-14');
  assert.equal(offboardedRelevantToWeek(leaver, ''), true);
  assert.equal(offboardedRelevantToWeek(who(null, []), ''), true);
  assert.equal(offboardedRelevantToWeek(leaver, 'not-a-date'), true);
});

test('an impossible stamp cannot vouch for a week', () => {
  // franm@'s 2027-04-20 year-typo satisfied `off >= weekStart` for years. The
  // list sanitizes upstream; this is the second lock, and it also refuses a
  // date that is merely shaped right.
  assert.equal(offboardedRelevantToWeek(who('2026-13-40'), W_SEP_06), false);
  assert.equal(offboardedRelevantToWeek(who('2026-02-31'), W_SEP_06), false);
  assert.equal(offboardedRelevantToWeek(who('2027-04-20'), W_SEP_06), false, 'and it is out of the window anyway');
});

test('a timestamp is read by its day prefix', () => {
  assert.equal(offboardedRelevantToWeek(who('2026-09-14T03:22:11.000Z'), W_SEP_06), true);
});

test('hours and stamp disagree: either one alone is enough', () => {
  assert.equal(offboardedRelevantToWeek(who('2026-09-14', []), W_SEP_06), true, 'stamp only');
  assert.equal(offboardedRelevantToWeek(who(null, [W_SEP_06]), W_SEP_06), true, 'hours only');
});
