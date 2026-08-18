/**
 * HSL (Hogan Smith Law) weekly pay — a faithful translation of the "NEW Payroll
 * Dashboard - Hogan" Google Sheet, which is the authority Accounting pays from.
 *
 * SCOPE: HSL ONLY. Do not route other departments through this module — the weekend
 * premium, the derived OT differential, and the single-rate week are all HSL rules.
 *
 * THE SHEET'S FORMULA  (column AN, "Total Hourly Pay")
 *   =((AB*AC)+(AD*AE))+(AF*AG)+AJ+(AK*AL)
 *
 *   AB "M-F Total Hours"                  Mon–Fri hours, INCLUDING any overtime
 *   AC "M-F Rate"                         the regular hourly rate
 *   AD "WE Hours"                         Sat+Sun hours
 *   AE "Hogan WE Rate"                    == AC + 15
 *   AF "Total OT Hours"                   == max(0, AB + AD - 40)   <- all 7 days count
 *   AG "OT Differential"                  == AC * 0.5
 *   AH "Hours Until OT"                   == max(0, 40 - AB - AD)   (display only)
 *   AI "Orphan Total Hours"               (hours; not money)
 *   AJ "Orphan Hours Total Pay"           flat additive pesos
 *   AK "Mid-week New Rate Total Hours"    hours at the pre-transition rate — NOT implemented
 *   AL "Mid-week Transition Hourly Rate"  the pre-transition rate — NOT implemented
 *
 * AK/AL (the sheet's mid-week transition term) are deliberately ABSENT from this
 * module (ruling 2026-08-18): the sheet excludes the AK hours from its OT
 * threshold, underpaying transition weeks relative to the documented HRIS rule
 * ("OT = max(0, total − 40)" counting ALL hours). Mid-week rate changes price
 * through `priceChangedWeek2dp` in prorate-mid-period.ts instead.
 *
 * Verified against all 6,791 populated rows of the live sheet export — see
 * scripts/verify-hogan-formula.mts. Empirically confirmed on that data:
 *   AE == AC + 15   on every row
 *   AG == AC * 0.5  on every row
 *   AF == max(0, AB + AD - 40)  on 1045/1045 rows that have BOTH weekend and OT hours
 *
 * WHY THIS IS THE TWO-STAGE FORM, AND WHY IT MATCHES OUR OLD ONE
 * `AB` includes the overtime hours, so the base term already pays 1.0x on them; `AF*AG`
 * then tops OT up by the remaining 0.5x. That is algebraically identical to the
 * collapsed form our engine used (regular-excluding-weekend at 1.0x + OT at 1.5x):
 *
 *   (40 + OT - WE)·R + WE·(R+15) + 0.5·OT·R
 *     ≡ (40 - WE)·R + WE·(R+15) + 1.5·OT·R
 *
 * so switching presentation does not move money — PROVIDED the OT rate really is 1.5x.
 * Our old engine multiplied a STORED otRate that could be anything (8 HSL people had
 * `ot = reg + 15`, i.e. the weekend premium mis-keyed into the OT column, and were
 * underpaid every OT hour). Deriving the differential from the regular rate, as the
 * sheet does, removes that whole failure mode.
 *
 * ROUNDING: the sheet multiplies 2-decimal HOURS by the rate. Our previous engine
 * multiplied whole SECONDS (phpHourlyPayFromSeconds), which diverged by ~₱1.14 per
 * stub. The sheet is the payment authority, so this module follows the sheet.
 *
 * POLICY (Kane, 2026-08-11 — supersedes the 2026-08-07 within-cap scoping):
 * this sheet formula IS the HSL pay rule, verbatim. M–F hours never re-rate on
 * their own; ALL Sat+Sun hours earn the +15 premium (past-cap included); the
 * only overtime money is the DERIVED differential — max(0, total − 40) × 0.5 ×
 * regular — never a stored OT rate. Kane's worked example: 43h M–F + 2h WE at
 * ₱235 → 10,105 + 500 + 5 × 117.50 = ₱11,192.50. The 2026-08-07 attempt to
 * scope the premium to within-cap weekend hours (5eb398a) is REVERSED: it made
 * HRIS disagree with the sheet by ₱15/weekend-OT-hour (angelicaco 2026-08-02
 * week: HRIS ₱16,065.74 vs sheet ₱16,115.43).
 *
 * This module is now WIRED INTO THE PAY RUN: the Payroll Wizard's single-rate
 * HSL path and the server engine's constant-rate HSL path (current-pay.ts)
 * both price weeks through {@link computeHoganWeekPay}, so staged pay equals
 * the sheet's column AN to the centavo — 2dp-hours rounding included. Only a
 * genuine mid-week rate change falls back to per-day accumulation
 * (prorate-mid-period.ts / current-pay.ts), which prices the same three legs
 * day by day at each day's rate.
 */

/** The +₱15/h HSL weekend premium: "Hogan WE Rate" is always the regular rate + 15. */
export const HSL_WEEKEND_PREMIUM_PHP = 15;

/** Overtime begins after 40 hours in the pay week, counting ALL seven days. */
export const REGULAR_WEEK_CAP_HOURS = 40;

/** The sheet's "OT Differential" is half the regular rate — the second stage of 1.5x. */
export const OT_DIFFERENTIAL_MULTIPLIER = 0.5;

export type HoganWeekInput = {
  /** Mon–Fri hours worked, INCLUDING any hours that end up classed as overtime. */
  mfHours: number;
  /** Saturday + Sunday hours worked. */
  weHours: number;
  /** "M-F Rate" — the regular hourly rate for the week. */
  regularRatePhp: number;
  /** "Orphan Hours Total Pay" — flat additive pesos. Default 0. */
  orphanPayPhp?: number;
  /** Override the weekend premium. Defaults to the ₱15 HSL rule. */
  weekendPremiumPhp?: number;
};

export type HoganWeekPay = {
  /** Hours, each rounded to 2dp exactly as the sheet stores them. */
  mfHours: number;
  weHours: number;
  totalHours: number;
  otHours: number;
  hoursUntilOt: number;
  /** Rates the sheet derives rather than stores. */
  regularRatePhp: number;
  weekendRatePhp: number;
  otDifferentialPhp: number;
  /** The money terms, in the sheet's own order. */
  basePayPhp: number;
  weekendPayPhp: number;
  otDifferentialPayPhp: number;
  orphanPayPhp: number;
  /** Column AN, "Total Hourly Pay" — the subtotal BEFORE MESA and bonuses. */
  totalHourlyPayPhp: number;
};

/** 2-decimal rounding, half-up on the cent — the sheet's own granularity. */
function r2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Non-negative finite hours; anything else contributes nothing rather than NaN. */
function hours(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return 0;
  return r2(n);
}

/**
 * Compute one HSL pay week the way the Hogan sheet does — for a week that ran
 * at ONE regular rate.
 *
 * Deliberately PURE and free of rate resolution: callers decide which regular
 * rate applies for the week. A week whose rate genuinely changed mid-period is
 * NOT this module's job — it prices through `priceChangedWeek2dp`
 * (prorate-mid-period.ts): 2dp hours × rate per leg, with the 40h OT threshold
 * counting ALL hours worked, pre-change days included (ruling 2026-08-18,
 * "doc stands"). The sheet's own AK/AL transition columns — which exclude the
 * old-rate hours from the OT threshold — were REJECTED and are deliberately
 * not implemented here.
 */
export function computeHoganWeekPay(input: HoganWeekInput): HoganWeekPay {
  const mfHours = hours(input.mfHours);
  const weHours = hours(input.weHours);
  const premium = input.weekendPremiumPhp ?? HSL_WEEKEND_PREMIUM_PHP;
  const regularRatePhp = Number.isFinite(input.regularRatePhp) ? input.regularRatePhp : 0;

  // AF: overtime begins after 40 hours across ALL seven days — a weekend hour counts
  // toward the threshold exactly like a weekday hour. Verified on 1045/1045 sheet rows
  // carrying both weekend and OT hours.
  const totalHours = r2(mfHours + weHours);
  const otHours = r2(Math.max(0, totalHours - REGULAR_WEEK_CAP_HOURS));
  const hoursUntilOt = r2(Math.max(0, REGULAR_WEEK_CAP_HOURS - totalHours));

  // AE and AG are DERIVED, never stored — this is what makes an off-ratio OT rate
  // impossible to express.
  const weekendRatePhp = r2(regularRatePhp + premium);
  const otDifferentialPhp = r2(regularRatePhp * OT_DIFFERENTIAL_MULTIPLIER);

  const basePayPhp = r2(mfHours * regularRatePhp);
  const weekendPayPhp = r2(weHours * weekendRatePhp);
  const otDifferentialPayPhp = r2(otHours * otDifferentialPhp);
  const orphanPayPhp = r2(input.orphanPayPhp ?? 0);

  return {
    mfHours,
    weHours,
    totalHours,
    otHours,
    hoursUntilOt,
    regularRatePhp,
    weekendRatePhp,
    otDifferentialPhp,
    basePayPhp,
    weekendPayPhp,
    otDifferentialPayPhp,
    orphanPayPhp,
    totalHourlyPayPhp: r2(basePayPhp + weekendPayPhp + otDifferentialPayPhp + orphanPayPhp),
  };
}

/**
 * The collapsed presentation our paystubs used before this module: regular hours
 * EXCLUDING weekend at 1.0x, plus OT at the full 1.5x. Provided so a stub can still
 * render the old two lines, and so tests can assert the two forms agree to the centavo.
 *
 * `regularExclWeekendHours` is what the old payload called `Regular Hours` — the
 * 40h-capped regular bucket with the weekend hours carved out of it.
 */
/**
 * The `hogan_sheet` block a staged HSL payload carries (snake_case, jsonb-ready).
 * It is the DISPLAY contract for the sheet-form statement: three lines — M–F at
 * the regular rate, ALL weekend hours at (regular + 15), and the derived OT
 * differential — whose amounts sum exactly to `pay_php.initial`.
 *
 * `rates_php` is null on a genuinely prorated week (a dated mid-week rate
 * change): no single rate can explain a leg then, and the statement renders the
 * proration segments as each line's basis instead. The HOURS and per-leg money
 * stay authoritative either way.
 *
 * Bucket compatibility: `pay_php.regular` on the payload = base + weekend legs
 * and `pay_php.ot` = the differential leg, so `initial = regular + ot` and every
 * total-summing consumer is untouched. `hours.regular`/`hours.ot` keep their
 * chronological 40h-cap partition — this block is what corrects the DISPLAYED
 * weekday hours (M–F includes the past-cap hours, exactly like the sheet's AB).
 */
export interface HoganSheetBlockRaw {
  mf_hours: number;
  we_hours: number;
  ot_hours: number;
  rates_php: {
    regular: number;
    weekend: number;
    ot_differential: number;
  } | null;
  pay_php: {
    base: number;
    weekend: number;
    ot_differential: number;
  };
}

/** Build the payload block from a computed single-rate week. */
export function hoganSheetBlockFromWeekPay(pay: HoganWeekPay): HoganSheetBlockRaw {
  return {
    mf_hours: pay.mfHours,
    we_hours: pay.weHours,
    ot_hours: pay.otHours,
    rates_php: {
      regular: pay.regularRatePhp,
      weekend: pay.weekendRatePhp,
      ot_differential: pay.otDifferentialPhp,
    },
    pay_php: {
      base: pay.basePayPhp,
      weekend: pay.weekendPayPhp,
      ot_differential: pay.otDifferentialPayPhp,
    },
  };
}

export function collapsedEquivalent(pay: HoganWeekPay): {
  regularExclWeekendHours: number;
  regularExclWeekendPayPhp: number;
  otHours: number;
  otRatePhp: number;
  otPayPhp: number;
  totalPhp: number;
} {
  const cappedRegular = r2(Math.min(pay.totalHours, REGULAR_WEEK_CAP_HOURS));
  const regularExclWeekendHours = r2(Math.max(0, cappedRegular - pay.weHours));
  const otRatePhp = r2(pay.regularRatePhp * 1.5);
  const regularExclWeekendPayPhp = r2(regularExclWeekendHours * pay.regularRatePhp);
  const otPayPhp = r2(pay.otHours * otRatePhp);
  return {
    regularExclWeekendHours,
    regularExclWeekendPayPhp,
    otHours: pay.otHours,
    otRatePhp,
    otPayPhp,
    totalPhp: r2(regularExclWeekendPayPhp + pay.weekendPayPhp + otPayPhp),
  };
}
