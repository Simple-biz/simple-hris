import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPayrollExportRow,
  buildPayrollExportRows,
  payrollExportRowReconciles,
  payrollExportRowToAoa,
  PAYROLL_EXPORT_HEADERS,
  type ReportEmployeeLike,
} from './report-rows';

/** Payload-shaped fixture mirroring PayrollWizard's dispatchData builder:
 *  final = initial + bonuses_total − mesa_deduction + mesa_disbursement + orphanage_pay
 *  bonuses_total = pab + tech + other + adjustment. */
function emp(overrides: Partial<ReportEmployeeLike['pay_php']> & {
  name?: string; email?: string; department?: string | null; hours?: number;
} = {}): ReportEmployeeLike {
  const {
    name = 'Jane Doe', email = 'jane@simple.biz', department = 'Collections', hours = 40,
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
