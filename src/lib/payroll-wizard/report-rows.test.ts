import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPayrollExportRow,
  buildPayrollExportRows,
  formatTimeAdjustmentDates,
  payrollExportRowReconciles,
  payrollExportRowToAoa,
  PAYROLL_EXPORT_HEADERS,
  type ReportEmployeeLike,
  type ReportTimeAdjustment,
} from './report-rows';

/** Payload-shaped fixture mirroring PayrollWizard's dispatchData builder:
 *  final = initial + bonuses_total − mesa_deduction + mesa_disbursement + orphanage_pay
 *  bonuses_total = pab + tech + other + adjustment.
 *  `time_adjustment` is passed through verbatim when given; a fixture without
 *  it models a row staged BEFORE the block existed (2026-09-10). */
function emp(overrides: Partial<ReportEmployeeLike['pay_php']> & {
  name?: string; email?: string; department?: string | null; hours?: number;
  time_adjustment?: ReportTimeAdjustment | null;
} = {}): ReportEmployeeLike {
  const {
    name = 'Jane Doe', email = 'jane@simple.biz', department = 'Collections', hours = 40,
    time_adjustment,
    ...pay
  } = overrides;
  const base = {
    regular: 7000 as number | null,
    ot: 500 as number | null,
    perfect_attendance_bonus: 0,
    tech_bonus: 0,
    other_bonuses: 0,
    adjustment: 0,
    mesa_deduction: 0,
    mesa_disbursement: 0,
    orphanage_pay: 0,
    ...pay,
  };
  const initial = 'initial' in pay ? (pay.initial as number | null) : (base.regular ?? 0) + (base.ot ?? 0);
  const bonuses_total =
    'bonuses_total' in pay
      ? (pay.bonuses_total as number)
      : base.perfect_attendance_bonus + base.tech_bonus + base.other_bonuses + base.adjustment;
  const final =
    'final' in pay
      ? (pay.final as number)
      : (initial ?? 0) + bonuses_total - base.mesa_deduction + base.mesa_disbursement + base.orphanage_pay;
  return {
    name, email, department_name: department,
    hours: { total: hours },
    pay_php: { ...base, initial, bonuses_total, final },
    ...(time_adjustment !== undefined ? { time_adjustment } : {}),
  };
}

test('plain salary row reconciles', () => {
  const row = buildPayrollExportRow(emp(), 58);
  assert.ok(payrollExportRowReconciles(row));
  assert.equal(row.netPhp, 7500);
  assert.equal(row.netUsd, Math.round((7500 / 58) * 100) / 100);
});

test('adjustment is itemized apart from earned bonuses and can be NEGATIVE', () => {
  const row = buildPayrollExportRow(
    emp({ perfect_attendance_bonus: 2650, tech_bonus: 500, other_bonuses: 1200, adjustment: -350 }),
    58,
  );
  assert.equal(row.bonusesEarned, 4350); // pab + tech + other, adjustment NOT folded in
  assert.equal(row.adjustment, -350);
  assert.equal(row.bonusesTotal, 4000); // signed total still matches the payload
  assert.ok(payrollExportRowReconciles(row));
});

test('orphanage pay and both MESA legs are carried and the row still adds up', () => {
  const row = buildPayrollExportRow(
    emp({ orphanage_pay: 807, mesa_deduction: 100, mesa_disbursement: 400 }),
    58,
  );
  assert.equal(row.orphanage, 807);
  assert.equal(row.mesaNet, 300);
  assert.ok(payrollExportRowReconciles(row));
});

test('sheet-form HSL shape: null regular/ot, money on initial — still reconciles', () => {
  const row = buildPayrollExportRow(
    emp({ regular: null, ot: null, initial: 9876.54, perfect_attendance_bonus: 2650 }),
    0, // FX unset → no USD column value
  );
  assert.equal(row.regular, null);
  assert.equal(row.netUsd, null);
  assert.ok(payrollExportRowReconciles(row));
});

test('reconciliation catches a component dropped from the total', () => {
  // Simulate the old bug class: orphanage inside `final` but zeroed in the split.
  const broken = buildPayrollExportRow(
    emp({ orphanage_pay: 0, final: 8307 }), // final carries ₱807 nothing itemizes
    58,
  );
  assert.equal(payrollExportRowReconciles(broken), false);
});

test('AoA row aligns 1:1 with the export headers', () => {
  const rows = buildPayrollExportRows([emp()], 58);
  const aoa = payrollExportRowToAoa(rows[0]);
  assert.equal(aoa.length, PAYROLL_EXPORT_HEADERS.length);
  assert.equal(aoa[PAYROLL_EXPORT_HEADERS.indexOf('Net Pay')], rows[0].netPhp);
  assert.equal(aoa[PAYROLL_EXPORT_HEADERS.indexOf('Adjustment')], rows[0].adjustment);
});

// ── Time adjustments (2026-09-10) ─────────────────────────────────────────────
//
// The wizard folds Σ(approved − raw) × regular rate into Initial Pay; the
// payload stages that delta as `time_adjustment` and the export discloses it
// as three columns between OT and Initial Pay. Without them an adjusted row
// read Regular + OT ≠ Initial Pay with nothing in the file explaining why.

const TWO_HOURS: ReportTimeAdjustment = {
  hours: 2,
  pay_php: 350, // 2h × ₱175
  days: [{ date: '2026-09-01', hours: 2 }],
};

test('time-adjusted row: three columns carry the signed delta and Regular + OT + Time Adj. Pay = Initial Pay', () => {
  const row = buildPayrollExportRow(
    emp({ regular: 7000, ot: 500, initial: 7850, time_adjustment: TWO_HOURS }),
    58,
  );
  assert.equal(row.hours, 40); // RAW tracked hours — the adjustment is disclosed beside it, never folded in
  assert.equal(row.timeAdjustHours, 2);
  assert.equal(row.timeAdjustPay, 350);
  assert.equal(row.timeAdjustDates, '2026-09-01 +2.00h');
  assert.equal(row.initial, 7850);
  assert.ok(payrollExportRowReconciles(row));
});

test('a NEGATIVE delta (Accounting set fewer hours than tracked) is carried signed, never gated', () => {
  const row = buildPayrollExportRow(
    emp({
      regular: 7000, ot: 500, initial: 7237.5,
      time_adjustment: { hours: -1.5, pay_php: -262.5, days: [{ date: '2026-09-03', hours: -1.5 }] },
    }),
    58,
  );
  assert.equal(row.timeAdjustHours, -1.5);
  assert.equal(row.timeAdjustPay, -262.5);
  assert.equal(row.timeAdjustDates, '2026-09-03 -1.50h');
  assert.ok(payrollExportRowReconciles(row));
});

test('reconciliation catches a folded delta the block does NOT disclose (the pre-2026-09-10 bug class)', () => {
  // Initial Pay carries ₱350 of time-adjustment money but the block says none.
  const row = buildPayrollExportRow(
    emp({ regular: 7000, ot: 500, initial: 7850, time_adjustment: { hours: 0, pay_php: 0, days: [] } }),
    58,
  );
  assert.equal(payrollExportRowReconciles(row), false);
});

test('no rate resolved: hours are disclosed, pesos are 0, Initial Pay is unchanged — still reconciles', () => {
  const row = buildPayrollExportRow(
    emp({ regular: 7000, ot: 500, time_adjustment: { ...TWO_HOURS, pay_php: 0 } }),
    58,
  );
  assert.equal(row.timeAdjustHours, 2);
  assert.equal(row.timeAdjustPay, 0);
  assert.equal(row.initial, 7500);
  assert.ok(payrollExportRowReconciles(row));
});

test('a row staged BEFORE the block: blank cells (not zeros), and the identity is not asserted against it', () => {
  // Legacy payload: Initial Pay may carry an unexplained delta; the file shows
  // blank Time Adj. cells rather than claiming "0" — and does not fail the row
  // for a gap it cannot state.
  const row = buildPayrollExportRow(emp({ regular: 7000, ot: 500, initial: 7850 }), 58);
  assert.equal(row.timeAdjustHours, null);
  assert.equal(row.timeAdjustPay, null);
  assert.equal(row.timeAdjustDates, '');
  assert.ok(payrollExportRowReconciles(row));
  const aoa = payrollExportRowToAoa(row);
  assert.equal(aoa[PAYROLL_EXPORT_HEADERS.indexOf('Time Adj. Hours')], null);
  assert.equal(aoa[PAYROLL_EXPORT_HEADERS.indexOf('Time Adj. Pay')], null);
  assert.equal(aoa[PAYROLL_EXPORT_HEADERS.indexOf('Time Adj. Dates')], '');
});

test('sheet-form HSL row (null regular/ot) with a block: the third identity is skipped, the others still hold', () => {
  const row = buildPayrollExportRow(
    emp({ regular: null, ot: null, initial: 9876.54, time_adjustment: TWO_HOURS }),
    0,
  );
  assert.equal(row.timeAdjustPay, 350);
  assert.ok(payrollExportRowReconciles(row));
});

test('the dates cell lists every adjusted day oldest-first with its own signed hours', () => {
  assert.equal(
    formatTimeAdjustmentDates([
      { date: '2026-09-04', hours: -0.5 },
      { date: '2026-09-01', hours: 2 },
      { date: '2026-09-02', hours: 0 },
    ]),
    '2026-09-01 +2.00h; 2026-09-02 +0.00h; 2026-09-04 -0.50h',
  );
  assert.equal(formatTimeAdjustmentDates([]), '');
});

test('the three Time Adj. columns sit between OT and Initial Pay, and the AoA still aligns', () => {
  const h = PAYROLL_EXPORT_HEADERS;
  assert.equal(h.indexOf('Time Adj. Hours'), h.indexOf('OT') + 1);
  assert.equal(h.indexOf('Time Adj. Pay'), h.indexOf('OT') + 2);
  assert.equal(h.indexOf('Time Adj. Dates'), h.indexOf('OT') + 3);
  assert.equal(h.indexOf('Initial Pay'), h.indexOf('OT') + 4);
  const rows = buildPayrollExportRows([emp({ regular: 7000, ot: 500, initial: 7850, time_adjustment: TWO_HOURS })], 58);
  const aoa = payrollExportRowToAoa(rows[0]);
  assert.equal(aoa.length, h.length);
  assert.equal(aoa[h.indexOf('Time Adj. Hours')], 2);
  assert.equal(aoa[h.indexOf('Time Adj. Pay')], 350);
  assert.equal(aoa[h.indexOf('Time Adj. Dates')], '2026-09-01 +2.00h');
  assert.equal(aoa[h.indexOf('Initial Pay')], 7850);
});
