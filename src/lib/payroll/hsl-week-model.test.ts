import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveHslWeekModel } from './hsl-week-model';
import {
  payWeekFromUploadStart,
  checkHslPabEligibility,
  pabDateKey,
} from '../hubstaff/calendar-column-dedupe';

const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ── resolveHslWeekModel ──────────────────────────────────────────────────────
test('resolveHslWeekModel: no cutover configured → always mon_sun', () => {
  assert.equal(resolveHslWeekModel('2026-07-12', null), 'mon_sun');
  assert.equal(resolveHslWeekModel('2026-07-12', ''), 'mon_sun');
  assert.equal(resolveHslWeekModel(new Date(2026, 6, 12), undefined), 'mon_sun');
});

test('resolveHslWeekModel: before cutover → mon_sun, on/after → sun_sat', () => {
  const cut = '2026-07-05';
  assert.equal(resolveHslWeekModel('2026-06-28', cut), 'mon_sun'); // before
  assert.equal(resolveHslWeekModel('2026-07-04', cut), 'mon_sun'); // day before
  assert.equal(resolveHslWeekModel('2026-07-05', cut), 'sun_sat'); // exactly the cutover
  assert.equal(resolveHslWeekModel('2026-07-12', cut), 'sun_sat'); // after
  assert.equal(resolveHslWeekModel(new Date(2026, 6, 5), cut), 'sun_sat'); // Date form
});

// ── payWeekFromUploadStart: HSL Mon→Sun (legacy) vs Sun→Sat (post-cutover) ───
test('payWeekFromUploadStart: HSL flips window with weekModel', () => {
  const upload = new Date(2026, 4, 31); // Sun May 31 2026 — start of a Sun→Sun export

  const monSun = payWeekFromUploadStart(upload, true, 'mon_sun');
  assert.equal(monSun.start.getDay(), 1, 'mon_sun HSL starts Monday');
  assert.equal(fmt(monSun.start), '2026-06-01');
  assert.equal(fmt(monSun.end), '2026-06-07'); // Sunday

  const sunSat = payWeekFromUploadStart(upload, true, 'sun_sat');
  assert.equal(sunSat.start.getDay(), 0, 'sun_sat HSL starts Sunday');
  assert.equal(fmt(sunSat.start), '2026-05-31');
  assert.equal(fmt(sunSat.end), '2026-06-06'); // Saturday

  // Default arg preserves legacy behavior (back-compat with existing callers).
  assert.equal(fmt(payWeekFromUploadStart(upload, true).start), '2026-06-01');

  // Non-HSL is unaffected by weekModel (always Sun→Sat).
  assert.equal(fmt(payWeekFromUploadStart(upload, false).start), '2026-05-31');
  assert.equal(fmt(payWeekFromUploadStart(upload, false, 'sun_sat').start), '2026-05-31');
});

// ── checkHslPabEligibility: the SAME hours score differently by anchor ───────
// Worker hits ≥7h on Sun May 31 + Mon–Thu Jun 1–4; 0h Fri/Sat/Sun after.
//  - Sun→Sat week May 31–Jun 6: qualifying = {May31, Jun1, Jun2, Jun3, Jun4} = 5 → PASS
//  - Mon→Sun week Jun 1–Jun 7:  qualifying = {Jun1, Jun2, Jun3, Jun4}        = 4 → FAIL
test('checkHslPabEligibility: anchor determines the 7-day grouping', () => {
  const H = 8 * 3600;
  const hours = new Map<string, number>();
  for (const d of [
    new Date(2026, 4, 31), // Sun
    new Date(2026, 5, 1), // Mon
    new Date(2026, 5, 2), // Tue
    new Date(2026, 5, 3), // Wed
    new Date(2026, 5, 4), // Thu
  ]) {
    hours.set(pabDateKey(d), H);
  }
  // Jun 5 (Fri), Jun 6 (Sat), Jun 7 (Sun) intentionally absent → 0h.

  const start = new Date(2026, 5, 1); // Mon Jun 1 (PAB-month first Monday, stays Monday-based)

  // mon_sun: walk Jun1..Jun7 → only 4 qualifying weekdays → fail.
  assert.equal(
    checkHslPabEligibility(start, new Date(2026, 5, 7), hours, 'mon_sun'),
    false,
  );
  // sun_sat: anchor backs to Sun May31, walk May31..Jun6 → 5 qualifying → pass.
  assert.equal(
    checkHslPabEligibility(start, new Date(2026, 5, 6), hours, 'sun_sat'),
    true,
  );
  // Default arg = legacy mon_sun.
  assert.equal(checkHslPabEligibility(start, new Date(2026, 5, 7), hours), false);
});
