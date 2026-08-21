import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ORPHANAGE_OT_MULTIPLIER,
  ORPHANAGE_REGULAR_CAP_HOURS,
  orphanageOtRateFor,
  priceOrphanageHours,
  reconcileLockedOrphanageAmount,
  type OrphanagePriceInput,
} from './orphanage-pay-pricing';

/**
 * The regression these tests exist for (2026-08-21): an orphanage line showed
 * ₱3,781.00 against the NPD sheet's ₱7,224.25, and deleting the row and pasting
 * it again "fixed" it. The arithmetic below is the whole story, and it is exact:
 * 15.5 orphanage hours on a 34.1986 h week at ₱355/h price the 5.80 h of cap
 * remainder at 1.0× and the other 9.70 h at OT — ₱532.50 (regular × 1.5) gives
 * the sheet's ₱7,224.25, while ₱177.50 (regular × 0.5, the Hogan weekly
 * DIFFERENTIAL) gives ₱3,781.00. Orphanage hours have no base leg for a
 * differential to top up, so the differential half-pays them.
 *
 * Rates and hours here are the real shape of that incident but no employee is
 * named; the identity lives in the audit log, not in the repo.
 */

const HSL_ROW: OrphanagePriceInput = {
  hours: 15.5,
  regularRatePhp: 355,
  // What `CalcRow.otRate` actually carried on an HSL sheet-form row between
  // 2026-08-11 and 2026-08-18: the derived 0.5× differential.
  storedOtRatePhp: 177.5,
  isHslSheetForm: true,
  workedRegularHours: 34.19861111,
  overtimeEnabled: true,
};

test('sheet-form row: the incident week prices to the NPD sheet figure, to the centavo', () => {
  const r = priceOrphanageHours(HSL_ROW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // 40 − 34.1986 = 5.8014 → 5.80 on the sheet basis; 15.50 − 5.80 = 9.70.
  assert.equal(r.regH, 5.8);
  assert.equal(r.otH, 9.7);
  assert.equal(r.regH + r.otH, r.hours, 'the two legs must still sum to the pasted hours');
  assert.equal(r.otRate, 532.5, 'OT derives regular × 1.5, never the stored differential');
  assert.equal(r.otRateDerived, true);
  assert.equal(r.roundingBasis, 'sheet-2dp');
  assert.equal(r.regPay, 2059);
  assert.equal(r.otPay, 5165.25);
  assert.equal(r.amount, 7224.25);
});

test('the differential can never be reached again: 3,781.00 is not producible', () => {
  // Force the differential in as if it were a full OT rate — the guard refuses
  // rather than pricing it, so the old number has no path back.
  const r = priceOrphanageHours({ ...HSL_ROW, isHslSheetForm: false });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'ot_rate_below_regular');
  assert.match(r.reason, /below the regular rate/);
  assert.match(r.reason, /532\.50/, 'the message states the rate it should be');
});

test('an OT rate at or above regular is honoured as given (a negotiated rate is not overruled)', () => {
  const r = priceOrphanageHours({
    ...HSL_ROW,
    isHslSheetForm: false,
    storedOtRatePhp: 400, // below 1.5× but above regular: a real rate, not a differential
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.otRate, 400);
  assert.equal(r.otRateDerived, false);
  assert.equal(r.roundingBasis, 'exact');
  // Exact basis: full-precision hours, one trailing round — unchanged behaviour.
  // `regH` carries the raw float (40 − worked), exactly as the paste tool always
  // has; only the money is rounded.
  assert.ok(Math.abs(r.regH - 5.80138889) < 1e-9, `regH was ${r.regH}`);
  assert.equal(r.amount, 5938.94); // 5.80138889×355 + 9.69861111×400
});

test('exactly at the 40h cap: every orphanage hour is overtime', () => {
  const r = priceOrphanageHours({ ...HSL_ROW, workedRegularHours: ORPHANAGE_REGULAR_CAP_HOURS });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.regH, 0);
  assert.equal(r.otH, 15.5);
  assert.equal(r.amount, 8253.75); // 15.5 × 532.50
});

test('over the cap: negative capacity never becomes negative regular hours', () => {
  const r = priceOrphanageHours({ ...HSL_ROW, workedRegularHours: 45.29 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.regH, 0);
  assert.equal(r.otH, 15.5);
});

test('under the cap with room to spare: no overtime, no OT rate needed', () => {
  const r = priceOrphanageHours({
    ...HSL_ROW,
    hours: 4,
    workedRegularHours: 10,
    storedOtRatePhp: null,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.otH, 0);
  assert.equal(r.amount, 1420); // 4 × 355
});

test('OT switched off for the department: every hour stays regular', () => {
  const r = priceOrphanageHours({ ...HSL_ROW, overtimeEnabled: false });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.regH, 15.5);
  assert.equal(r.otH, 0);
  assert.equal(r.amount, 5502.5); // 15.5 × 355
});

test('crossing the cap with no OT rate at all is refused, not priced at zero', () => {
  const r = priceOrphanageHours({ ...HSL_ROW, isHslSheetForm: false, storedOtRatePhp: null });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'no_ot_rate');
});

test('no regular rate is refused (a rateless row is not worth ₱0)', () => {
  for (const bad of [null, 0, Number.NaN]) {
    const r = priceOrphanageHours({ ...HSL_ROW, regularRatePhp: bad as number | null });
    assert.equal(r.ok, false, `rate ${String(bad)} must refuse`);
    if (r.ok) return;
    assert.equal(r.code, 'no_regular_rate');
  }
});

test('negative and non-finite hours are refused', () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = priceOrphanageHours({ ...HSL_ROW, hours: bad });
    assert.equal(r.ok, false, `hours ${String(bad)} must refuse`);
    if (r.ok) return;
    assert.equal(r.code, 'invalid_hours');
  }
});

test('zero hours prices to zero rather than refusing', () => {
  const r = priceOrphanageHours({ ...HSL_ROW, hours: 0 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.amount, 0);
});

test('the OT multiplier is the full rate, and the rate decision is shared', () => {
  assert.equal(ORPHANAGE_OT_MULTIPLIER, 1.5);
  assert.deepEqual(
    orphanageOtRateFor({ regularRatePhp: 355, storedOtRatePhp: 177.5, isHslSheetForm: true }),
    { otRate: 532.5, derived: true },
  );
  assert.deepEqual(
    orphanageOtRateFor({ regularRatePhp: 355, storedOtRatePhp: 532.5, isHslSheetForm: false }),
    { otRate: 532.5, derived: false },
  );
});

test('derived OT rate rounds to the centavo, like the sheet', () => {
  const r = priceOrphanageHours({ ...HSL_ROW, regularRatePhp: 133.33, workedRegularHours: 40 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.otRate, 200); // 133.33 × 1.5 = 199.995 → 200.00
});

// ── reconcileLockedOrphanageAmount ──────────────────────────────────────────

test('reconcile flags a row whose OT was priced at the differential, with the shortfall', () => {
  const r = reconcileLockedOrphanageAmount({
    storedAmountPhp: 3781,
    record: { hours: 15.5, regHours: 5.8014, otHours: 9.6986, regularRatePhp: 355, otRatePhp: 177.5 },
  });
  assert.equal(r.status, 'ot_underpriced');
  assert.equal(r.correctOtRatePhp, 532.5);
  // 9.6986 × 355 = the missing base leg on every OT hour.
  assert.equal(r.shortfallPhp, 3443);
  assert.match(r.message, /0\.5/);
});

test('reconcile passes a row that agrees with its own hours and rates', () => {
  const r = reconcileLockedOrphanageAmount({
    storedAmountPhp: 7224.25,
    record: { hours: 15.5, regHours: 5.8, otHours: 9.7, regularRatePhp: 355, otRatePhp: 532.5 },
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.shortfallPhp, 0);
  assert.equal(r.message, '');
});

test('reconcile tolerates a one-centavo-per-leg rounding delta on pre-sheet-basis rows', () => {
  // The old 4dp-hours basis produced 7224.00 for this row; that is a rounding
  // difference, not a disagreement, and must not be reported as a mismatch.
  const r = reconcileLockedOrphanageAmount({
    storedAmountPhp: 7224,
    record: { hours: 15.5, regHours: 5.8014, otHours: 9.6986, regularRatePhp: 355, otRatePhp: 532.5 },
  });
  assert.equal(r.status, 'ok');
});

test('reconcile reports a genuine arithmetic mismatch', () => {
  const r = reconcileLockedOrphanageAmount({
    storedAmountPhp: 5000,
    record: { hours: 15.5, regHours: 5.8, otHours: 9.7, regularRatePhp: 355, otRatePhp: 532.5 },
  });
  assert.equal(r.status, 'amount_mismatch');
  assert.equal(r.expectedAmountPhp, 7224.25);
  assert.equal(r.shortfallPhp, 2224.25);
});

test('reconcile says unverifiable rather than ok when there is no hours record', () => {
  for (const record of [
    null,
    { hours: 15.5, regHours: 5.8, otHours: 9.7, regularRatePhp: null, otRatePhp: 532.5 },
    { hours: 15.5, regHours: 5.8, otHours: 9.7, regularRatePhp: 0, otRatePhp: 532.5 },
  ]) {
    const r = reconcileLockedOrphanageAmount({ storedAmountPhp: 7224.25, record });
    assert.equal(r.status, 'unverifiable');
    assert.equal(r.expectedAmountPhp, null);
  }
});

test('reconcile does not flag a no-overtime row that has no OT rate', () => {
  const r = reconcileLockedOrphanageAmount({
    storedAmountPhp: 1420,
    record: { hours: 4, regHours: 4, otHours: 0, regularRatePhp: 355, otRatePhp: null },
  });
  assert.equal(r.status, 'ok');
});

test('a repriced row and a fresh paste of the same hours agree exactly', () => {
  // The identity that keeps the repair honest: re-pricing must be the same
  // arithmetic as re-pasting, because it IS the same function.
  const stored = { hours: 15.5, regHours: 5.8014, otHours: 9.6986, regularRatePhp: 355, otRatePhp: 177.5 };
  const flagged = reconcileLockedOrphanageAmount({ storedAmountPhp: 3781, record: stored });
  assert.equal(flagged.status, 'ot_underpriced');

  const repriced = priceOrphanageHours({ ...HSL_ROW, hours: stored.hours });
  const pasted = priceOrphanageHours(HSL_ROW);
  assert.equal(repriced.ok && pasted.ok && repriced.amount === pasted.amount, true);
  if (repriced.ok) assert.equal(repriced.amount, 7224.25);
});
