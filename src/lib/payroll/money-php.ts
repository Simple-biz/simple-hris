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
