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
//   regular + ot + timeAdjustPay = initial        (when the payload carries the block)
//
// (mirrors `finalPay` / `bonusTotal` in PayrollWizard's dispatchData builder
// and the live guard in scripts/verify-dispatch-carryover.mts).
//
// The Adjustment is a SIGNED delta — never gate its display on `> 0`
// (memory: dispatch-wizard-values-precedence).
//
// Time adjustments (2026-09-10): an approved time-adjustment request SETS a
// day's hours at calculation time, and the wizard folds the resulting pesos
// (Σ(approved − raw) over in-period dates × the regular rate) into Initial Pay
// — so before this block existed an adjusted row exported Regular + OT ≠
// Initial Pay with nothing in the file explaining the gap. The payload now
// stages the delta as `time_adjustment` and the export carries it as three
// columns (signed hours, signed pesos, the dates) between OT and Initial Pay.
// `Hours` stays the RAW tracked total; the adjustment is disclosed beside it,
// never folded in (Hubstaff data is never mutated —
// docs/features/time-adjustment-requests.md).

/** One in-period approved time-adjustment day: the ISO date and the SIGNED
 *  hours delta (approved − raw tracked) it contributed. */
export interface ReportTimeAdjustmentDay {
  date: string;
  hours: number;
}

/** The `time_adjustment` block of a staged DispatchEmployee payload. Staged on
 *  EVERY payload since 2026-09-10 — zeros + `[]` when the person had no
 *  in-period approved adjustment — so "none" and "predates the block" stay
 *  distinguishable in the file. `pay_php` is the exact signed peso amount the
 *  wizard added to Initial Pay (0 when no rate resolved, even if hours ≠ 0). */
export interface ReportTimeAdjustment {
  hours: number;
  pay_php: number;
  days: ReportTimeAdjustmentDay[];
}

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
  /** Absent/undefined only on rows that predate the block (a legacy replay
   *  whose live recompute somehow lacks it) — every payload staged since
   *  2026-09-10 carries it. */
  time_adjustment?: ReportTimeAdjustment | null;
}

/** Fully itemized export row — one per employee, same field set for XLSX and PDF. */
export interface PayrollExportRow {
  name: string;
  email: string;
  department: string;
  /** RAW tracked hours (Hubstaff). Time adjustments are disclosed beside it, never folded in. */
  hours: number;
  regular: number | null;
  ot: number | null;
  /** SIGNED approved time-adjustment hours in this period; null = the row predates the block. */
  timeAdjustHours: number | null;
  /** SIGNED pesos the adjustment added to Initial Pay; null = the row predates the block. */
  timeAdjustPay: number | null;
  /** `YYYY-MM-DD +2.00h; …` — the adjusted dates; '' when none or unknown. */
  timeAdjustDates: string;
  /** regular + ot + timeAdjustPay. */
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

/** Signed 2dp hours label: `+2.00h` / `-0.50h`. */
function signedHours(h: number): string {
  const fixed = Math.abs(h).toFixed(2);
  return `${h < 0 ? '-' : '+'}${fixed}h`;
}

/**
 * The `Time Adj. Dates` cell: every adjusted in-period day with its signed
 * hours delta, oldest first, `; `-joined — so the sheet reconciler can see
 * WHICH days moved, not just how much. '' for no days.
 */
export function formatTimeAdjustmentDates(days: readonly ReportTimeAdjustmentDay[]): string {
  return [...days]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((d) => `${d.date} ${signedHours(d.hours)}`)
    .join('; ');
}

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
  const ta = e.time_adjustment ?? null;
  return {
    name: e.name ?? '',
    email: e.email,
    department: e.department_name ?? '',
    hours: e.hours.total,
    regular: p.regular,
    ot: p.ot,
    timeAdjustHours: ta ? ta.hours : null,
    timeAdjustPay: ta ? ta.pay_php : null,
    timeAdjustDates: ta ? formatTimeAdjustmentDates(ta.days ?? []) : '',
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
  'Time Adj. Hours',
  'Time Adj. Pay',
  'Time Adj. Dates',
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
    r.timeAdjustHours,
    r.timeAdjustPay,
    r.timeAdjustDates,
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
 *   regular + ot + timeAdjustPay = initial
 *
 * The third identity is checked only when the row can state it: the payload
 * carried the time-adjustment block AND both Regular and OT are figures. A row
 * that predates the block (null `timeAdjustPay`) is not failed for a gap it
 * cannot explain — the file shows blank Time Adj. cells for it instead.
 */
export function payrollExportRowReconciles(r: PayrollExportRow): boolean {
  const componentsSum =
    (r.initial ?? 0) + r.bonusesTotal + r.orphanage + r.mesaDisbursement - r.mesaDeduction;
  const splitSum = r.pab + r.tech + r.otherBonuses + r.adjustment;
  const initialStated =
    r.timeAdjustPay == null || r.regular == null || r.ot == null || r.initial == null
      ? true
      : Math.abs(r.regular + r.ot + r.timeAdjustPay - r.initial) < 0.005;
  return (
    Math.abs(componentsSum - r.netPhp) < 0.005 &&
    Math.abs(splitSum - r.bonusesTotal) < 0.005 &&
    initialStated
  );
}
