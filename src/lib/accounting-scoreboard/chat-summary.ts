/**
 * The team's task progress message (plan Task 8, Open item 393): what Copy message copies and Post to Chat posts.
 * Pure. It keeps the wording someone types into the team chat by hand today ("Current progress, 98 out of 170 daily
 * tasks and 13 of 80 weekly tasks have been completed. As you complete your task, remember to check them off").
 *
 * The Chat post is that sentence PLUS a card of progress bars, one per frequency (Kane, 2026-10-08: "Can we send a
 * progress bar?"). Google Chat renders neither HTML pages nor an uploaded GIF from a webhook; a card's text takes
 * <font color>, so a bar is a run of coloured block characters, red → orange → green as it nears the goal. Copy
 * message stays the sentence alone.
 *
 * Governing doc: docs/features/accounting-scoreboard-tasks.md § The progress message.
 */

import { FREQUENCY_LABEL, type CountedFrequency, type FrequencyProgress } from './tasks';
import { SCOREBOARD_TIME_ZONE } from './week';

const WORD: Record<CountedFrequency, string> = {
  daily: 'daily',
  weekly: 'weekly',
  biweekly: 'bi-weekly',
  monthly: 'monthly',
  bimonthly: 'bimonthly',
  quarterly: 'quarterly',
  annually: 'annual',
};

export function buildProgressMessage(progress: readonly FrequencyProgress[]): string {
  if (progress.length === 0) return 'No tasks on the board yet.';
  const parts = progress.map((p) => `${p.done} of ${p.total} ${WORD[p.frequency]} tasks`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Current progress: ${list} have been completed. As you complete your tasks, remember to check them off.`;
}

/** Cells in one bar: short enough for a phone's Chat card on one line. */
export const BAR_CELLS = 20;
const BAR_CHAR = '█';
/**
 * The bar turns red → orange → green as a frequency nears its goal (Kane, 2026-10-08: "as we are reaching the goal we
 * are like red orange green"). Decided by the PRINTED percent (rounded down), so the colour and the number never
 * disagree. CHOSEN: orange from 50%, green from 90%.
 */
export const ORANGE_FROM_PERCENT = 50;
export const GREEN_FROM_PERCENT = 90;
export type BarTier = 'red' | 'orange' | 'green';
const BAR_COLOR: Record<BarTier | 'track', string> = { red: '#dc2626', orange: '#ea580c', green: '#059669', track: '#d1d5db' };

/**
 * Filled cells for done / total. A bar is full ONLY when every task is done, and some done always shows at least one
 * cell, so rounding never makes 169 of 170 look finished or 1 of 170 look untouched.
 */
export function barCells(done: number, total: number): number {
  if (total <= 0 || done <= 0) return 0;
  if (done >= total) return BAR_CELLS;
  return Math.min(BAR_CELLS - 1, Math.max(1, Math.round((done / total) * BAR_CELLS)));
}

/** Whole percent, rounded DOWN, so it says 100% only when everything is done. */
export function percentDone(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.floor((done / total) * 100));
}

/** Red under 50%, orange from 50%, green from 90%, by the printed percent. */
export function barTier(done: number, total: number): BarTier {
  const pct = percentDone(done, total);
  if (pct >= GREEN_FROM_PERCENT) return 'green';
  if (pct >= ORANGE_FROM_PERCENT) return 'orange';
  return 'red';
}

/** One bar as card text: the done cells in their tier's colour, the rest in grey. */
export function progressBarHtml(p: Pick<FrequencyProgress, 'done' | 'total'>): string {
  const filled = barCells(p.done, p.total);
  const color = BAR_COLOR[barTier(p.done, p.total)];
  const parts: string[] = [];
  if (filled > 0) parts.push(`<font color="${color}">${BAR_CHAR.repeat(filled)}</font>`);
  if (filled < BAR_CELLS) parts.push(`<font color="${BAR_COLOR.track}">${BAR_CHAR.repeat(BAR_CELLS - filled)}</font>`);
  return parts.join('');
}

/** "Thu, Oct 8 · 3:00 PM ET": when the counts were read, on the board's (Eastern) clock. */
export function progressHeading(now: Date): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: SCOREBOARD_TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric' }).format(now);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: SCOREBOARD_TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(now);
  return `${day} · ${time} ET`;
}

/** The subset of a Google Chat cardsV2 message this post uses. */
export interface ChatCard {
  cardId: string;
  card: {
    header: { title: string; subtitle: string };
    sections: Array<{ widgets: Array<{ decoratedText: { topLabel: string; text: string; bottomLabel: string } }> }>;
  };
}

/** What the webhook is sent: always the sentence; the card only when there is something to draw. */
export interface ChatPost {
  text: string;
  cardsV2?: ChatCard[];
}

export function buildProgressPost(progress: readonly FrequencyProgress[], now: Date): ChatPost {
  const text = buildProgressMessage(progress);
  if (progress.length === 0) return { text };
  return {
    text,
    cardsV2: [
      {
        cardId: 'task-progress',
        card: {
          header: { title: 'Task progress', subtitle: progressHeading(now) },
          sections: [
            {
              widgets: progress.map((p) => ({
                decoratedText: {
                  topLabel: FREQUENCY_LABEL[p.frequency],
                  text: progressBarHtml(p),
                  bottomLabel: `${p.done} of ${p.total} done · ${percentDone(p.done, p.total)}%`,
                },
              })),
            },
          ],
        },
      },
    ],
  };
}
