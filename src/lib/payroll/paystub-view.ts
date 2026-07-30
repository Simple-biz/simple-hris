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
  /**
   * HSL weekend (Sat+Sun) itemization. `mfHours`/`mfPay` (and the OT pair) stay
   * the FULL week totals — weekend included — exactly as staged/paid, so every
   * total-summing consumer (lists, exports, the Net figure) is untouched. When
   * `hasWeekend` is true the statement splits the earnings rows instead:
   * Regular/Overtime render the weekday-only figures and two Weekend rows carry
   * the Sat+Sun hours at the premium rate (base + ₱15/h). Weekend hours can sit
   * in EITHER bucket — a weekend day past the 40h cap is weekend OT — which is
   * why both a regular and an OT weekend line exist. Non-HSL payloads (and
   * payloads staged before this field existed) have `hasWeekend: false` and all
   * weekend fields zero; weekday === mf then.
   */
  hasWeekend: boolean;
  weekendHours: number;
  weekendOtHours: number;
  /** Effective weekend rates = displayed base rate + the per-hour premium. */
  weekendRate: number;
  weekendOtRate: number;
  weekendPay: number;
  weekendOtPay: number;
  weekdayHours: number;
  weekdayOtHours: number;
  weekdayPay: number;
  weekdayOtPay: number;
  techBonus: number;
  attendanceBonus: number;
  performanceBonus: number;
  adjustment: number;
  adjustmentNote: string | null;
  /** Accounting orphanage pay — a positive amount added on top of pay, its own line. */
  orphanagePay: number;
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

/** Default HSL weekend premium (₱/h) for payloads that predate carrying it. */
export const WEEKEND_PREMIUM_PHP_PER_HOUR = 15;

/** Normalized weekend figures as staged on a payload / snapshot. */
export interface WeekendFigures {
  hours: number;
  otHours: number;
  pay: number;
  otPay: number;
  premiumPerHour: number;
}

/**
 * The weekday/weekend split every renderer shares. Weekend amounts are the
 * staged truth; the weekday lines are derived by SUBTRACTION from the full
 * totals, so the four earnings lines always sum back to exactly
 * `mfPay + otPay` no matter how the two sides were rounded when staged.
 */
export function deriveWeekendFields(
  base: { mfHours: number; mfOtHours: number; mfRate: number; otRate: number; mfPay: number; otPay: number },
  weekend: WeekendFigures | null,
): Pick<
  PayStubView,
  | 'hasWeekend'
  | 'weekendHours'
  | 'weekendOtHours'
  | 'weekendRate'
  | 'weekendOtRate'
  | 'weekendPay'
  | 'weekendOtPay'
  | 'weekdayHours'
  | 'weekdayOtHours'
  | 'weekdayPay'
  | 'weekdayOtPay'
> {
  if (!weekend) {
    return {
      hasWeekend: false,
      weekendHours: 0,
      weekendOtHours: 0,
      weekendRate: 0,
      weekendOtRate: 0,
      weekendPay: 0,
      weekendOtPay: 0,
      weekdayHours: base.mfHours,
      weekdayOtHours: base.mfOtHours,
      weekdayPay: base.mfPay,
      weekdayOtPay: base.otPay,
    };
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    hasWeekend: true,
    weekendHours: weekend.hours,
    weekendOtHours: weekend.otHours,
    weekendRate: round2(base.mfRate + weekend.premiumPerHour),
    weekendOtRate: round2(base.otRate + weekend.premiumPerHour),
    weekendPay: weekend.pay,
    weekendOtPay: weekend.otPay,
    weekdayHours: Math.max(0, round2(base.mfHours - weekend.hours)),
    weekdayOtHours: Math.max(0, round2(base.mfOtHours - weekend.otHours)),
    weekdayPay: round2(base.mfPay - weekend.pay),
    weekdayOtPay: round2(base.otPay - weekend.otPay),
  };
}

/**
 * Parse a payload's `weekend` block (HSL rows only — see `DispatchEmployee` in
 * PayrollWizard). Absent/null → null, which renders the classic two-line
 * earnings section, so payloads staged before this field existed are untouched.
 */
export function parseWeekendBlock(payload: Json): WeekendFigures | null {
  const p = obj(payload);
  if (!p.weekend || typeof p.weekend !== 'object') return null;
  const w = obj(p.weekend);
  const hours = obj(w.hours);
  const pay = obj(w.pay_php);
  const premium = num(w.premium_php_per_hour);
  return {
    hours: num(hours.regular),
    otHours: num(hours.ot),
    pay: num(pay.regular),
    otPay: num(pay.ot),
    premiumPerHour: premium > 0 ? premium : WEEKEND_PREMIUM_PHP_PER_HOUR,
  };
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

  const baseFigures = {
    mfHours: num(hours.regular),
    mfOtHours: num(hours.ot),
    mfRate: num(rates.regular),
    otRate: num(rates.ot),
    mfPay: num(pay.regular),
    otPay: num(pay.ot),
  };

  return {
    name: str(p.name),
    department: str(p.department_name) || '—',
    weekStart,
    weekEnd,
    weekHuman: formatWeekHuman(weekStart, weekEnd),
    salaryDate: period.salary_date ? str(period.salary_date) : null,
    ...baseFigures,
    ...deriveWeekendFields(baseFigures, parseWeekendBlock(payload)),
    techBonus: num(pay.tech_bonus),
    attendanceBonus: num(pay.perfect_attendance_bonus),
    performanceBonus: num(pay.other_bonuses),
    adjustment: num(pay.adjustment),
    adjustmentNote: p.adjustment_note ? str(p.adjustment_note) : null,
    orphanagePay: num(pay.orphanage_pay),
    mesaDisbursement: num(pay.mesa_disbursement),
    mesaDeduction: num(pay.mesa_deduction),
    totalPayPhp,
    fxRate,
    totalPayUsd: Math.round((totalPayPhp / fxRate) * 100) / 100,
  };
}
