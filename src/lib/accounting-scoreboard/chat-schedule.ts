/**
 * When the team's progress message posts itself to the accounting team's Google Chat.
 *
 * Until 2026-10-09 this file held Carla's three posts as constants (item 412): daily at 3 PM, weekly on Wednesday and
 * Friday at 9 AM, monthly on the 1st and the 30th at 9 AM. Kane, 2026-10-09: "Add a new tab under - Setup - label it
 * "Scheduled Posts" where I can see all the scheduled posts and that I can edit that template and add a new one as
 * well". So the posts are rows now (accounting_scoreboard_chat_schedules, seeded with those three), and this file says
 * which of them go out when.
 *
 * All times are US EASTERN, the board's day: the task periods are Eastern dates, so a 3 PM count is today's.
 * Vercel cron is UTC-only and, on Hobby, once a day per entry, so vercel.json calls the route once at every UTC hour
 * (24 entries) and this module decides which call is the real one. A slot is due for SLOT_WINDOW_HOURS after its
 * hour; the claim row (one per Eastern date and hour) stops a second call, or a duplicate delivery, from posting twice.
 *
 * The rules this file holds:
 *   - Posts due at the same Eastern hour are ONE slot, so they go out as ONE message (the 10-08 rule that a weekly +
 *     monthly morning is one message, generalised).
 *   - A month day past the month's end posts on its last day (the 30th in February is the 28th or 29th).
 *   - A paused post never goes out.
 *   - A post never goes out late on the day it was created, retimed or resumed: if its timing changed after its hour
 *     began, that day's slot is not its (timingChangedAt, stamped by the table's trigger).
 *   - At most once per post per Eastern day: the wiring (scheduled-chat.ts) drops a post that already went out today.
 *
 * Pure. Governing doc: docs/features/accounting-scoreboard-scheduled-posts.md.
 */

import { COUNTED_FREQUENCIES, type CountedFrequency } from './tasks';
import { WEEKDAYS, type Weekday } from './sections';
import { SCOREBOARD_TIME_ZONE, addDays, easternToUtc, isIsoDate, todayEastern, weekdayOf } from './week';

export const POST_REPEATS = ['every_day', 'weekdays', 'month_days'] as const;
export type PostRepeat = (typeof POST_REPEATS)[number];

/** One scheduled post, as the cron and the editor see it (the table's row, without who and when). */
export interface PostSchedule {
  id: string;
  label: string;
  repeat: PostRepeat;
  /** For 'weekdays': the days, in the week's order. Empty otherwise. */
  weekdays: Weekday[];
  /** For 'month_days': the days of the month (1–31), ascending. Empty otherwise. */
  monthDays: number[];
  /** The Eastern hour (0–23) it goes out at. */
  hour: number;
  /** What it counts, in the board's order. Never empty, never as-needed. */
  frequencies: CountedFrequency[];
  /** The words, with `{progress}` (chat-template.ts). */
  template: string;
  paused: boolean;
  /** When its hour, its days or its pause last changed (ISO). Set by the table's trigger, never by the app. */
  timingChangedAt: string;
}

/** A post as Setup → Scheduled Posts shows it: the definition plus who made and changed it. */
export interface ChatScheduleView extends PostSchedule {
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
  /** A removed post: kept so a past message still names it, never shown as live. */
  archived: boolean;
  archivedBy: string | null;
  archivedAt: string | null;
}

/** One row of accounting_scoreboard_chat_posts: a slot the schedule claimed, and what happened. */
export interface ChatPostRecord {
  id: string;
  date: string;
  hour: number;
  frequencies: CountedFrequency[];
  /** The posts it carried. Null on the rows from before Setup → Scheduled Posts (2026-10-08 / 09). */
  scheduleIds: string[] | null;
  status: 'sending' | 'posted' | 'skipped' | 'refused' | 'unreachable' | 'timed_out' | 'failed';
  message: string | null;
  detail: string | null;
  claimedAt: string;
  finishedAt: string | null;
}

/** GET /api/accounting-scoreboard/chat-schedules. */
export interface ChatSchedulesPayload {
  viewer: { email: string; role: 'admin' | 'assistant' | 'member' };
  /** Every post, removed ones too (so the history names them), oldest first. */
  schedules: ChatScheduleView[];
  /** The newest RECENT_POSTS_SHOWN claimed slots, newest first. */
  posts: ChatPostRecord[];
  /** The team's counts right now, for the preview; null when they could not be read (progressError says why). */
  progress: Array<{ frequency: CountedFrequency; total: number; done: number }> | null;
  progressError: string | null;
}

export const RECENT_POSTS_SHOWN = 30;

/**
 * A slot may post from its hour until this many hours later: wide enough for a Hobby-plan cron that lands up to 59
 * minutes late, and the next hour's call is a second chance.
 */
export const SLOT_WINDOW_HOURS = 2;

export interface ChatSlot {
  /** The Eastern date (YYYY-MM-DD). */
  date: string;
  /** The Eastern hour the slot is scheduled for (0–23). */
  hour: number;
  /** The posts going out together, in the order given. Never empty. */
  schedules: PostSchedule[];
  /** Everything they count, in the board's order, each once. */
  frequencies: CountedFrequency[];
}

export interface EasternClock {
  date: string;
  hour: number;
  minute: number;
}

/** The Eastern wall clock at `now` (DST aware). */
export function easternClock(now: Date): EasternClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCOREBOARD_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')) };
}

function daysInMonth(date: string): number {
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
}

/** Whether `s` posts on `date` at all, its hour and its pause aside. A month day past the month's end is its last day. */
export function postsOnDate(s: Pick<PostSchedule, 'repeat' | 'weekdays' | 'monthDays'>, date: string): boolean {
  if (!isIsoDate(date)) throw new Error(`Not a YYYY-MM-DD date: ${String(date)}`);
  switch (s.repeat) {
    case 'every_day':
      return true;
    case 'weekdays':
      return s.weekdays.includes(weekdayOf(date));
    case 'month_days': {
      const day = Number(date.slice(8, 10));
      const last = daysInMonth(date);
      return s.monthDays.some((d) => Math.min(d, last) === day);
    }
  }
}

/** Whether `s` goes out in its slot on `date`: not paused, posts that day, and its timing was settled before that hour began. */
export function postsInSlot(s: PostSchedule, date: string): boolean {
  if (s.paused || !postsOnDate(s, date)) return false;
  const changed = Date.parse(s.timingChangedAt);
  return Number.isFinite(changed) && changed < easternToUtc(date, s.hour).getTime();
}

/** The slots on an Eastern date, in time order: the posts that go out that day, grouped by hour. */
export function slotsOn(date: string, schedules: readonly PostSchedule[]): ChatSlot[] {
  if (!isIsoDate(date)) throw new Error(`Not a YYYY-MM-DD date: ${String(date)}`);
  const byHour = new Map<number, PostSchedule[]>();
  for (const s of schedules) {
    if (postsInSlot(s, date)) byHour.set(s.hour, [...(byHour.get(s.hour) ?? []), s]);
  }
  return [...byHour]
    .sort(([a], [b]) => a - b)
    .map(([hour, list]) => ({
      date,
      hour,
      schedules: list,
      frequencies: COUNTED_FREQUENCIES.filter((f) => list.some((s) => s.frequencies.includes(f))),
    }));
}

/** The slots due at `now`: those whose window holds the Eastern hour. Usually none or one. */
export function dueChatSlots(now: Date, schedules: readonly PostSchedule[]): ChatSlot[] {
  const { date, hour } = easternClock(now);
  return slotsOn(date, schedules).filter((s) => hour >= s.hour && hour < s.hour + SLOT_WINDOW_HOURS);
}

/**
 * The due slots minus every post that already went out today at ANOTHER hour (it was retimed after it posted), so a
 * post goes out at most once per Eastern day. A post claimed in this same slot is left in: the claim answers that one
 * (`already_claimed`). `today` is what the posts table holds for the slots' date: each claim's hour and posts.
 */
export function withoutPostedToday(
  slots: readonly ChatSlot[],
  today: ReadonlyArray<{ hour: number; scheduleIds: readonly string[] | null }>,
): ChatSlot[] {
  return slots.flatMap((slot) => {
    const elsewhere = new Set(today.filter((t) => t.hour !== slot.hour).flatMap((t) => t.scheduleIds ?? []));
    const schedules = slot.schedules.filter((s) => !elsewhere.has(s.id));
    if (!schedules.length) return [];
    return [{ ...slot, schedules, frequencies: COUNTED_FREQUENCIES.filter((f) => schedules.some((s) => s.frequencies.includes(f))) }];
  });
}

/** When `s` next goes out after `now` (Eastern date and hour), or null when paused. Looks a year and a bit ahead. */
export function nextPostAt(s: PostSchedule, now: Date): { date: string; hour: number } | null {
  if (s.paused) return null;
  let date = todayEastern(now);
  for (let i = 0; i < 400; i++, date = addDays(date, 1)) {
    if (postsInSlot(s, date) && easternToUtc(date, s.hour).getTime() > now.getTime()) return { date, hour: s.hour };
  }
  return null;
}

/** "2026-10-08 15:00 ET", for logs and the route's answer. */
export function slotLabel(slot: Pick<ChatSlot, 'date' | 'hour'>): string {
  return `${slot.date} ${String(slot.hour).padStart(2, '0')}:00 ET`;
}

/** "9:00 AM", "12:00 PM", "12:00 AM". */
export function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:00 ${hour < 12 ? 'AM' : 'PM'}`;
}

/** "1st", "2nd", "3rd", "11th", "22nd", "30th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

const DAY_NAME: Record<Weekday, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
};

function andList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "Every day", "Weekdays", "Wednesday and Friday", "The 1st and 30th of the month". */
export function describeDays(s: Pick<PostSchedule, 'repeat' | 'weekdays' | 'monthDays'>): string {
  if (s.repeat === 'every_day') return 'Every day';
  if (s.repeat === 'weekdays') {
    const days = WEEKDAYS.filter((d) => s.weekdays.includes(d));
    if (days.length === 7) return 'Every day';
    if (days.length === 5 && !days.includes('sun') && !days.includes('sat')) return 'Weekdays';
    return andList(days.map((d) => DAY_NAME[d]));
  }
  return `The ${andList([...s.monthDays].sort((a, b) => a - b).map(ordinal))} of the month`;
}

/** "Wednesday and Friday at 9:00 AM ET". */
export function describeWhen(s: Pick<PostSchedule, 'repeat' | 'weekdays' | 'monthDays' | 'hour'>): string {
  return `${describeDays(s)} at ${hourLabel(s.hour)} ET`;
}
