import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  expectedInternPabWeekEnds,
  INTERN_PAB_MIN_WEEKLY_HOURS,
  internPabVerdict,
  type InternPabInput,
} from './intern-pab';

// Simple's default PAB window for September 2026 (Mon Sep 7 → Fri Oct 2, see
// pab-calendars-sun-sat-sweep). Saturdays inside it: Sep 12, 19, 26.
const PERIOD = { start: '2026-09-07', end: '2026-10-02' };

function weeks(hours: number[]): InternPabInput['weeks'] {
  const ends = ['2026-09-12', '2026-09-19', '2026-09-26'];
  return ends.map((weekEnd, i) => ({
    weekStart: shift(weekEnd, -6),
    weekEnd,
    hoursPaid: hours[i] ?? 0,
  }));
}
function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function input(w: InternPabInput['weeks']): InternPabInput {
  return { period: PERIOD, weeks: w, minWeeklyHours: INTERN_PAB_MIN_WEEKLY_HOURS, bonusPhp: 1000 };
}

test('the threshold is 5 hours a week (Ralph, 2026-09-02)', () => {
  assert.equal(INTERN_PAB_MIN_WEEKLY_HOURS, 5);
});

test('the counted weeks are the Sun–Sat weeks whose Saturday falls inside the period', () => {
  assert.deepEqual(expectedInternPabWeekEnds(PERIOD), ['2026-09-12', '2026-09-19', '2026-09-26']);
});

test('every week at or above 5 paid hours → eligible for the full bonus', () => {
  const v = internPabVerdict(input(weeks([5, 5, 5.25])));
  assert.deepEqual(v, { status: 'eligible', amountPhp: 1000 });
});

test('exactly 5.00 qualifies; 4.99 does not, and the failed week is named', () => {
  assert.equal(internPabVerdict(input(weeks([5, 5, 5]))).status, 'eligible');
  const v = internPabVerdict(input(weeks([5, 4.99, 5])));
  assert.equal(v.status, 'ineligible');
  assert.equal(v.amountPhp, 0);
  if (v.status === 'ineligible') assert.deepEqual(v.failedWeekStarts, ['2026-09-13']);
});

test('one short week loses the month — all failed weeks are listed', () => {
  const v = internPabVerdict(input(weeks([0, 5, 3])));
  assert.equal(v.status, 'ineligible');
  if (v.status === 'ineligible') assert.deepEqual(v.failedWeekStarts, ['2026-09-06', '2026-09-20']);
});

test('a period with an unlocked week → weeks_missing, ₱0, and it names the missing Saturdays', () => {
  const partial = weeks([5, 5, 5]).filter((w) => w.weekEnd !== '2026-09-19');
  const v = internPabVerdict(input(partial));
  assert.equal(v.status, 'weeks_missing');
  assert.equal(v.amountPhp, 0);
  if (v.status === 'weeks_missing') assert.deepEqual(v.missingWeekEnds, ['2026-09-19']);
});

test('weeks outside the period are ignored, not counted for or against', () => {
  const extra = [...weeks([5, 5, 5]), { weekStart: '2026-09-27', weekEnd: '2026-10-03', hoursPaid: 0 }];
  assert.equal(internPabVerdict(input(extra)).status, 'eligible');
});

test('a period containing no Saturday has no weeks to judge → weeks_missing', () => {
  const v = internPabVerdict({ ...input([]), period: { start: '2026-09-07', end: '2026-09-11' } });
  assert.equal(v.status, 'weeks_missing');
});

test('the bonus amount is the intern profile value, not a constant', () => {
  const v = internPabVerdict({ ...input(weeks([5, 5, 5])), bonusPhp: 1500 });
  assert.deepEqual(v, { status: 'eligible', amountPhp: 1500 });
});
