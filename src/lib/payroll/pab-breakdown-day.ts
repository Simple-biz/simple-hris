/**
 * One day of the Payroll Wizard's PAB breakdown (`employeeWeekdayHours` /
 * `employeeAllDaysHours`), resolved from the day's raw tracked time and whatever the
 * wizard's forgiveness map holds for it.
 *
 * ## Why this exists (Kane, 2026-10-06)
 *
 * The breakdown used to call a day "forgiven by issue" only when its post-override
 * hours sat between 4h and 7h. Until 2026-10-06 both wizard forgive paths wrote
 * `override_hours: 7`, which lands the day AT 7h — so every day the PAB step or the
 * PAB Calendar forgave read as an ordinary pass: green, `7:00`, missing from the
 * calendar's "Forgiven days" list, and with no Revoke anywhere. The forgiveness was
 * real and paid; it was just invisible and impossible to retract. Those paths now
 * write `null`; the 19 legacy numeric rows still read correctly through this.
 *
 * ## The contract
 *
 * - `seconds` is the post-override verdict input, unchanged: an override SETs the day.
 * - `passes` follows `approvedIssueForgivesDay` (pab-forgiveness.ts), the same rule as
 *   `applyPabAdjustments`: a `null` entry is forgiven OUTRIGHT whatever was tracked
 *   (Kane 2026-10-06, item 363 ruling (b) — it used to be a 4h floor); a number passes
 *   at ≥ 4h. `pab-breakdown-day.test.ts` pins `passes` to the pre-ruling formula on
 *   every input EXCEPT a null entry under 4h, which is the ruling.
 * - `forgivenByDispute` marks a day forgiveness passed that did not pass on its own —
 *   including a day an approved ISSUE forgave at a 7h override (the legacy rows).
 * - `displaySeconds` is what a calendar cell shows: an issue-forgiven day shows its
 *   OWN tracked time, never the override (Kane: forgiven dates "retain their original
 *   hours"). Every other day shows `seconds`, as before.
 */

import { approvedIssueForgivesDay } from './pab-forgiveness';

const SEVEN_HOURS_SEC = 7 * 3600;

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
   * approved issue with no hours set (forgiven outright); a number = SET hours.
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
  const seconds = override != null ? override * 3600 : rawSeconds;

  // Forgiveness passes the day (null = outright; a number at >= 4h), AND the day did not
  // pass on its own: either its post-override hours are under 7h, or an issue's override
  // reached 7h on a day the person did NOT work 7h (the legacy 7h rows — the forgiveness
  // is what passes them, so they must read as forgiven; that second branch only fires
  // when `seconds >= 7h`, where `passes` is already true, so it changes the label only).
  const disputeForgiven =
    override !== undefined &&
    approvedIssueForgivesDay(override) &&
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
