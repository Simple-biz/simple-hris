/**
 * Where the New Hire Checklist's orientation day comes from.
 *
 * The checklist week is Sun-anchored, so hires start and orient the **Monday**
 * of that week — that is the DEFAULT, not the rule. As of 2026-09-03, a Monday
 * that falls on an enabled US holiday advances to the next non-holiday weekday,
 * and keeps advancing while that day is a holiday too (Kane, 2026-09-03: "If
 * there is a holiday on monday then move it the next day if there is another
 * holiday in there then move it to the next").
 *
 * WHY THIS FILE EXISTS AT ALL: the date is published in two places — the n8n
 * welcome email (`buildLockWebhookPayload`) and the "Orientation date:" line in
 * the Lock-in dialog HR confirms before the send. Those two MUST agree; a
 * dialog that promises Monday while the email says Tuesday is worse than no
 * shift at all. So the walk lives here, pure and tested, and both sides call
 * it. Never re-derive an orientation date anywhere else.
 *
 * The holiday map is the SAME one PAB forgiveness uses — `getEnabledHolidayMap`
 * over `us_holidays_list` / `us_holidays_enabled` (docs/reference/business-logic.md
 * § US Holiday forgiveness). An entry with `enabled: false`, or the master
 * toggle off, yields an empty map and therefore no shift: a holiday that does
 * not forgive PAB does not move orientation either. One calendar, one meaning.
 *
 * NOTE: that list is US federal holidays. A Philippine holiday is not in it and
 * will not move anything.
 */

/** Monday of the Sun-anchored checklist week. The unshifted default. */
export const ORIENT_OFFSET_DAYS = 1;

/** Hard ceiling on the walk. Mon->Fri is 4 hops; 7 makes a loop impossible. */
const MAX_WALK_STEPS = 7;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** A holiday the walk stepped over, in the order it was met. */
export type OrientationHolidaySkip = {
  /** ISO date that was rejected. */
  date: string;
  /** Holiday name as configured, e.g. "Labor Day". */
  name: string;
};

export type OrientationResolution =
  | {
      ok: true;
      /** ISO date orientation actually happens on. */
      date: string;
      /** Full weekday name of `date`, e.g. "Tuesday". */
      weekday: string;
      /** The unshifted Monday, kept so the UI can say what it moved FROM. */
      baseDate: string;
      /** Full weekday name of `baseDate` — always "Monday" for a sane week. */
      baseWeekday: string;
      /** True when `date` !== `baseDate`. */
      shifted: boolean;
      /** Holidays walked past. Empty unless `shifted`. */
      skipped: OrientationHolidaySkip[];
    }
  | {
      ok: false;
      /**
       * `bad_period`           — periodStart is not a YYYY-MM-DD date.
       * `no_weekday_left`      — every remaining weekday in the week is a holiday,
       *                          so there is nowhere inside this week to put
       *                          orientation. A human picks the date.
       * `calendar_unavailable` — the holiday calendar could not be READ or parsed.
       *                          Distinct from "no holidays configured", which is a
       *                          real answer (no shift). A failed read is not an
       *                          answer, and must never degrade to the plain Monday.
       *
       * In every case the caller must NOT send.
       */
      reason: "bad_period" | "no_weekday_left" | "calendar_unavailable";
      baseDate: string | null;
      skipped: OrientationHolidaySkip[];
    };

/** Shift a YYYY-MM-DD date by `n` days (UTC math, so no server-TZ drift). */
export function addDaysIso(iso: string, n: number): string | null {
  if (!ISO_DATE.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** Full weekday name for a YYYY-MM-DD date (e.g. "Monday"). */
export function weekdayNameOf(iso: string | null): string | null {
  if (!iso || !ISO_DATE.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAY_NAMES[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()] ?? null;
}

/** Mon–Fri. Orientation never lands on a weekend, however many holidays stack up. */
function isWeekday(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/**
 * Resolve the orientation day for a Sun-anchored checklist week.
 *
 * Walks forward from the Monday while the candidate is an enabled holiday, and
 * refuses rather than guessing if it runs out of weekdays — a week whose every
 * remaining weekday is a holiday has no automatic answer, and inventing one
 * (Saturday, or next week) would mail 31 people a date nobody chose.
 *
 * @param periodStart the week's Sunday anchor, `YYYY-MM-DD`
 * @param holidays    ISO date -> holiday name, from `getEnabledHolidayMap`
 */
export function resolveOrientationDate(
  periodStart: string,
  holidays: ReadonlyMap<string, string>,
): OrientationResolution {
  const base = addDaysIso((periodStart ?? "").trim(), ORIENT_OFFSET_DAYS);
  if (!base) return { ok: false, reason: "bad_period", baseDate: null, skipped: [] };

  const skipped: OrientationHolidaySkip[] = [];
  let candidate = base;

  for (let step = 0; step <= MAX_WALK_STEPS; step += 1) {
    const holiday = holidays.get(candidate);
    if (holiday === undefined) {
      return {
        ok: true,
        date: candidate,
        weekday: weekdayNameOf(candidate) ?? "",
        baseDate: base,
        baseWeekday: weekdayNameOf(base) ?? "",
        shifted: candidate !== base,
        skipped,
      };
    }
    const next = addDaysIso(candidate, 1);
    // Out of weekdays inside this week: refuse. Never roll into the weekend and
    // never roll into next week's checklist period.
    if (!next || !isWeekday(next)) {
      return {
        ok: false,
        reason: "no_weekday_left",
        baseDate: base,
        skipped: [...skipped, { date: candidate, name: holiday }],
      };
    }
    skipped.push({ date: candidate, name: holiday });
    candidate = next;
  }

  // Unreachable while MAX_WALK_STEPS > 5 (Mon..Fri is 4 hops before the weekday
  // guard fires). Kept so the loop cannot spin on a pathological holiday map.
  return { ok: false, reason: "no_weekday_left", baseDate: base, skipped };
}

/**
 * The refusal to use when the holiday calendar itself could not be read or
 * parsed. Callers MUST build this rather than passing an empty holiday map:
 * an empty map means "no holidays configured" and legitimately yields Monday,
 * which is exactly the wrong answer when the truth is simply unknown.
 */
export function orientationCalendarUnavailable(periodStart: string): OrientationResolution {
  return {
    ok: false,
    reason: "calendar_unavailable",
    baseDate: addDaysIso((periodStart ?? "").trim(), ORIENT_OFFSET_DAYS),
    skipped: [],
  };
}

/**
 * One-line reason the date moved, for the Lock-in dialog and the audit detail.
 * Returns null when nothing moved. Example:
 *   "Moved from Monday (Sep 7) — Labor Day"
 */
export function describeOrientationShift(res: OrientationResolution): string | null {
  if (!res.ok || !res.shifted || res.skipped.length === 0) return null;
  const names = res.skipped.map((s) => s.name).join(", ");
  const from = `${res.baseWeekday} (${monthDay(res.baseDate)})`;
  return `Moved from ${from} — ${names}`;
}

/** "2026-09-07" -> "Sep 7". Locale-free on purpose: this string also ships to the audit log. */
function monthDay(iso: string): string {
  const [, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mi = Number(m) - 1;
  return `${months[mi] ?? m} ${Number(d)}`;
}
