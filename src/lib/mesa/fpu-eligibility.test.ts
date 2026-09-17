import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addCalendarMonths, fpuEligibleFrom, fpuVerdict, parseRosterStartDate, type FpuVerdictInput } from './fpu-eligibility';

// Kane, 2026-09-16: "3 months of service from Start date. so even if they miss
// 1 day thats already unqualified." Measured at CLASS START (ruling Q2 → a).

const CLASS = { opens_on: '2026-09-01', closes_on: '2026-09-30', class_starts_on: '2026-10-08' };

const base: FpuVerdictInput = {
  today: '2026-09-15',
  cls: CLASS,
  onActiveRoster: true,
  startDate: '2026-01-05',
  alreadyCompletedFpu: false,
  existingStatus: null,
};

// ── parseRosterStartDate ────────────────────────────────────────────────────

test('parses the roster date shapes and refuses garbage', () => {
  assert.equal(parseRosterStartDate('2026-07-08'), '2026-07-08');
  assert.equal(parseRosterStartDate('2026-07-08T00:00:00.000Z'), '2026-07-08');
  assert.equal(parseRosterStartDate('7/8/26'), '2026-07-08');
  assert.equal(parseRosterStartDate('07/08/2026'), '2026-07-08');
  assert.equal(parseRosterStartDate('  '), null);
  assert.equal(parseRosterStartDate(null), null);
  assert.equal(parseRosterStartDate('not a date'), null);
  assert.equal(parseRosterStartDate('2026-02-30'), null);
  assert.equal(parseRosterStartDate('13/40/26'), null);
});

// ── tenure arithmetic ───────────────────────────────────────────────────────

test('three calendar months, month-end clamped', () => {
  assert.equal(addCalendarMonths('2026-06-16', 3), '2026-09-16');
  assert.equal(addCalendarMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(addCalendarMonths('2027-11-30', 3), '2028-02-29');
  assert.equal(addCalendarMonths('2026-12-31', 3), '2027-03-31');
  assert.equal(fpuEligibleFrom('2026-07-08'), '2026-10-08');
});

// ── the verdict ─────────────────────────────────────────────────────────────

test('eligible: on roster, tenure met by class start, window open', () => {
  const v = fpuVerdict(base);
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.startDate, '2026-01-05');
    assert.equal(v.eligibleFrom, '2026-04-05');
  }
});

test('ONE DAY short of three months at class start is ineligible', () => {
  // Class starts 2026-10-08. Start 2026-07-08 → eligible from 10-08 → OK.
  assert.equal(fpuVerdict({ ...base, startDate: '2026-07-08' }).ok, true);
  // Start 2026-07-09 → eligible from 10-09 → one day late → refused.
  const v = fpuVerdict({ ...base, startDate: '2026-07-09' });
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.reason, 'tenure');
    assert.equal(v.eligibleFrom, '2026-10-09');
    assert.match(v.detail, /Oct 9, 2026/);
  }
});

test('tenure is measured at CLASS START, not today — the verdict is fixed for the window', () => {
  // Today 09-15, start 08-01: tenure not met TODAY but met by class start 10-08? 08-01+3 = 11-01 > 10-08 → no.
  assert.equal(fpuVerdict({ ...base, startDate: '2026-08-01' }).ok, false);
  // Start 07-01: 07-01+3 = 10-01 <= 10-08 → yes, even though today (09-15) is under 3 months.
  assert.equal(fpuVerdict({ ...base, startDate: '2026-07-01' }).ok, true);
  // And the answer does not change across the window.
  for (const today of ['2026-09-01', '2026-09-15', '2026-09-30']) {
    assert.equal(fpuVerdict({ ...base, today, startDate: '2026-07-01' }).ok, true, today);
    assert.equal(fpuVerdict({ ...base, today, startDate: '2026-07-09' }).ok, false, today);
  }
});

test('a missing or unparseable start date FAILS CLOSED', () => {
  for (const sd of [null, '', '   ', 'unknown']) {
    const v = fpuVerdict({ ...base, startDate: sd });
    assert.equal(v.ok, false, String(sd));
    if (!v.ok) assert.equal(v.reason, 'no_start_date');
  }
});

test('off the active roster is refused before any date is read', () => {
  const v = fpuVerdict({ ...base, onActiveRoster: false, startDate: null });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'off_roster');
});

test('already completed FPU / already enrolled in this class are refused first', () => {
  const done = fpuVerdict({ ...base, alreadyCompletedFpu: true });
  assert.equal(done.ok, false);
  if (!done.ok) assert.equal(done.reason, 'already_completed');
  const dup = fpuVerdict({ ...base, existingStatus: 'pending', alreadyCompletedFpu: true });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.reason, 'already_enrolled');
});

test('a DENIED entry that still exists blocks re-enrolling; a deleted one (no row) frees it', () => {
  // Kane, 2026-09-17: "when an entry is denied and deleted the Employee can apply
  // again but if its not deleted then he cant apply yet."
  const denied = fpuVerdict({ ...base, existingStatus: 'denied' });
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.reason, 'already_enrolled');
    assert.match(denied.detail, /denied/);
    assert.match(denied.detail, /HR can remove/);
  }
  for (const st of ['pending', 'approved', 'completed']) {
    assert.equal(fpuVerdict({ ...base, existingStatus: st }).ok, false, st);
  }
  // HR deleted the row → the server finds no enrollment → existingStatus null → eligible again.
  assert.equal(fpuVerdict({ ...base, existingStatus: null }).ok, true);
});

test('the window is inclusive: open on opens_on and closes_on, not the day after', () => {
  assert.equal(fpuVerdict({ ...base, today: '2026-08-31' }).ok, false);
  assert.equal(fpuVerdict({ ...base, today: '2026-09-01' }).ok, true);
  assert.equal(fpuVerdict({ ...base, today: '2026-09-30' }).ok, true);
  const late = fpuVerdict({ ...base, today: '2026-10-01' });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.reason, 'closed');
  const early = fpuVerdict({ ...base, today: '2026-08-31' });
  if (!early.ok) assert.equal(early.reason, 'not_open_yet');
});

test('no class at all', () => {
  const v = fpuVerdict({ ...base, cls: null });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, 'no_class');
});
