/**
 * One day of the Payroll Wizard's PAB breakdown (`employeeWeekdayHours` /
 * `employeeAllDaysHours`), resolved from the day's raw tracked time and whatever the
 * wizard's forgiveness map holds for it.
 *
 * ## Why this exists (Kane, 2026-10-06)
 *
 * The breakdown used to call a day "forgiven by issue" only when its post-override
 * hours sat between 4h and 7h. Both wizard forgive paths write `override_hours: 7`
 * (payroll-wizard-pab-step.md), which lands the day AT 7h — so every day the PAB step
 * or the PAB Calendar forgave read as an ordinary pass: green, `7:00`, missing from
 * the calendar's "Forgiven days" list, and with no Revoke anywhere. The forgiveness
 * was real and paid; it was just invisible and impossible to retract.
 *
 * ## The contract
 *
 * - `seconds` and `passes` are EXACTLY what the breakdown computed before. They feed
 *   the verdict (`pabStatusByEmail`, the PAB step's severity, the HSL week walk), and
 *   `pab-breakdown-day.test.ts` pins them against the old formula over a grid of
 *   inputs. Nothing here moves PAB money.
 * - `forgivenByDispute` additionally recognises a day an approved ISSUE forgave whose
 *   own tracked time was under 7h — the 7h-override case above.
 * - `displaySeconds` is what a calendar cell shows: an issue-forgiven day shows its
 *   OWN tracked time, never the override (Kane: forgiven dates "retain their original
 *   hours"). Every other day shows `seconds`, as before.
 */

const SEVEN_HOURS_SEC = 7 * 3600;
const FOUR_HOURS_SEC = 4 * 3600;

export type PabBreakdownDay = {
  /** Post-override seconds — the verdict input. Unchanged from the pre-2026-10-06 formula. */
  seconds: number;
  /** What the calendar cell shows. Raw tracked time on an issue-forgiven day. */
  displaySeconds: number;
  passes: boolean;
  forgivenByDispute: boolean;
  forgivenByHoliday: boolean;
};

export function classifyPabBreakdownDay(args: {
  /** Tracked Hubstaff seconds for the day, before any forgiveness. */
  rawSeconds: number;
  /**
   * The forgiveness map's value for this day: `undefined` = no entry; `null` = an
   * entry with no hours (floor-drop); a number = SET hours.
   */
  override: number | null | undefined;
  /**
   * The entry comes from an approved PAB issue (`pab_day_disputes`) — not from an
   * approved time adjustment (real hours, which win a same-day collision) and not
   * from the orphanage coverage overlay.
   */
  fromIssue: boolean;
  isHoliday: boolean;
}): PabBreakdownDay {
  const { rawSeconds, override, fromIssue, isHoliday } = args;
  const hasEntry = override !== undefined;
  const seconds = override != null ? override * 3600 : rawSeconds;

  // Pre-2026-10-06: an entry whose post-override hours sit in [4h, 7h).
  // Added: an issue whose override reaches 7h on a day the person did NOT work 7h —
  // the forgiveness is what passes it, so it must read as forgiven. This branch can
  // only fire when `seconds >= 7h`, where `passes` is already true, so it changes
  // the label and never the verdict.
  const disputeForgiven =
    hasEntry &&
    seconds >= FOUR_HOURS_SEC &&
    (seconds < SEVEN_HOURS_SEC || (fromIssue && rawSeconds < SEVEN_HOURS_SEC));
  // Holidays take precedence over dispute classification — a holiday passes regardless.
  const holidayForgiven = isHoliday && seconds < SEVEN_HOURS_SEC;

  const forgivenByDispute = disputeForgiven && !holidayForgiven;
  return {
    seconds,
    displaySeconds: fromIssue && forgivenByDispute ? rawSeconds : seconds,
    passes: seconds >= SEVEN_HOURS_SEC || disputeForgiven || isHoliday,
    forgivenByDispute,
    forgivenByHoliday: holidayForgiven,
  };
}
