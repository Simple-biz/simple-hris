/**
 * When the team's progress message posts itself to the accounting team's Google Chat.
 *
 * Carla, relayed by Kane 2026-10-08: "Daily: Every day around 3:00 PM · Weekly: Twice a week, ideally Wednesday and
 * Friday mornings · Monthly: On the 1st and 30th of each month · The other task don't need to be posted since they are
 * mainly Claire and I task." So only daily, weekly and monthly are ever posted, and each post carries only its own
 * frequency: a Wednesday that is also the 1st carries weekly and monthly in one message.
 *
 * All times are US EASTERN, the board's day: the task periods are Eastern dates, so the 3 PM count is today's.
 * Vercel cron is UTC-only, so vercel.json calls the route at both UTC hours of each slot (EDT and EST) and this module
 * decides which call is the real one. A slot is due for SLOT_WINDOW_HOURS after its hour; the claim row (one per slot)
 * stops the second call, or a duplicate delivery, from posting twice.
 *
 * Pure. Governing doc: docs/features/accounting-scoreboard-tasks.md § Scheduled posts.
 */

import type { CountedFrequency } from './tasks';
import { SCOREBOARD_TIME_ZONE, isIsoDate, weekdayOf } from './week';

export type ScheduledFrequency = Extract<CountedFrequency, 'daily' | 'weekly' | 'monthly'>;

/** 9:00 AM Eastern. CHOSEN for Carla's "mornings": the weekly and the monthly post. */
export const MORNING_HOUR = 9;
/** 3:00 PM Eastern: "every day around 3:00 PM". */
export const AFTERNOON_HOUR = 15;
/**
 * A slot may post from its hour until this many hours later. Wide enough for a Hobby-plan cron that lands up to 59
 * minutes late and for the second UTC entry of a DST pair; never wide enough to reach the next slot.
 */
export const SLOT_WINDOW_HOURS = 2;
/** The monthly post's second day. A month without a 30th (February) posts on its last day instead. */
export const MONTHLY_LATE_DAY = 30;
/** The weekly post's days. */
export const WEEKLY_POST_DAYS = ['wed', 'fri'] as const;

export interface ChatSlot {
  /** The Eastern date (YYYY-MM-DD). */
  date: string;
  /** The Eastern hour the post is scheduled for (0–23). */
  hour: number;
  /** What the message counts, in the message's order. Never empty. */
  frequencies: ScheduledFrequency[];
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

/** The 1st, and the 30th (or the last day of a shorter month). */
export function isMonthlyPostDay(date: string): boolean {
  const day = Number(date.slice(8, 10));
  return day === 1 || day === Math.min(MONTHLY_LATE_DAY, daysInMonth(date));
}

/** The posts scheduled on an Eastern date, in time order. */
export function slotsOn(date: string): ChatSlot[] {
  if (!isIsoDate(date)) throw new Error(`Not a YYYY-MM-DD date: ${String(date)}`);
  const morning: ScheduledFrequency[] = [];
  if ((WEEKLY_POST_DAYS as readonly string[]).includes(weekdayOf(date))) morning.push('weekly');
  if (isMonthlyPostDay(date)) morning.push('monthly');
  const slots: ChatSlot[] = [];
  if (morning.length) slots.push({ date, hour: MORNING_HOUR, frequencies: morning });
  slots.push({ date, hour: AFTERNOON_HOUR, frequencies: ['daily'] });
  return slots;
}

/** The posts due at `now`: those whose window holds the Eastern hour. Usually none or one. */
export function dueChatSlots(now: Date): ChatSlot[] {
  const { date, hour } = easternClock(now);
  return slotsOn(date).filter((s) => hour >= s.hour && hour < s.hour + SLOT_WINDOW_HOURS);
}

/** "2026-10-08 15:00 ET", for logs and the route's answer. */
export function slotLabel(slot: Pick<ChatSlot, 'date' | 'hour'>): string {
  return `${slot.date} ${String(slot.hour).padStart(2, '0')}:00 ET`;
}
