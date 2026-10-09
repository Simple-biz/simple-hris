/**
 * The order of a scheduled post, with its effects passed in so the rules can be tested without a database or Google:
 * CLAIM the slot → read the team's progress → word each post's counts → post → stamp the outcome once → audit a post
 * that went out. The server wiring is scheduled-chat.ts.
 *
 * The rules this file holds:
 *   - Nothing is sent without a claim. A slot someone else claimed (a duplicate delivery, the next hour's call inside
 *     the window) is 'already_claimed' and sends nothing; any other claim error stops the run and sends nothing.
 *   - One attempt per slot. A refused, unreachable or timed-out post is stamped and never retried here; a timeout may
 *     have posted, so retrying it could post twice. (Inside the one attempt, chat-webhook.ts re-sends a bars card that
 *     Google refused with 400 as the sentence alone: a 400 posted nothing. That post is stamped 'posted' with
 *     SENT_WITHOUT_CARD as its detail.)
 *   - ONE message per slot. Each post in it counts only its own frequencies, in its own words (chat-template.ts).
 *     Posts with the SAME words share one sentence over all their counts, so a weekly + monthly morning reads as it
 *     did before templates ("13 of 80 weekly tasks and 5 of 40 monthly tasks have been completed…"); different words
 *     are separate paragraphs, in the slot's order. The bars card is drawn from every count in the message.
 *   - A post whose frequencies have no tasks says nothing. A slot where none has anything to say is 'skipped': nothing
 *     is sent ("No tasks on the board yet" is not a reminder anyone needs at 3 PM).
 *   - Only a post that went out writes the audit row.
 *
 * Governing doc: docs/features/accounting-scoreboard-scheduled-posts.md § How a post goes out.
 */

import { renderPostTemplate } from './chat-template';
import { slotLabel, type ChatSlot } from './chat-schedule';
import type { SendOutcome } from './chat-webhook';
import { COUNTED_FREQUENCIES, type FrequencyProgress } from './tasks';

/** The outcome a claimed slot is stamped with (the table's CHECK holds the same list, plus 'sending'). */
export type PostStatus = 'posted' | 'skipped' | 'refused' | 'unreachable' | 'timed_out' | 'failed';

/** What a scheduled post reports when the bars card was refused and the sentence went alone (chat-webhook.ts). */
export const SENT_WITHOUT_CARD = 'Sent as the sentence alone: Google Chat refused the bars card (HTTP 400).';

export type ClaimOutcome =
  | { kind: 'claimed'; id: string }
  | { kind: 'taken' }
  | { kind: 'error'; status: number; code: string; message: string };

export interface SlotDeps {
  claim(slot: ChatSlot): Promise<ClaimOutcome>;
  /** The Everyone view's progress, one entry per counted frequency that has tasks. */
  readProgress(): Promise<{ ok: true; progress: FrequencyProgress[] } | { ok: false; message: string }>;
  /** Post the message and its bars card (built from `progress`) through chat-webhook.ts. */
  send(post: { message: string; progress: FrequencyProgress[] }): Promise<SendOutcome>;
  /** Stamp the claimed row once. False when it could not be written (the post itself stands). */
  finish(id: string, status: PostStatus, fields: { message?: string; progress?: FrequencyProgress[]; detail?: string }): Promise<boolean>;
  audit(id: string, fields: { message: string; progress: FrequencyProgress[]; slot: string; card: boolean; posts: string[] }): Promise<void>;
}

export interface SlotResult {
  slot: string;
  frequencies: ChatSlot['frequencies'];
  /** The posts' names (Setup → Scheduled Posts). */
  posts: string[];
  /** 'already_claimed': another call has this slot; this one sent nothing. */
  status: PostStatus | 'already_claimed';
  message?: string;
  detail?: string;
  /** False when the outcome could not be written back to the slot's row. */
  recorded?: boolean;
}

export type SlotRun = { ok: true; value: SlotResult } | { ok: false; status: number; code: string; message: string };

const FAILED: ReadonlySet<SlotResult['status']> = new Set(['refused', 'unreachable', 'timed_out', 'failed']);

/** True when a due post did not go out (the route answers 502 so the cron log shows it). */
export function anyPostFailed(results: readonly SlotResult[]): boolean {
  return results.some((r) => FAILED.has(r.status));
}

const inBoardOrder = (list: FrequencyProgress[]) =>
  COUNTED_FREQUENCIES.flatMap((f) => list.filter((p) => p.frequency === f).slice(0, 1));

/**
 * The slot's message and the counts its card draws: one paragraph per distinct template, in the slot's order, each
 * over the counts of every post that uses it. Empty when no post has a count to give.
 */
export function composeSlotMessage(slot: ChatSlot, team: readonly FrequencyProgress[]): { message: string; progress: FrequencyProgress[] } {
  const byTemplate = new Map<string, FrequencyProgress[]>();
  for (const s of slot.schedules) {
    const mine = team.filter((p) => s.frequencies.includes(p.frequency));
    if (!mine.length) continue;
    byTemplate.set(s.template, inBoardOrder([...(byTemplate.get(s.template) ?? []), ...mine]));
  }
  const paragraphs = [...byTemplate].map(([template, progress]) => renderPostTemplate(template, progress).trim());
  return { message: paragraphs.join('\n\n'), progress: inBoardOrder([...byTemplate.values()].flat()) };
}

export async function postSlot(slot: ChatSlot, deps: SlotDeps): Promise<SlotRun> {
  const label = slotLabel(slot);
  const posts = slot.schedules.map((s) => s.label);
  const base = { slot: label, frequencies: slot.frequencies, posts };

  const claim = await deps.claim(slot);
  if (claim.kind === 'taken') return { ok: true, value: { ...base, status: 'already_claimed' } };
  if (claim.kind === 'error') return { ok: false, status: claim.status, code: claim.code, message: claim.message };
  const { id } = claim;

  const read = await deps.readProgress();
  if (!read.ok) {
    const detail = `Could not read the tasks: ${read.message}`;
    return { ok: true, value: { ...base, status: 'failed', detail, recorded: await deps.finish(id, 'failed', { detail }) } };
  }
  const { message, progress } = composeSlotMessage(slot, read.progress);
  if (!progress.length) {
    const detail = `No ${slot.frequencies.join(' or ')} tasks on the board.`;
    return { ok: true, value: { ...base, status: 'skipped', detail, recorded: await deps.finish(id, 'skipped', { progress, detail }) } };
  }

  const sent = await deps.send({ message, progress });
  const detail = sent.status !== 'posted' ? sent.detail : sent.withCard ? undefined : SENT_WITHOUT_CARD;
  const recorded = await deps.finish(id, sent.status, { message, progress, detail });
  if (sent.status === 'posted') await deps.audit(id, { message, progress, slot: label, card: sent.withCard, posts });
  return { ok: true, value: { ...base, status: sent.status, message, detail, recorded } };
}
