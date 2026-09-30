/** Regular hours cap for weekly initial calc (Hubstaff total worked). */
export const REGULAR_WEEK_CAP_HOURS = 40;
const REGULAR_WEEK_CAP_SECONDS = REGULAR_WEEK_CAP_HOURS * 3600;

/**
 * Round total worked hours to 2 decimal places before pay math.
 * Hubstaff / exports usually show 2dp; raw duration math can be 38.7606…h while the UI shows 38.76h,
 * which would otherwise make rate × time disagree with a hand calculator.
 */
export function roundWorkedHoursForPay(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.round(hours * 100) / 100;
}

/**
 * Split total worked into regular vs OT (whole seconds). Cap regular at 40h.
 * Uses {@link roundWorkedHoursForPay} first so pay matches 2-decimal hour totals.
 */
export function splitRegularOvertimeSeconds(totalHours: number): {
  regularSec: number;
  otSec: number;
} {
  const h = roundWorkedHoursForPay(totalHours);
  if (h <= 0) {
    return { regularSec: 0, otSec: 0 };
  }
  const totalSec = Math.round(h * 3600);
  const regularSec = Math.min(totalSec, REGULAR_WEEK_CAP_SECONDS);
  const otSec = Math.max(0, totalSec - regularSec);
  return { regularSec, otSec };
}

/**
 * Split total worked into regular vs OT hours (derived from {@link splitRegularOvertimeSeconds}).
 */
export function splitRegularOvertimeDecimalHours(totalHours: number): {
  regularHours: number;
  otHours: number;
} {
  const { regularSec, otSec } = splitRegularOvertimeSeconds(totalHours);
  return {
    regularHours: regularSec / 3600,
    otHours: otSec / 3600,
  };
}

/**
 * PHP pay for an hourly rate × duration in seconds: (rate × hours) rounded to 2 decimal places.
 * Uses centavos and integer seconds so multiplication matches payroll expectations.
 */
export function phpHourlyPayFromSeconds(ratePhp: number, seconds: number): number {
  if (!Number.isFinite(ratePhp) || seconds <= 0) return 0;
  const payCentavos = Math.round((ratePhp * 100 * seconds) / 3600);
  return payCentavos / 100;
}

/**
 * The first pay week whose non-HSL hours are priced at 2dp HOURS × rate
 * (Kane, 2026-09-30: *"lets not use 4-5 decimals only 2 decimals!"*). Non-HSL
 * weeks run Sun→Sat, so no pay week straddles this Sunday.
 *
 * Before it, the daily-column path priced WHOLE SECONDS while every statement
 * printed 2dp hours, so the printed line did not multiply out: imeer@'s
 * 09-20→09-26 Overtime read `12.54h × ₱427.50 = ₱5,358.71` (12.535h paid).
 * Earlier weeks keep whole-seconds money. They are staged, snapshotted and
 * paid, and a rule change never reaches back (payroll-rule-changes-forward-only).
 *
 * HSL is not gated here. Its sheet form and every genuinely changed week were
 * already 2dp by ruling (`computeHoganWeekPay`, `priceChangedWeek2dp`).
 */
export const TWO_DP_HOURS_PRICING_FROM = '2026-09-27';

/** True when a day in a non-HSL pay week falls on/after {@link TWO_DP_HOURS_PRICING_FROM}. Local calendar date. */
export function pricesAtTwoDpHours(dayInPayWeek: Date | null | undefined): boolean {
  if (!dayInPayWeek || Number.isNaN(dayInPayWeek.getTime())) return false;
  const iso =
    `${dayInPayWeek.getFullYear()}-` +
    `${String(dayInPayWeek.getMonth() + 1).padStart(2, '0')}-` +
    `${String(dayInPayWeek.getDate()).padStart(2, '0')}`;
  return iso >= TWO_DP_HOURS_PRICING_FROM;
}

/**
 * A week's worked seconds as the 2dp hours it is paid on: the total rounded
 * half-up to the hundredth, then split at the 40h cap. The seconds returned
 * are EXACT multiples of 36 (0.01h), so `phpHourlyPayFromSeconds(rate, sec)`
 * is exactly `hours × rate` to the centavo, the figure the statement prints.
 *
 * Rounded on the integer seconds, not `hours × 100`: 18 s is exactly 0.005h,
 * and the float product lands on `…4999…` for about 6% of those (1,147 of
 * the 20,000 halves under 200h), which would round a true half DOWN.
 */
export function splitTwoDpHoursWeek(totalSec: number): {
  totalHours: number;
  regularHours: number;
  otHours: number;
  regularSec: number;
  otSec: number;
} {
  const totalHundredths =
    Number.isFinite(totalSec) && totalSec > 0 ? Math.round(Math.round(totalSec) / 36) : 0;
  const regularHundredths = Math.min(totalHundredths, REGULAR_WEEK_CAP_HOURS * 100);
  const otHundredths = totalHundredths - regularHundredths;
  return {
    totalHours: totalHundredths / 100,
    regularHours: regularHundredths / 100,
    otHours: otHundredths / 100,
    regularSec: regularHundredths * 36,
    otSec: otHundredths * 36,
  };
}
