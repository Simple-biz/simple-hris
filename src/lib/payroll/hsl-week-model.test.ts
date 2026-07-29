import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveHslWeekModel,
  resolveHslWeekModelWithDefault,
  HSL_WEEK_MODEL_DEFAULT_CUTOVER,
} from './hsl-week-model';
import {
  payWeekFromUploadStart,
  checkHslPabEligibility,
  computeHslPabWeekInfo,
  pabDateKey,
  getPabMonthRange,
} from '../hubstaff/calendar-column-dedupe';
import { getHslAdjustedEnd } from './dispatch-bonuses';

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

// ── resolveHslWeekModelWithDefault ───────────────────────────────────────────
test('resolveHslWeekModelWithDefault: unset value falls back to the default cutover', () => {
  assert.equal(HSL_WEEK_MODEL_DEFAULT_CUTOVER, '2026-05-31');
  // Unset (null/''/undefined) → uses the default cutover, NOT mon_sun-everywhere.
  assert.equal(resolveHslWeekModelWithDefault('2026-05-24', null), 'mon_sun'); // before default (May's last week)
  assert.equal(resolveHslWeekModelWithDefault('2026-05-31', ''), 'sun_sat'); // on default (June's first week)
  assert.equal(resolveHslWeekModelWithDefault('2026-07-12', undefined), 'sun_sat'); // after default
  // A stored setting value overrides the default.
  assert.equal(resolveHslWeekModelWithDefault('2026-06-28', '2026-08-01'), 'mon_sun');
  assert.equal(resolveHslWeekModelWithDefault('2026-08-02', '2026-08-01'), 'sun_sat');
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

// ── Integration: the exact current-pay.ts / wizard resolution at the cutover ──
// Reproduces the server wiring for two consecutive HSL uploads around the
// default 2026-05-31 cutover and asserts (a) the pay window flips and (b) the
// owning Monday — which drives PAB-month + tech-bonus timing — stays Monday.
function resolveForUpload(periodStart: Date, cutover: string | null) {
  const model = resolveHslWeekModelWithDefault(periodStart, cutover);
  const payWeekHsl = payWeekFromUploadStart(periodStart, true, model);
  // Guardrail: owning Monday is ALWAYS the mon_sun start, never the sun_sat Sunday.
  const weekMonday = payWeekFromUploadStart(periodStart, true, 'mon_sun').start;
  return { model, payWeekHsl, weekMonday };
}

test('cutover integration: May 24 upload stays Mon→Sun (May), owning Monday = May 25', () => {
  const r = resolveForUpload(new Date(2026, 4, 24), null); // Sun May 24, default cutover
  assert.equal(r.model, 'mon_sun');
  assert.equal(fmt(r.payWeekHsl.start), '2026-05-25'); // Monday
  assert.equal(fmt(r.payWeekHsl.end), '2026-05-31'); // Sunday
  assert.equal(fmt(r.weekMonday), '2026-05-25');
  assert.equal(r.weekMonday.getMonth(), 4, 'owned by May'); // 0-based: 4 = May
  // May PAB end (Mon→Sun) snaps forward to the closing Sunday.
  const mayEnd = getPabMonthRange(2026, 4).end;
  assert.equal(getHslAdjustedEnd(mayEnd, 'mon_sun').getDay(), 0, 'snaps to Sunday');
});

test('cutover integration: May 31 upload flips to Sun→Sat (June), owning Monday = Jun 1', () => {
  const r = resolveForUpload(new Date(2026, 4, 31), null); // Sun May 31, default cutover
  assert.equal(r.model, 'sun_sat');
  assert.equal(fmt(r.payWeekHsl.start), '2026-05-31'); // Sunday
  assert.equal(fmt(r.payWeekHsl.end), '2026-06-06'); // Saturday
  // Guardrail: pay window opens Sunday, but ownership Monday is the NEXT day → June.
  assert.equal(fmt(r.weekMonday), '2026-06-01');
  assert.equal(r.weekMonday.getMonth(), 5, 'owned by June'); // 5 = June
  // June PAB end (Sun→Sat) snaps forward to the closing Saturday.
  const juneEnd = getPabMonthRange(2026, 5).end;
  assert.equal(getHslAdjustedEnd(juneEnd, 'sun_sat').getDay(), 6, 'snaps to Saturday');
});

// ── computeHslPabWeekInfo: per-week breakdown behind the eligibility boolean ─
// Calendars colour cells from this data; it must agree with the engine.
const H7 = 7 * 3600;

function weeksAllPass(info: Map<string, { weekPasses: boolean }>): boolean {
  return [...info.values()].every((w) => w.weekPasses);
}

test('computeHslPabWeekInfo: all-pass verdict equals checkHslPabEligibility (both models)', () => {
  // Jul 2026: Mon Jul 6 starts the period. Week 2 has a 0h Wednesday that is
  // RECONCILED by Saturday work (4 weekdays + Sat = 5 of 7).
  const hours = new Map<string, number>();
  for (const day of [6, 7, 8, 9, 10]) hours.set(pabDateKey(new Date(2026, 6, day)), H7); // wk1 Mon–Fri
  for (const day of [13, 14, 16, 17]) hours.set(pabDateKey(new Date(2026, 6, day)), H7); // wk2 Mon,Tue,Thu,Fri
  hours.set(pabDateKey(new Date(2026, 6, 15)), 0); // wk2 Wed — 0h, no overnight rescue
  hours.set(pabDateKey(new Date(2026, 6, 18)), 8 * 3600); // wk2 Sat — weekend credit

  const start = new Date(2026, 6, 6);
  for (const [model, end] of [
    ['mon_sun', new Date(2026, 6, 19)], // closing Sunday
    ['sun_sat', new Date(2026, 6, 18)], // closing Saturday (anchor backs to Sun Jul 5)
  ] as const) {
    const info = computeHslPabWeekInfo(start, end, hours, model);
    assert.equal(
      weeksAllPass(info),
      checkHslPabEligibility(start, end, hours, model),
      `parity for ${model}`,
    );
    assert.equal(weeksAllPass(info), true, `weekend credit keeps eligibility (${model})`);
  }

  // Failing variant: remove the Saturday credit → week 2 drops to 4 of 7.
  const noSat = new Map(hours);
  noSat.delete(pabDateKey(new Date(2026, 6, 18)));
  for (const [model, end] of [
    ['mon_sun', new Date(2026, 6, 19)],
    ['sun_sat', new Date(2026, 6, 18)],
  ] as const) {
    const info = computeHslPabWeekInfo(start, end, noSat, model);
    assert.equal(weeksAllPass(info), false, `4-of-7 fails (${model})`);
    assert.equal(
      weeksAllPass(info),
      checkHslPabEligibility(start, end, noSat, model),
      `parity for failing ${model}`,
    );
  }
});

test('computeHslPabWeekInfo: reconciled week reports 5 qualifying days, keyed by anchor day', () => {
  const hours = new Map<string, number>();
  for (const day of [13, 14, 16, 17]) hours.set(pabDateKey(new Date(2026, 6, day)), H7);
  hours.set(pabDateKey(new Date(2026, 6, 18)), 8 * 3600); // Sat
  const info = computeHslPabWeekInfo(new Date(2026, 6, 13), new Date(2026, 6, 19), hours, 'mon_sun');
  const wk = info.get('2026-07-13'); // Monday anchors the mon_sun week
  assert.ok(wk, 'week keyed by its Monday');
  assert.equal(wk!.qualifyingDays, 5);
  assert.equal(wk!.weekPasses, true);
  assert.equal(wk!.overnightIsos.size, 0, '0h Wednesday is reconciled, not overnight');
});

test('computeHslPabWeekInfo: overnight split days are flagged with their ISO dates', () => {
  // Mon 4h + Tue 4h — a midnight-split shift. Forward check qualifies Monday,
  // backward check qualifies Tuesday; Wed–Fri at 7h round out the 5-day quota.
  const hours = new Map<string, number>();
  hours.set(pabDateKey(new Date(2026, 6, 6)), 4 * 3600);
  hours.set(pabDateKey(new Date(2026, 6, 7)), 4 * 3600);
  for (const day of [8, 9, 10]) hours.set(pabDateKey(new Date(2026, 6, day)), H7);
  const info = computeHslPabWeekInfo(new Date(2026, 6, 6), new Date(2026, 6, 12), hours, 'mon_sun');
  const wk = info.get('2026-07-06');
  assert.ok(wk);
  assert.equal(wk!.weekPasses, true);
  assert.ok(wk!.overnightIsos.has('2026-07-06'), 'Monday flagged as overnight');
  assert.ok(wk!.overnightIsos.has('2026-07-07'), 'Tuesday flagged as overnight');
});

test('computeHslPabWeekInfo: empty range → empty map (engine treats as eligible)', () => {
  const start = new Date(2026, 6, 6); // Mon
  const dayBefore = new Date(2026, 6, 5);
  const info = computeHslPabWeekInfo(start, dayBefore, new Map(), 'mon_sun');
  assert.equal(info.size, 0);
  assert.equal(checkHslPabEligibility(start, dayBefore, new Map(), 'mon_sun'), true);
});

test('sun_sat boundary: start-1 is NOT an empty range — callers must end before the anchor Sunday', () => {
  // Under sun_sat the first week ANCHORS BACK to the Sunday on/before the
  // period start. For a Monday start, `start - 1` IS that anchor Sunday, so
  // ending there evaluates a 1-day fragment week (0 qualifying days → fails
  // everyone). The "nothing to evaluate yet" fallback in Overview /
  // EmployeePabCalendar therefore ends at anchor - 1, which this test pins.
  const start = new Date(2026, 6, 6); // Mon Jul 6
  const anchorSunday = new Date(2026, 6, 5); // Sun Jul 5 = start - 1
  const beforeAnchor = new Date(2026, 6, 4); // Sat Jul 4 = anchor - 1

  const fragment = computeHslPabWeekInfo(start, anchorSunday, new Map(), 'sun_sat');
  assert.equal(fragment.size, 1, 'start-1 under sun_sat evaluates a fragment week');
  assert.equal([...fragment.values()][0].weekPasses, false, 'the empty fragment fails');
  assert.equal(checkHslPabEligibility(start, anchorSunday, new Map(), 'sun_sat'), false);

  const empty = computeHslPabWeekInfo(start, beforeAnchor, new Map(), 'sun_sat');
  assert.equal(empty.size, 0, 'anchor-1 is the true empty range');
  assert.equal(checkHslPabEligibility(start, beforeAnchor, new Map(), 'sun_sat'), true);
});
