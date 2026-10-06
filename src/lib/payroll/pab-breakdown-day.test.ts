/**
 * Pins the wizard PAB breakdown's per-day classification.
 *
 * The load-bearing property: `seconds` and `passes` are IDENTICAL to the formula the
 * breakdown used before 2026-10-06, for every input. Those two fields feed the
 * verdict, so if this fails, the PAB calendar fix has moved PAB money.
 *
 * Run: npx tsx --test src/lib/payroll/pab-breakdown-day.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPabBreakdownDay } from './pab-breakdown-day';

const H = 3600;

/** The breakdown's formula verbatim, as it stood before 2026-10-06. */
function legacy(rawSeconds: number, override: number | null | undefined, isHoliday: boolean) {
  const seconds = override != null ? override * 3600 : rawSeconds;
  const disputeForgiven = override !== undefined && seconds >= 4 * H && seconds < 7 * H;
  const holidayForgiven = isHoliday && seconds < 7 * H;
  return {
    seconds,
    passes: seconds >= 7 * H || disputeForgiven || isHoliday,
    forgivenByDispute: disputeForgiven && !holidayForgiven,
    forgivenByHoliday: holidayForgiven,
  };
}

const RAWS = [0, 1 * H, 3.5 * H, 4 * H, 5.25 * H, 6.99 * H, 7 * H, 9 * H];
const OVERRIDES: (number | null | undefined)[] = [undefined, null, 0, 3, 4, 5, 6.5, 7, 8];

test('seconds and passes never differ from the pre-2026-10-06 formula (the money alarm)', () => {
  for (const raw of RAWS) {
    for (const override of OVERRIDES) {
      for (const fromIssue of [false, true]) {
        for (const isHoliday of [false, true]) {
          const got = classifyPabBreakdownDay({ rawSeconds: raw, override, fromIssue, isHoliday });
          const want = legacy(raw, override, isHoliday);
          const at = JSON.stringify({ raw, override, fromIssue, isHoliday });
          assert.equal(got.seconds, want.seconds, `seconds ${at}`);
          assert.equal(got.passes, want.passes, `passes ${at}`);
          assert.equal(got.forgivenByHoliday, want.forgivenByHoliday, `forgivenByHoliday ${at}`);
        }
      }
    }
  }
});

test('a day the PAB step forgave at 7h reads FORGIVEN with its own tracked hours', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 2 * H, override: 7, fromIssue: true, isHoliday: false });
  assert.equal(day.passes, true);
  assert.equal(day.forgivenByDispute, true);
  assert.equal(day.seconds, 7 * H, 'the verdict input still carries the override');
  assert.equal(day.displaySeconds, 2 * H, 'the cell shows the original hours, never 7:00');
});

test('a zero-hour forgiven day still reads forgiven, showing 0:00', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 0, override: 7, fromIssue: true, isHoliday: false });
  assert.equal(day.forgivenByDispute, true);
  assert.equal(day.displaySeconds, 0);
});

test('a forgiven day the person worked 7h+ on anyway is a plain pass, not forgiven', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 8 * H, override: 7, fromIssue: true, isHoliday: false });
  assert.equal(day.passes, true);
  assert.equal(day.forgivenByDispute, false);
});

test('a 7h value that is NOT an issue (time adjustment / orphanage coverage) stays a plain pass', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 2 * H, override: 7, fromIssue: false, isHoliday: false });
  assert.equal(day.forgivenByDispute, false);
  assert.equal(day.displaySeconds, 7 * H, 'real adjusted hours are shown as before');
});

test('a null-override issue under the 4h floor stays FAILED — the floor is untouched here', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 2 * H, override: null, fromIssue: true, isHoliday: false });
  assert.equal(day.passes, false);
  assert.equal(day.forgivenByDispute, false);
  assert.equal(day.displaySeconds, 2 * H);
});

test('a null-override issue at 4h+ is forgiven and shows its tracked hours', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 5 * H, override: null, fromIssue: true, isHoliday: false });
  assert.equal(day.forgivenByDispute, true);
  assert.equal(day.displaySeconds, 5 * H);
});

test('a US holiday keeps precedence over an issue', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 0, override: 5, fromIssue: true, isHoliday: true });
  assert.equal(day.forgivenByHoliday, true);
  assert.equal(day.forgivenByDispute, false);
});
