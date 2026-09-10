import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayReplayFinal, type ReplayFinalEntry, type ReplayOverlayRow } from './replay-finals-overlay';
import { buildPayrollExportRow, payrollExportRowReconciles } from './report-rows';

/** A live-recomputed row whose figures have DRIFTED since dispatch — the
 *  overlay must replace every drifted component, not just the final. */
function liveRow(): ReplayOverlayRow & { name: string | null; email: string; department_name: string | null } {
  return {
    name: 'Jane Doe',
    email: 'jane@simple.biz',
    department_name: 'Collections',
    hours: { total: 42, regular: 40, ot: 2 },
    pay_php: {
      regular: 7200, // rate raised since dispatch
      ot: 540,
      initial: 7740,
      perfect_attendance_bonus: 2800, // today's catalog, not the paid amount
      tech_bonus: 0,
      other_bonuses: 900,
      adjustment: 0,
      bonuses_total: 3700,
      mesa_deduction: 0, // opted in AFTER this week was paid
      mesa_disbursement: 0,
      orphanage_pay: 500,
      final: 11940,
    },
  };
}

/** Full post-2026-08-18 snapshot entry — every component as dispatched. */
const fullSaved: ReplayFinalEntry = {
  final: 11007,
  regularPay: 7000,
  otPay: 500,
  regularHours: 40,
  otHours: 1,
  totalHours: 41,
  initial: 7500,
  mesaDeduction: 100,
  mesaDisbursement: 0,
  perfectAttendanceBonus: 2650,
  techBonus: 0,
  otherBonuses: 1200,
  adjustment: -1050,
  orphanagePay: 807,
};

test('full snapshot: every saved component wins and the export row reconciles', () => {
  const merged = overlayReplayFinal(liveRow(), fullSaved);
  assert.equal(merged.pay_php.final, 11007);
  assert.equal(merged.pay_php.perfect_attendance_bonus, 2650);
  assert.equal(merged.pay_php.adjustment, -1050);
  assert.equal(merged.pay_php.orphanage_pay, 807);
  assert.equal(merged.pay_php.mesa_deduction, 100);
  assert.equal(merged.pay_php.bonuses_total, 2650 + 0 + 1200 - 1050);
  assert.equal(merged.hours.total, 41);

  // The point of the overlay: the exported row must satisfy the identity
  // against the SAVED final, which the pre-fix overlay (final only) broke.
  const exportRow = buildPayrollExportRow(merged, 58);
  assert.ok(payrollExportRowReconciles(exportRow));
  assert.equal(exportRow.netPhp, 11007);
});

test('pre-fix shape (final/initial/hours only) fails reconciliation — pinning why components must ride', () => {
  const row = liveRow();
  const brokenMerge = {
    ...row,
    pay_php: { ...row.pay_php, regular: 7000, ot: 500, initial: 7500, final: 11007 },
  };
  const exportRow = buildPayrollExportRow(brokenMerge, 58);
  assert.equal(payrollExportRowReconciles(exportRow), false);
});

test('legacy snapshot (components absent): live figures stay — never overlaid to ₱0', () => {
  const legacy: ReplayFinalEntry = {
    final: 11007,
    regularPay: 7000,
    otPay: 500,
    regularHours: 40,
    otHours: 1,
    totalHours: 41,
    initial: 7500,
  };
  const merged = overlayReplayFinal(liveRow(), legacy);
  // Saved scalars applied…
  assert.equal(merged.pay_php.final, 11007);
  assert.equal(merged.pay_php.initial, 7500);
  // …absent components keep the LIVE fallback (the freeze never wins over an
  // empty saved value), and are NOT zeroed.
  assert.equal(merged.pay_php.perfect_attendance_bonus, 2800);
  assert.equal(merged.pay_php.other_bonuses, 900);
  assert.equal(merged.pay_php.orphanage_pay, 500);
  // bonuses_total recomputed from the effective (here: live) components.
  assert.equal(merged.pay_php.bonuses_total, 2800 + 0 + 900 + 0);
});

test('a saved 0 is a value, not an absence — it overlays', () => {
  const merged = overlayReplayFinal(liveRow(), { ...fullSaved, otherBonuses: 0 });
  assert.equal(merged.pay_php.other_bonuses, 0);
  assert.equal(merged.pay_php.bonuses_total, 2650 + 0 + 0 - 1050);
});

test('extra row fields survive the merge untouched', () => {
  const merged = overlayReplayFinal(liveRow(), fullSaved);
  assert.equal(merged.name, 'Jane Doe');
  assert.equal(merged.email, 'jane@simple.biz');
  assert.equal(merged.department_name, 'Collections');
});

// ── Time adjustments (2026-09-10) ─────────────────────────────────────────────

/** A live row whose approved time-adjustment set has GROWN since dispatch:
 *  one more day was approved for this week after it was paid. */
function liveRowWithAdjustment() {
  return {
    ...liveRow(),
    time_adjustment: {
      hours: 3,
      pay_php: 525,
      days: [
        { date: '2026-08-03', hours: 1 },
        { date: '2026-08-05', hours: 2 }, // approved AFTER the week was paid
      ],
    },
  };
}

test('saved time-adjustment delta wins over the live block — the export shows the delta AS PAID', () => {
  const saved: ReplayFinalEntry = {
    ...fullSaved,
    regularPay: 7000,
    otPay: 500,
    initial: 7675, // 7000 + 500 + 175 as paid
    final: 11182,
    timeAdjustmentHours: 1,
    timeAdjustmentPay: 175,
    timeAdjustmentDays: [{ date: '2026-08-03', hours: 1 }],
  };
  const merged = overlayReplayFinal(liveRowWithAdjustment(), saved);
  assert.deepEqual(merged.time_adjustment, {
    hours: 1,
    pay_php: 175,
    days: [{ date: '2026-08-03', hours: 1 }],
  });
  const exportRow = buildPayrollExportRow(merged, 58);
  assert.equal(exportRow.timeAdjustPay, 175);
  assert.equal(exportRow.timeAdjustDates, '2026-08-03 +1.00h');
  // Regular + OT + Time Adj. Pay = Initial holds against the SAVED figures.
  assert.ok(payrollExportRowReconciles(exportRow));
});

test('legacy snapshot without the delta keeps the LIVE block — never a zeroed one', () => {
  const merged = overlayReplayFinal(liveRowWithAdjustment(), fullSaved);
  assert.deepEqual(merged.time_adjustment, liveRowWithAdjustment().time_adjustment);
});

test('a saved 0h / ₱0 delta is a value, not an absence — it overlays a live non-zero block', () => {
  const saved: ReplayFinalEntry = {
    ...fullSaved,
    timeAdjustmentHours: 0,
    timeAdjustmentPay: 0,
    timeAdjustmentDays: [],
  };
  const merged = overlayReplayFinal(liveRowWithAdjustment(), saved);
  assert.deepEqual(merged.time_adjustment, { hours: 0, pay_php: 0, days: [] });
});

test('hours without pesos (half-written snapshot) is treated as absent — live block kept', () => {
  const saved: ReplayFinalEntry = { ...fullSaved, timeAdjustmentHours: 1 };
  const merged = overlayReplayFinal(liveRowWithAdjustment(), saved);
  assert.deepEqual(merged.time_adjustment, liveRowWithAdjustment().time_adjustment);
});

test('a row that predates the block stays without one under a legacy snapshot', () => {
  const merged = overlayReplayFinal(liveRow(), fullSaved);
  assert.equal('time_adjustment' in merged, false);
  // …and its export cells are blank, not zero.
  const exportRow = buildPayrollExportRow(merged, 58);
  assert.equal(exportRow.timeAdjustHours, null);
  assert.equal(exportRow.timeAdjustPay, null);
  assert.equal(exportRow.timeAdjustDates, '');
});
