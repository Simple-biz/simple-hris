/**
 * Maps a staged `paystub_dispatch_queue.payload` (the exact per-employee
 * `DispatchEmployee` object the Payroll Wizard sends to n8n) into the flat field
 * set the paystub email template renders — the n8n `pay_vars` node
 * (`references/n8n/Paystub Automation.json`) and `docs/features/paystub.html`.
 *
 * This is the single source of truth so the in-app Pay Stub modal shows the
 * IDENTICAL numbers and layout the employee received by email. Keep this mapping
 * in lockstep with the n8n `pay_vars` Set node if the email template changes.
 */

export interface PayStubView {
  name: string;
  department: string;
  weekStart: string | null;
  weekEnd: string | null;
  /** "Jul 7 – Jul 13, 2026" — the email's `week_human`. */
  weekHuman: string;
  salaryDate: string | null;
  mfHours: number;
  mfOtHours: number;
  mfRate: number;
  otRate: number;
  mfPay: number;
  otPay: number;
  techBonus: number;
  attendanceBonus: number;
  performanceBonus: number;
  adjustment: number;
  adjustmentNote: string | null;
  mesaDisbursement: number;
  mesaDeduction: number;
  totalPayPhp: number;
  fxRate: number;
  /** `total_pay_php / fx_rate`, already rounded to 2dp like the email. */
  totalPayUsd: number;
}

type Json = Record<string, unknown> | null | undefined;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Parse a plain "YYYY-MM-DD" without TZ drift (server + client agree). */
function parseYmd(iso: string | null): { y: number; m: number; d: number } | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** "Jul 7 – Jul 13, 2026" (mirrors the email's `week_human`). */
export function formatWeekHuman(start: string | null, end: string | null): string {
  const s = parseYmd(start);
  const e = parseYmd(end);
  if (s && e) {
    const left = `${MONTHS[s.m - 1] ?? ''} ${s.d}`;
    const right = `${MONTHS[e.m - 1] ?? ''} ${e.d}, ${e.y}`;
    return `${left} – ${right}`;
  }
  if (e) return `${MONTHS[e.m - 1] ?? ''} ${e.d}, ${e.y}`;
  if (s) return `${MONTHS[s.m - 1] ?? ''} ${s.d}, ${s.y}`;
  return '';
}

/**
 * Build the paystub view from a staged payload. `payPeriod` is the queue row's
 * `pay_period` column; the payload also carries its own `pay_period`, so we fall
 * back to whichever resolves the week + fx rate.
 */
export function mapPayloadToPayStub(payload: Json, payPeriod?: Json): PayStubView {
  const p = obj(payload);
  const hours = obj(p.hours);
  const rates = obj(p.rates_php);
  const pay = obj(p.pay_php);
  // Prefer the payload's own pay_period; fall back to the queue row's column.
  const period = obj(p.pay_period ?? payPeriod);
  const week = obj(period.week);

  const weekStart = week.start ? str(week.start) : null;
  const weekEnd = week.end ? str(week.end) : null;
  const fxRateRaw = num(period.fx_rate);
  const fxRate = fxRateRaw > 0 ? fxRateRaw : 58;
  const totalPayPhp = num(pay.final);

  return {
    name: str(p.name),
    department: str(p.department_name) || '—',
    weekStart,
    weekEnd,
    weekHuman: formatWeekHuman(weekStart, weekEnd),
    salaryDate: period.salary_date ? str(period.salary_date) : null,
    mfHours: num(hours.regular),
    mfOtHours: num(hours.ot),
    mfRate: num(rates.regular),
    otRate: num(rates.ot),
    mfPay: num(pay.regular),
    otPay: num(pay.ot),
    techBonus: num(pay.tech_bonus),
    attendanceBonus: num(pay.perfect_attendance_bonus),
    performanceBonus: num(pay.other_bonuses),
    adjustment: num(pay.adjustment),
    adjustmentNote: p.adjustment_note ? str(p.adjustment_note) : null,
    mesaDisbursement: num(pay.mesa_disbursement),
    mesaDeduction: num(pay.mesa_deduction),
    totalPayPhp,
    fxRate,
    totalPayUsd: Math.round((totalPayPhp / fxRate) * 100) / 100,
  };
}
