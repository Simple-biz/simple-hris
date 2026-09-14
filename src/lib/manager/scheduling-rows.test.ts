import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toSchedulePeriod,
  toScheduleRow,
  readRestDays,
  departmentHasScheduling,
  DEFAULT_SCHEDULE_TIMEZONE,
  type SchedulePeriodRow,
} from './scheduling-rows';

const row = (over: Partial<SchedulePeriodRow> = {}): SchedulePeriodRow => ({
  id: 'p1',
  work_email: 'a@simple.biz',
  member_name: 'Dela Cruz, Maria',
  department: 'hsl:intake_specialist',
  rest_days: [0, 6],
  shift_start_minute: 540,
  shift_end_minute: 1020,
  timezone: 'America/New_York',
  effective_from: '2026-09-14',
  effective_to: null,
  ...over,
});

test('a row round-trips to a SchedulePeriod and back', () => {
  const period = toSchedulePeriod(row());
  const back = toScheduleRow(period);
  assert.equal(back.work_email, 'a@simple.biz');
  assert.equal(back.department, 'hsl:intake_specialist');
  assert.deepEqual(back.rest_days, [0, 6]);
  assert.equal(back.shift_start_minute, 540);
  assert.equal(back.shift_end_minute, 1020);
  assert.equal(back.effective_to, null);
});

test('"hours not set" survives the round trip as NULL, never as midnight', () => {
  // The bug the whole model exists to prevent: defaulting a missing window to 0.
  const period = toSchedulePeriod(row({ shift_start_minute: null, shift_end_minute: null }));
  assert.equal(period.shiftWindow, null);
  const back = toScheduleRow(period);
  assert.equal(back.shift_start_minute, null);
  assert.equal(back.shift_end_minute, null);
});

test('a one-sided window reads as NO window, never as a midnight edge', () => {
  // The CHECK makes this impossible to store; mirroring it here means a row that
  // somehow got past the constraint degrades to "hours not set" rather than to
  // "starts at 00:00".
  for (const half of [
    { shift_start_minute: 540, shift_end_minute: null },
    { shift_start_minute: null, shift_end_minute: 1020 },
  ]) {
    assert.equal(toSchedulePeriod(row(half)).shiftWindow, null);
  }
});

test('an overnight window is preserved — end < start crosses midnight', () => {
  const period = toSchedulePeriod(row({ shift_start_minute: 1320, shift_end_minute: 360 }));
  assert.deepEqual(period.shiftWindow, { startMinute: 1320, endMinute: 360 });
});

test('effective_to null means still current and stays null', () => {
  assert.equal(toSchedulePeriod(row({ effective_to: null })).effectiveTo, null);
  assert.equal(toSchedulePeriod(row({ effective_to: '2026-12-31' })).effectiveTo, '2026-12-31');
});

test('the work email is lower-cased on the way in and out', () => {
  const period = toSchedulePeriod(row({ work_email: '  A@Simple.Biz ' }));
  assert.equal(period.workEmail, 'a@simple.biz');
  assert.equal(toScheduleRow(period).work_email, 'a@simple.biz');
});

test('a missing timezone falls back to the workforce zone, never to empty', () => {
  assert.equal(toSchedulePeriod(row({ timezone: null })).timezone, DEFAULT_SCHEDULE_TIMEZONE);
  assert.equal(toSchedulePeriod(row({ timezone: '   ' })).timezone, DEFAULT_SCHEDULE_TIMEZONE);
});

test('rest days are sorted and de-duplicated', () => {
  assert.deepEqual(readRestDays([6, 0, 6, 0]), [0, 6]);
});

test('an out-of-range rest day is DROPPED, never coerced into a real day', () => {
  // Coercing 7 to Sunday would invent a rest day nobody set. Dropping it leaves
  // the person scheduled, which surfaces as a question rather than a silent absence.
  assert.deepEqual(readRestDays([7, 0, -1, 3]), [0, 3]);
  assert.deepEqual(readRestDays([1.5, 2]), [2]);
});

test('null rest days read as an empty array — works every day', () => {
  assert.deepEqual(readRestDays(null), []);
  assert.deepEqual(readRestDays(undefined), []);
});

// ── the capability predicate ────────────────────────────────────────────────────

test('the whole HSL family carries Scheduling — parent and every sub-team', () => {
  for (const d of [
    'hogan_smith_law',
    'HSL',
    'Hogan Smith Law',
    'hsl:intake_specialist',
    'hsl:filing_specialist',
    'hsl:ssd_medical_records',
  ]) {
    assert.equal(departmentHasScheduling(d), true, d);
  }
});

test('no other department carries Scheduling — HSL only, by Kane', () => {
  for (const d of ['lead_gen', 'Lead Gen', 'qc', 'QC', 'Client VA', 'USEE', 'accounting']) {
    assert.equal(departmentHasScheduling(d), false, d);
  }
});

test('a blank department never carries Scheduling', () => {
  for (const d of ['', '   ', null, undefined]) {
    assert.equal(departmentHasScheduling(d), false);
  }
});

test('the No-department rail sentinel never carries Scheduling', () => {
  assert.equal(departmentHasScheduling('@no_department'), false);
});
