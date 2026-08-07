/**
 * Turns one person's pay week into the itemised breakdown the Payroll Wizard's
 * Validation step renders — and, for HSL, independently re-derives the total from
 * hours and rates so the table can prove itself against the engine.
 *
 * PURE: no React, no fetch, no Date. Every input is passed in by the caller so the
 * whole thing is unit-testable and so the wizard and any future server-side check
 * can run identical arithmetic.
 *
 * Why the table does not simply read the staged dispatch payload: `dispatchData`
 * skips anyone whose personal email cannot be resolved, so sourcing from it would
 * silently drop people from the one screen that certifies the cycle. The caller
 * iterates the calc results and joins the payload in; a row with no payload is
 * flagged `not_dispatchable` rather than hidden.
 */
import {
  HSL_WEEKEND_PREMIUM_PHP,
  OT_DIFFERENTIAL_MULTIPLIER,
  REGULAR_WEEK_CAP_HOURS,
} from '@/lib/payroll/hogan-week-pay';
import { formatPHP } from '@/lib/format-php';

/** Money tolerance. Per-day accumulation rounds once at the end. */
const MONEY_EPSILON_PHP = 0.01;
/** Rates are money; compare to the centavo. */
const RATE_EPSILON_PHP = 0.01;

export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export type ValidationFlagCode =
  | 'no_rate'
  | 'hours_without_pay'
  | 'pay_without_hours'
  | 'negative_gross'
  | 'gross_mismatch'
  | 'not_dispatchable'
  | 'ot_ratio'
  | 'rate_source';

export type ValidationFlag = {
  code: ValidationFlagCode;
  severity: 'red' | 'amber';
  /** Human-readable one-liner shown on the row. */
  message: string;
};

/** The staged dispatch payload's money, flattened. Null when the person has no
 *  personal email and therefore never becomes a dispatch row. */
export type BreakdownDispatch = {
  final: number;
  pab: number;
  tech: number;
  other: number;
  adjustment: number;
  mesaDeduction: number;
  mesaDisbursement: number;
  orphanage: number;
};

export type BreakdownInput = {
  email: string;
  name: string;
  deptKey: string | null;
  deptName: string;
  isHsl: boolean;
  excluded: boolean;
  totalHours: number;
  regularHours: number;
  otHours: number;
  regularRate: number | null;
  otRate: number | null;
  regularPay: number | null;
  otPay: number | null;
  initialPay: number | null;
  /** HSL-only carve-out. Its pay is ALREADY inside regularPay/otPay. */
  weekend: {
    regularHours: number;
    otHours: number;
    regularPay: number | null;
    otPay: number | null;
  } | null;
  rateChange: { from: number | null; to: number | null } | null;
  dispatch: BreakdownDispatch | null;
  rateSourceIssue: {
    shortfallPhp: number;
    sheetRate: number | null;
    paidRate: number | null;
  } | null;
};

export type PayrollBreakdown = {
  email: string;
  name: string;
  deptKey: string | null;
  deptName: string;
  isHsl: boolean;
  excluded: boolean;
  hours: { mf: number; we: number; ot: number; total: number };
  rates: {
    mf: number;
    ot: number | null;
    we: number | null;
    otDifferential: number | null;
  } | null;
  rateChange: { from: number; to: number } | null;
  earnings: {
    base: number;
    weekend: number;
    otPay: number;
    bonuses: number;
    bonusParts: { kpi: number; pab: number; tech: number; other: number };
  };
  adjustments: {
    mesaDeduction: number;
    mesaDisbursement: number;
    adjustment: number;
    orphanage: number;
  };
  gross: number;
  dispatchNet: number | null;
  flags: ValidationFlag[];
};

/**
 * Row-level problems worth stopping on. Deliberately short: seven codes is already
 * near the point where a reviewer stops reading them. A flag earns its place only
 * if it means a number on screen is wrong or will not be paid.
 *
 * Proration note: expected pay is never re-derived as hours × rate here. A dated
 * rate change inside the week makes pay a blend of two rates, so that multiplication
 * legitimately disagrees with the engine. `gross` is summed from the engine's own
 * itemised components instead, which stays correct across a mid-week raise.
 */
function deriveFlags(
  input: BreakdownInput,
  b: Omit<PayrollBreakdown, 'flags'>,
): ValidationFlag[] {
  const flags: ValidationFlag[] = [];
  const hasHours = b.hours.total > 0;
  const hasRate = input.regularRate != null;
  const paidSomething = num(input.initialPay) > 0;

  if (hasHours && !hasRate) {
    flags.push({
      code: 'no_rate',
      severity: 'red',
      message: `${b.hours.total.toFixed(2)}h logged but no pay rate resolved — this line pays nothing.`,
    });
  }

  if (hasHours && hasRate && !paidSomething) {
    flags.push({
      code: 'hours_without_pay',
      severity: 'red',
      message: `${b.hours.total.toFixed(2)}h logged but initial pay is zero.`,
    });
  }

  if (!hasHours && b.gross > 0) {
    flags.push({
      code: 'pay_without_hours',
      severity: 'red',
      message: `${formatPHP(b.gross)} with no hours behind it.`,
    });
  }

  if (b.gross < 0) {
    flags.push({
      code: 'negative_gross',
      severity: 'red',
      message: `Gross is ${formatPHP(b.gross)} — adjustments exceed earnings.`,
    });
  }

  if (b.dispatchNet == null) {
    // No personal email, so `dispatchData` never built a payload. The row shows a
    // figure that will not be paid to anyone. Not a readiness warning — the pay run
    // silently omits this person.
    flags.push({
      code: 'not_dispatchable',
      severity: 'red',
      message: 'No personal email on file — this person is skipped by the pay run entirely.',
    });
  } else if (Math.abs(round2(b.gross - b.dispatchNet)) > MONEY_EPSILON_PHP) {
    const delta = round2(b.dispatchNet - b.gross);
    flags.push({
      code: 'gross_mismatch',
      severity: 'red',
      message:
        `Components sum to ${formatPHP(b.gross)} but dispatch will send ` +
        `${formatPHP(b.dispatchNet)} — a ${formatPHP(Math.abs(delta))} ` +
        `${delta > 0 ? 'surplus' : 'shortfall'} the itemisation does not explain.`,
    });
  }

  // ── Amber: the number is defensible but its SOURCE disagrees with another store.
  // Never blocking. Shown here rather than only on Step 8 because acting on it after
  // the lock means unlocking the cycle.

  // A permanent regression net for the reg+15 corruption fixed 2026-08-04, where the
  // weekend premium had been mis-keyed into the OT rate column and ten HSL people were
  // underpaid on every overtime hour. Expected to report zero — the value is the next one.
  if (input.isHsl && b.rates != null && b.rates.ot != null && b.rates.otDifferential != null) {
    const expectedOtRate = round2(b.rates.mf + b.rates.otDifferential); // mf × 1.5
    // The delta is rounded before comparing because two rounding conventions are both
    // live in this codebase: the Hogan sheet derives the differential two-step
    // (mf × 0.5, then + mf, each step rounded — see hogan-week-pay.ts), while
    // defaultOtRate() in pay-structure.ts computes it single-step (mf × 1.5). At
    // cent-precision rates the two forms can disagree by exactly ₱0.01, and float64
    // can push a true ₱0.01 gap fractionally over RATE_EPSILON_PHP. Rounding the delta
    // first collapses that to exactly 0.01, which the strict `>` then lets through.
    // Do not "simplify" this back to a bare subtraction.
    if (Math.abs(round2(b.rates.ot - expectedOtRate)) > RATE_EPSILON_PHP) {
      const ratio = b.rates.mf > 0 ? b.rates.ot / b.rates.mf : 0;
      flags.push({
        code: 'ot_ratio',
        severity: 'amber',
        message:
          `OT rate is ${formatPHP(b.rates.ot)}/h against a ${formatPHP(b.rates.mf)}/h ` +
          `regular rate — ${ratio.toFixed(2)}×, where the sheet derives ` +
          `${formatPHP(expectedOtRate)}/h (1.50×).`,
      });
    }
  }

  if (input.rateSourceIssue) {
    const { paidRate, sheetRate, shortfallPhp } = input.rateSourceIssue;
    const rates =
      paidRate != null && sheetRate != null
        ? `paid ${formatPHP(paidRate)}/h, sheet says ${formatPHP(sheetRate)}/h`
        : 'the paid rate and the sheet rate disagree';
    const short = shortfallPhp > 0 ? ` — ${formatPHP(shortfallPhp)} short this week.` : '.';
    flags.push({
      code: 'rate_source',
      severity: 'amber',
      message: `Rate sources disagree: ${rates}${short}`,
    });
  }

  return flags;
}

export function buildValidationBreakdown(input: BreakdownInput): PayrollBreakdown {
  const d = input.dispatch;

  const adjustments = {
    mesaDeduction: round2(num(d?.mesaDeduction)),
    mesaDisbursement: round2(num(d?.mesaDisbursement)),
    adjustment: round2(num(d?.adjustment)),
    orphanage: round2(num(d?.orphanage)),
  };

  // The payload's `other_bonuses` carries KPI + departmental performance together;
  // the wizard has no split for them, so it lands in `kpi` and `other` stays 0.
  // Keeping the field means a future split needs no shape change here.
  const bonusParts = {
    kpi: round2(num(d?.other)),
    pab: round2(num(d?.pab)),
    tech: round2(num(d?.tech)),
    other: 0,
  };
  const bonuses = round2(bonusParts.kpi + bonusParts.pab + bonusParts.tech + bonusParts.other);

  const hours = deriveHours(input);
  const rates = deriveRates(input);
  const earnings = { ...deriveEarnings(input, hours, rates), bonuses, bonusParts };

  const gross = round2(
    earnings.base +
      earnings.weekend +
      earnings.otPay +
      earnings.bonuses +
      adjustments.adjustment +
      adjustments.orphanage +
      adjustments.mesaDisbursement -
      adjustments.mesaDeduction,
  );

  const dispatchNet = d ? round2(d.final) : null;

  const rateChange =
    input.rateChange && input.rateChange.from != null && input.rateChange.to != null
      ? { from: input.rateChange.from, to: input.rateChange.to }
      : null;

  const partial: Omit<PayrollBreakdown, 'flags'> = {
    email: input.email,
    name: input.name,
    deptKey: input.deptKey,
    deptName: input.deptName,
    isHsl: input.isHsl,
    excluded: input.excluded,
    hours,
    rates,
    rateChange,
    earnings,
    adjustments,
    gross,
    dispatchNet,
  };
  return { ...partial, flags: deriveFlags(input, partial) };
}

function deriveHours(input: BreakdownInput): PayrollBreakdown['hours'] {
  const total = round2(num(input.totalHours));
  const we = input.weekend
    ? round2(num(input.weekend.regularHours) + num(input.weekend.otHours))
    : 0;
  // HSL follows the sheet: M-F is everything that is not weekend, and it INCLUDES
  // the hours that end up classed as overtime (column AB).
  const mf = input.isHsl ? round2(total - we) : total;
  const ot = input.isHsl
    ? round2(Math.max(0, total - REGULAR_WEEK_CAP_HOURS))
    : round2(num(input.otHours));
  return { mf, we, ot, total };
}

function deriveRates(input: BreakdownInput): PayrollBreakdown['rates'] {
  if (input.regularRate == null) return null;
  const mf = input.regularRate;
  // The sheet DERIVES both of these rather than storing them, which is what makes
  // an off-ratio OT rate inexpressible. Only meaningful for HSL.
  const hsl = input.isHsl && input.weekend != null;
  return {
    mf,
    ot: input.otRate,
    we: hsl ? round2(mf + HSL_WEEKEND_PREMIUM_PHP) : null,
    otDifferential: input.isHsl ? round2(mf * OT_DIFFERENTIAL_MULTIPLIER) : null,
  };
}

function deriveEarnings(
  input: BreakdownInput,
  hours: PayrollBreakdown['hours'],
  rates: PayrollBreakdown['rates'],
): { base: number; weekend: number; otPay: number } {
  // HSL renders the sheet's three-stage form, re-derived from hours and rates. This
  // is the only genuinely independent path in the module: it never reads regularPay
  // or otPay, so a disagreement with the engine is real signal.
  //
  // Requires the weekend carve-out. `CalcRow.weekend` is null for non-HSL rows AND
  // for HSL rows with no per-day columns, where the M-F / WE split is unknowable —
  // those degrade to the base shape rather than guessing.
  if (input.isHsl && input.weekend != null && rates != null && rates.we != null) {
    return {
      base: round2(hours.mf * rates.mf),
      weekend: round2(hours.we * rates.we),
      otPay: round2(hours.ot * num(rates.otDifferential)),
    };
  }
  // Base shape: the engine's own figures. `regularPay` already contains any weekend
  // pay, so the weekend column stays 0 — adding it would double-count.
  return {
    base: round2(num(input.regularPay)),
    weekend: 0,
    otPay: round2(num(input.otPay)),
  };
}

export function buildValidationBreakdowns(inputs: BreakdownInput[]): PayrollBreakdown[] {
  return inputs.map(buildValidationBreakdown);
}

export function countRedFlags(rows: PayrollBreakdown[]): number {
  return rows.filter((r) => r.flags.some((f) => f.severity === 'red')).length;
}
