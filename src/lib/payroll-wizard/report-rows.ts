// Payroll Wizard — Reports step export rows (shared by the XLSX and PDF exports).
//
// The Reports step's `snap.employees` IS the staged dispatch payload
// (DispatchEmployee.pay_php), so every component the money is made of is
// already itemized: PAB, Tech, other/KPI bonuses, the signed Accounting
// Adjustment, orphanage pay, and both MESA legs. The exports used to flatten
// that into a single "Bonuses" column (which silently swallowed the
// Adjustment) and omitted Orphanage entirely, so an exported row could not be
// reconciled: Regular + OT + Bonuses + MESA ≠ Net Pay.
//
// This module is the one place export rows are built from the payload, and it
// carries the reconciliation identity as a testable function:
//
//   initial + bonusesTotal + orphanage + mesaDisbursement − mesaDeduction = net
//   bonusesTotal = pab + tech + otherBonuses + adjustment
//
// (mirrors `finalPay` / `bonusTotal` in PayrollWizard's dispatchData builder
// and the live guard in scripts/verify-dispatch-carryover.mts).
//
// The Adjustment is a SIGNED delta — never gate its display on `> 0`
// (memory: dispatch-wizard-values-precedence).

/** The `pay_php` block of a staged DispatchEmployee payload. */
export interface ReportPayPhp {
  regular: number | null;
  ot: number | null;
  initial: number | null;
  bonuses_total: number;
  perfect_attendance_bonus: number;
  tech_bonus: number;
  other_bonuses: number;
  adjustment: number;
  mesa_deduction: number;
  mesa_disbursement: number;
  orphanage_pay: number;
  final: number;
}

/** The slice of DispatchEmployee the exports read. */
export interface ReportEmployeeLike {
  name: string | null;
  email: string;
  department_name: string | null;
  hours: { total: number };
  pay_php: ReportPayPhp;
}

/** Fully itemized export row — one per employee, same field set for XLSX and PDF. */
export interface PayrollExportRow {
  name: string;
  email: string;
  department: string;
  hours: number;
  regular: number | null;
  ot: number | null;
  initial: number | null;
  /** Earned bonuses only: PAB + Tech + other/KPI. Never negative. */
  bonusesEarned: number;
  pab: number;
  tech: number;
  otherBonuses: number;
  /** Accounting Adj. — SIGNED delta, itemized apart from earned bonuses. */
  adjustment: number;
  /** pab + tech + otherBonuses + adjustment (the payload's bonuses_total). Signed. */
  bonusesTotal: number;
  orphanage: number;
  mesaDeduction: number;
  mesaDisbursement: number;
  /** Net MESA (disbursement − deduction); signed. */
  mesaNet: number;
  netPhp: number;
  netUsd: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildPayrollExportRow(
  e: ReportEmployeeLike,
  usdToPhpRate: number,
): PayrollExportRow {
  const p = e.pay_php;
  const pab = p.perfect_attendance_bonus ?? 0;
  const tech = p.tech_bonus ?? 0;
  const other = p.other_bonuses ?? 0;
  const adjustment = p.adjustment ?? 0;
  const mesaDeduction = p.mesa_deduction ?? 0;
  const mesaDisbursement = p.mesa_disbursement ?? 0;
  return {
    name: e.name ?? '',
    email: e.email,
    department: e.department_name ?? '',
    hours: e.hours.total,
    regular: p.regular,
    ot: p.ot,
    initial: p.initial,
    bonusesEarned: pab + tech + other,
    pab,
    tech,
    otherBonuses: other,
    adjustment,
    bonusesTotal: p.bonuses_total,
    orphanage: p.orphanage_pay ?? 0,
    mesaDeduction,
    mesaDisbursement,
    mesaNet: mesaDisbursement - mesaDeduction,
    netPhp: p.final ?? 0,
    netUsd: usdToPhpRate > 0 ? round2((p.final ?? 0) / usdToPhpRate) : null,
  };
}

export function buildPayrollExportRows(
  employees: ReportEmployeeLike[],
  usdToPhpRate: number,
): PayrollExportRow[] {
  return employees.map((e) => buildPayrollExportRow(e, usdToPhpRate));
}

/** XLSX header row — full itemization, in reconciliation order. */
export const PAYROLL_EXPORT_HEADERS = [
  'Employee',
  'Email',
  'Department',
  'Hours',
  'Regular',
  'OT',
  'Initial Pay',
  'PAB Bonus',
  'Tech Bonus',
  'Other Bonuses',
  'Adjustment',
  'Bonuses Total',
  'Orphanage',
  'MESA Deduction',
  'MESA Disbursement',
  'Net Pay',
  'Net Pay (USD)',
] as const;

/** One XLSX AoA data row, aligned with {@link PAYROLL_EXPORT_HEADERS}. */
export function payrollExportRowToAoa(r: PayrollExportRow): (string | number | null)[] {
  return [
    r.name,
    r.email,
    r.department,
    r.hours,
    r.regular,
    r.ot,
    r.initial,
    r.pab,
    r.tech,
    r.otherBonuses,
    r.adjustment,
    r.bonusesTotal,
    r.orphanage,
    r.mesaDeduction,
    r.mesaDisbursement,
    r.netPhp,
    r.netUsd,
  ];
}

/**
 * The reconciliation identity every exported row must satisfy (2-decimal
 * tolerance for float noise):
 *   initial + bonusesTotal + orphanage + mesaDisbursement − mesaDeduction = net
 *   bonusesTotal = pab + tech + otherBonuses + adjustment
 */
export function payrollExportRowReconciles(r: PayrollExportRow): boolean {
  const componentsSum =
    (r.initial ?? 0) + r.bonusesTotal + r.orphanage + r.mesaDisbursement - r.mesaDeduction;
  const splitSum = r.pab + r.tech + r.otherBonuses + r.adjustment;
  return (
    Math.abs(componentsSum - r.netPhp) < 0.005 &&
    Math.abs(splitSum - r.bonusesTotal) < 0.005
  );
}
