/**
 * Pins the wizard PAB breakdown's per-day classification.
 *
 * The load-bearing property: `seconds` is IDENTICAL to the pre-2026-10-06 formula for
 * every input, and `passes` is identical on every input EXCEPT the one Kane ruled on
 * (item 363, ruling (b)): a `null` entry — an approved issue with no hours set — under
 * 4h now passes. Any other difference means PAB money moved without a ruling.
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

test('seconds never moves; passes moves ONLY for a null entry under 4h (the ruling)', () => {
  for (const raw of RAWS) {
    for (const override of OVERRIDES) {
      for (const fromIssue of [false, true]) {
        for (const isHoliday of [false, true]) {
          const got = classifyPabBreakdownDay({ rawSeconds: raw, override, fromIssue, isHoliday });
          const want = legacy(raw, override, isHoliday);
          const at = JSON.stringify({ raw, override, fromIssue, isHoliday });
          assert.equal(got.seconds, want.seconds, `seconds ${at}`);
          assert.equal(got.forgivenByHoliday, want.forgivenByHoliday, `forgivenByHoliday ${at}`);
          const ruled = override === null && raw < 4 * H && !isHoliday;
          assert.equal(got.passes, ruled ? true : want.passes, `passes ${at}`);
        }
      }
    }
  }
});

test('Kane 2026-10-06 (b): a forgiven null day under 4h PASSES and keeps its hours', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 2 * H, override: null, fromIssue: true, isHoliday: false });
  assert.equal(day.passes, true);
  assert.equal(day.forgivenByDispute, true);
  assert.equal(day.seconds, 2 * H, 'nothing is added to the verdict input');
  assert.equal(day.displaySeconds, 2 * H);
});

test('a zero-hour day forgiven with no hours set reads forgiven, showing 0:00', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 0, override: null, fromIssue: true, isHoliday: false });
  assert.equal(day.passes, true);
  assert.equal(day.forgivenByDispute, true);
  assert.equal(day.displaySeconds, 0);
});

test('a legacy row forgiven at a 7h override reads FORGIVEN with its own tracked hours', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 2 * H, override: 7, fromIssue: true, isHoliday: false });
  assert.equal(day.passes, true);
  assert.equal(day.forgivenByDispute, true);
  assert.equal(day.seconds, 7 * H, 'the verdict input still carries the stored override');
  assert.equal(day.displaySeconds, 2 * H, 'the cell shows the original hours, never 7:00');
});

test('an explicit hours SET under 4h still FAILS — a number is not forgiveness', () => {
  for (const override of [0, 3]) {
    const day = classifyPabBreakdownDay({ rawSeconds: 6 * H, override, fromIssue: true, isHoliday: false });
    assert.equal(day.passes, false, `override ${override}`);
    assert.equal(day.forgivenByDispute, false, `override ${override}`);
  }
});

test('a forgiven day the person worked 7h+ on anyway is a plain pass, not forgiven', () => {
  for (const override of [null, 7]) {
    const day = classifyPabBreakdownDay({ rawSeconds: 8 * H, override, fromIssue: true, isHoliday: false });
    assert.equal(day.passes, true);
    assert.equal(day.forgivenByDispute, false, `override ${override}`);
  }
});

test('a 7h value that is NOT an issue (time adjustment / orphanage coverage) stays a plain pass', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 2 * H, override: 7, fromIssue: false, isHoliday: false });
  assert.equal(day.forgivenByDispute, false);
  assert.equal(day.displaySeconds, 7 * H, 'real adjusted hours are shown as before');
});

test('a US holiday keeps precedence over an issue', () => {
  const day = classifyPabBreakdownDay({ rawSeconds: 0, override: null, fromIssue: true, isHoliday: true });
  assert.equal(day.forgivenByHoliday, true);
  assert.equal(day.forgivenByDispute, false);
  assert.equal(day.passes, true);
});
