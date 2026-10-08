/**
 * The order of a scheduled post, with its effects passed in so the rules can be tested without a database or Google:
 * CLAIM the slot → read the team's progress → keep only the slot's frequencies → post → stamp the outcome once →
 * audit a post that went out. The server wiring is scheduled-chat.ts.
 *
 * The rules this file holds:
 *   - Nothing is sent without a claim. A slot someone else claimed (a duplicate delivery, the other UTC entry of the
 *     DST pair) is 'already_claimed' and sends nothing; any other claim error stops the run and sends nothing.
 *   - One attempt per slot. A refused, unreachable or timed-out post is stamped and never retried here; a timeout may
 *     have posted, so retrying it could post twice.
 *   - A slot with no tasks of its frequencies is 'skipped': nothing is sent ("No tasks on the board yet" is not a
 *     reminder anyone needs at 3 PM).
 *   - Only a post that went out writes the audit row.
 *
 * Governing doc: docs/features/accounting-scoreboard-tasks.md § Scheduled posts.
 */

import { buildProgressMessage } from './chat-summary';
import { slotLabel, type ChatSlot } from './chat-schedule';
import type { FrequencyProgress } from './tasks';

/** The outcome a claimed slot is stamped with (the table's CHECK holds the same list, plus 'sending'). */
export type PostStatus = 'posted' | 'skipped' | 'refused' | 'unreachable' | 'timed_out' | 'failed';

export type SendOutcome = { status: 'posted' } | { status: 'refused' | 'unreachable' | 'timed_out'; detail: string };

export type ClaimOutcome =
  | { kind: 'claimed'; id: string }
  | { kind: 'taken' }
  | { kind: 'error'; status: number; code: string; message: string };

export interface SlotDeps {
  claim(slot: ChatSlot): Promise<ClaimOutcome>;
  /** The Everyone view's progress, one entry per counted frequency that has tasks. */
  readProgress(): Promise<{ ok: true; progress: FrequencyProgress[] } | { ok: false; message: string }>;
  send(message: string): Promise<SendOutcome>;
  /** Stamp the claimed row once. False when it could not be written (the post itself stands). */
  finish(id: string, status: PostStatus, fields: { message?: string; progress?: FrequencyProgress[]; detail?: string }): Promise<boolean>;
  audit(id: string, fields: { message: string; progress: FrequencyProgress[]; slot: string }): Promise<void>;
}

export interface SlotResult {
  slot: string;
  frequencies: ChatSlot['frequencies'];
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

export async function postSlot(slot: ChatSlot, deps: SlotDeps): Promise<SlotRun> {
  const label = slotLabel(slot);
  const base = { slot: label, frequencies: slot.frequencies };

  const claim = await deps.claim(slot);
  if (claim.kind === 'taken') return { ok: true, value: { ...base, status: 'already_claimed' } };
  if (claim.kind === 'error') return { ok: false, status: claim.status, code: claim.code, message: claim.message };
  const { id } = claim;

  const read = await deps.readProgress();
  if (!read.ok) {
    const detail = `Could not read the tasks: ${read.message}`;
    return { ok: true, value: { ...base, status: 'failed', detail, recorded: await deps.finish(id, 'failed', { detail }) } };
  }
  const wanted: readonly string[] = slot.frequencies;
  const progress = read.progress.filter((p) => wanted.includes(p.frequency));
  if (!progress.length) {
    const detail = `No ${slot.frequencies.join(' or ')} tasks on the board.`;
    return { ok: true, value: { ...base, status: 'skipped', detail, recorded: await deps.finish(id, 'skipped', { progress, detail }) } };
  }

  const message = buildProgressMessage(progress);
  const sent = await deps.send(message);
  const detail = sent.status === 'posted' ? undefined : sent.detail;
  const recorded = await deps.finish(id, sent.status, { message, progress, detail });
  if (sent.status === 'posted') await deps.audit(id, { message, progress, slot: label });
  return { ok: true, value: { ...base, status: sent.status, message, detail, recorded } };
}
