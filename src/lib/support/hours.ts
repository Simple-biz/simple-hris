/**
 * When Employee Support is open.
 *
 * Carla ruled Monday–Friday, 9 AM – 5 PM EST (Decision 3, 2026-09-15); Kane
 * confirmed EST as written on 2026-09-16.
 *
 * THIS IS THE FIRST SURFACE IN THE HRIS WHOSE WINDOW IS NOT MANILA.
 * ---------------------------------------------------------------------------
 * Every date, week and cutoff elsewhere is Manila — manilaDayIso, the Sunday
 * pay week, hsl.week_model_cutover. This one is Eastern, deliberately: the
 * workforce works US hours (employee_schedule_periods already defaults
 * `timezone` to 'America/New_York' for the same reason). It is written down as
 * an exception so the next person does not "fix" it into Manila.
 *
 * TWO RULES THAT FALL OUT OF THAT, BOTH LOAD-BEARING
 * ---------------------------------------------------------------------------
 * 1. The window is stored as an IANA ZONE PLUS LOCAL CLOCK TIMES, never as a
 *    fixed UTC offset. Eastern observes DST and Manila does not, so 9 AM
 *    Eastern is 9 PM Manila for part of the year and 10 PM for the rest. A
 *    hardcoded -05:00 is a bug that surfaces in March.
 * 2. The hours are NEVER rendered as a bare "9 AM – 5 PM". A Manila-based
 *    employee reading that is wrong by twelve hours. `describeSupportHours`
 *    prints both zones and COMPUTES the second one; it is not a second string
 *    someone has to remember to edit.
 */

export const SUPPORT_ZONE = 'America/New_York';
export const SUPPORT_VIEWER_ZONE = 'Asia/Manila';

/** Local clock times in SUPPORT_ZONE, inclusive start, exclusive end. */
export const SUPPORT_OPEN_HOUR = 9;
export const SUPPORT_CLOSE_HOUR = 17;

/** 1 = Monday … 5 = Friday. Saturday and Sunday are closed. */
export const SUPPORT_OPEN_WEEKDAYS = [1, 2, 3, 4, 5] as const;

type ZonedParts = { weekday: number; hour: number; minute: number };

/**
 * The wall-clock time in `zone` at instant `at`.
 *
 * Intl is the only thing in the platform that knows when Eastern switched, so
 * the conversion goes through it rather than through arithmetic on an offset.
 */
function partsInZone(at: Date, zone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = WEEKDAYS[get('weekday')] ?? 0;

  // en-US with hour12:false renders midnight as '24' in some ICU versions.
  const rawHour = Number(get('hour'));
  const hour = rawHour === 24 ? 0 : rawHour;

  return { weekday, hour, minute: Number(get('minute')) };
}

/** Is support open at this instant? */
export function isSupportOpen(at: Date): boolean {
  const { weekday, hour } = partsInZone(at, SUPPORT_ZONE);
  if (!(SUPPORT_OPEN_WEEKDAYS as readonly number[]).includes(weekday)) return false;
  return hour >= SUPPORT_OPEN_HOUR && hour < SUPPORT_CLOSE_HOUR;
}

/**
 * The same wall-clock hour expressed in the viewer's zone, on a date where the
 * Eastern offset is whatever it is at `reference`.
 *
 * Computed, not tabulated: during US summer time this returns 10 PM where it
 * returns 9 PM in winter, and nobody has to remember to update a string.
 */
export function hourInViewerZone(hourInSupportZone: number, reference: Date): number {
  const ref = partsInZone(reference, SUPPORT_ZONE);
  const viewer = partsInZone(reference, SUPPORT_VIEWER_ZONE);

  // Whole-hour difference between the two zones at this instant. Both zones are
  // on whole hours relative to UTC, so this is exact.
  let shift = viewer.hour - ref.hour;
  if (shift < -12) shift += 24;
  if (shift > 12) shift -= 24;

  return (((hourInSupportZone + shift) % 24) + 24) % 24;
}

function clockLabel(hour24: number): string {
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h} ${suffix}`;
}

/**
 * "9 AM – 5 PM Eastern (9 PM – 5 AM Manila), Mon–Fri".
 *
 * Both zones, always. See rule 2 at the top of this file — this is the whole
 * reason the function exists rather than a constant string in the component.
 */
export function describeSupportHours(reference: Date): string {
  const openEt = clockLabel(SUPPORT_OPEN_HOUR);
  const closeEt = clockLabel(SUPPORT_CLOSE_HOUR);
  const openLocal = clockLabel(hourInViewerZone(SUPPORT_OPEN_HOUR, reference));
  const closeLocal = clockLabel(hourInViewerZone(SUPPORT_CLOSE_HOUR, reference));
  return `${openEt} – ${closeEt} Eastern (${openLocal} – ${closeLocal} Manila), Mon–Fri`;
}

/**
 * What the employee is told when they file outside the window.
 *
 * It never says "we are closed, come back later" — the form still accepts the
 * ticket, because a question filed at 2 AM is answered at 9 AM and that is a
 * better outcome than making someone remember to return.
 */
export function describeSupportAvailability(at: Date): string {
  return isSupportOpen(at)
    ? `Support is open now — ${describeSupportHours(at)}.`
    : `Support is closed right now, but you can still send this — someone picks it up when they are back. ${describeSupportHours(at)}.`;
}
