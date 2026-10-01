/**
 * The one timestamp every notification card wears, on every dashboard:
 *
 *   April 5, 1999 : 8:00 AM EST
 *
 * Kane, 2026-10-01 ("make sure every notification has a time stamp for the date
 * in this format ... in all dashboards"). It replaced the relative "3h ago" /
 * "Sep 29" stamps, which never said which day or which clock.
 *
 * THE CLOCK IS EASTERN WALL TIME, THE LABEL IS "EST" AS WRITTEN
 * ---------------------------------------------------------------------------
 * The time goes through the IANA zone `America/New_York`, never a fixed -05:00 —
 * the same rule as the Support window (`src/lib/support/hours.ts`), whose
 * "9 AM – 5 PM EST" Kane confirmed "as written" and which is computed
 * DST-aware. So the label is the literal `EST` year-round, exactly as the format
 * was given, and the clock follows Eastern daylight time from March to November.
 * A fixed offset would put every summer stamp an hour behind the wall clock;
 * printing Intl's `EDT` would change the label Kane wrote.
 *
 * Built from `formatToParts`, not `format()`: newer ICU builds put a U+202F
 * narrow no-break space before AM/PM, so a `format()` string differs between a
 * Node test and a browser and between browser versions.
 */

export const NOTIFICATION_TIME_ZONE = 'America/New_York';

/** The label printed after the clock. See the header — literal, not Intl's EST/EDT. */
export const NOTIFICATION_ZONE_LABEL = 'EST';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: NOTIFICATION_TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hourCycle: 'h12',
});

/** `April 5, 1999 : 8:00 AM EST`, or null when `iso` is missing or not a date. */
export function formatNotificationTimestamp(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = PARTS.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')} ${get('day')}, ${get('year')} : ${get('hour')}:${get('minute')} ${get('dayPeriod')} ${NOTIFICATION_ZONE_LABEL}`;
}

/**
 * The stamp for one notification card. `details.submitted_at` (an onboarding
 * submission's own time) wins when it is a real date; otherwise `created_at`,
 * which the table fills on every insert — so a card never goes unstamped because
 * a details payload carried a blank or malformed time.
 */
export function notificationCardTimestamp(
  submittedAt: string | null | undefined,
  createdAt: string,
): string | null {
  return formatNotificationTimestamp(submittedAt) ?? formatNotificationTimestamp(createdAt);
}
