/**
 * PM Buckets' No Meeting Streak, shown as this week's date pills (Open item 391, 2026-10-07).
 *
 * Carla: "Can you make this prettier? Just like we want it to be like, yes, five days, no meeting.
 * Keep it going, guys." Kane: "date pills".
 *
 * Display only. The streak itself is still `noMeetingStreak` (scoring.ts): calendar days since ANY PM
 * meeting was ticked, all time, from the server's `lastMeetingDate`. The pills show the week on screen,
 * one per day the section keeps, from the same ticks the grid already holds (`meetingsByDay`, value 1 =
 * met, the server read's own rule). Nothing new is read or stored.
 */

import { dayHeader, weekLabel, weekStartOf } from './week';

/** clear = no meeting ticked that day (so far, for today) · meeting = at least one PM met · future = not yet. */
export type MeetingPillState = 'clear' | 'meeting' | 'future';

export interface MeetingPill {
  day: string;
  state: MeetingPillState;
  isToday: boolean;
}

/**
 * The header turns amber once a week has gone by with no meeting (accounting-scoreboard.md § PM
 * Buckets, round 3). Kept as it was: whether a long streak is a caution or a win is Carla's call.
 */
export const STREAK_AMBER_DAYS = 7;

export function streakIsLong(days: number | null): boolean {
  return days !== null && days >= STREAK_AMBER_DAYS;
}

/** The days, of `dates`, on which at least one PM was ticked "met". The two arrays are index-aligned. */
export function meetingDaysOf(dates: readonly string[], meetingsByDay: readonly number[]): Set<string> {
  if (dates.length !== meetingsByDay.length) {
    throw new Error(`meetingDaysOf: ${dates.length} dates and ${meetingsByDay.length} day counts do not line up`);
  }
  const out = new Set<string>();
  dates.forEach((d, i) => {
    if (meetingsByDay[i]! > 0) out.add(d);
  });
  return out;
}

/**
 * One pill per day the section keeps (`datesFor(weekStart, section.days)`, never a hard-coded Mon–Fri).
 * A day after today is `future`. Today is `clear` until a meeting is ticked on it.
 */
export function weekMeetingPills(
  dates: readonly string[],
  meetingDays: ReadonlySet<string>,
  today: string,
): MeetingPill[] {
  return dates.map((day) => ({
    day,
    state: day > today ? 'future' : meetingDays.has(day) ? 'meeting' : 'clear',
    isToday: day === today,
  }));
}

const PILL_TEXT: Record<MeetingPillState, string> = {
  clear: 'No meeting',
  meeting: 'Meeting',
  future: 'Ahead',
};

/** The word printed on the pill, so its colour is never the only signal. */
export function pillText(state: MeetingPillState): string {
  return PILL_TEXT[state];
}

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

/** "Fri Oct 2" (a YYYY-MM-DD date; no time zone involved). */
export function dayName(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${dayHeader(date).weekday} ${MONTH.format(d)} ${d.getUTCDate()}`;
}

/** "Mon Oct 5: no meeting" · "Wed Oct 7, today: no meeting so far" · "Thu Oct 8: still ahead". */
export function pillAriaLabel(p: MeetingPill): string {
  const state =
    p.state === 'meeting' ? 'meeting' : p.state === 'future' ? 'still ahead' : p.isToday ? 'no meeting so far' : 'no meeting';
  return `${dayName(p.day)}${p.isToday ? ', today' : ''}: ${state}`;
}

/**
 * Which week the pills show. The streak above them is all time, so the pills say their week: "This
 * week" for the board week holding today (Saturday included), else its Mon–Fri range.
 */
export function pillsCaption(weekStart: string, today: string): string {
  return weekStartOf(today) === weekStart ? 'This week' : weekLabel(weekStart);
}

/**
 * Carla's sentence: "5 days, no meeting. Keep it going!" (`lead` + `sep` + `rest`; the lead is set
 * heavier). The number is `noMeetingStreak`'s. A meeting ticked today (0) and a board where none was
 * ever ticked (null, "—") get words of their own, so the header never cheers "0 days, no meeting".
 */
export function streakHeadline(days: number | null): { lead: string; sep: string; rest: string } {
  if (days === null) return { lead: '—', sep: ' ', rest: 'No meeting has been ticked yet.' };
  if (days === 0) return { lead: 'Meeting today.', sep: ' ', rest: 'The streak starts again tomorrow.' };
  return { lead: `${days} ${days === 1 ? 'day' : 'days'}`, sep: ', ', rest: 'no meeting. Keep it going!' };
}
