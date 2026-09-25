/**
 * Start Processing broadcast — the pure half.
 *
 * When a clerk confirms Start Processing, every OTHER open Payroll Wizard and
 * Payment Dispatch screen pops a modal and plays the same Jellyfish Jam cue the
 * operator just heard. Kane, 2026-09-15: *"when it is starting everyone who has
 * access to the Payroll Wizard will pop up a modal with the jellyfish jam"* —
 * extended to Payment Dispatch on his Q5 answer the same day.
 *
 * Broadcast, never `postgres_changes`: the browser client is `anon` and the lock
 * tables are RLS-protected, so row events never reach it (see
 * memory/supabase-realtime-anon-rls-dead).
 *
 * OWN topic, never `payroll-wizard-follow` / `payment-dispatch-sync` /
 * `payment-dispatch-paid`: realtime-js `channel()` returns the EXISTING channel
 * for a repeated topic, so sharing one would let this hook's `removeChannel`
 * tear down the wizard's follow mode or the dispatch queue's live sync (and
 * vice versa). Both surfaces share THIS topic deliberately — one cue for one
 * action, the same ruling that keeps the sound itself shared.
 *
 * See docs/features/start-processing-cue.md.
 */

import { STAGE_PREPPED_MAX_SECONDS } from '@/lib/sound/ping-chime';

/** Realtime Broadcast topic both surfaces subscribe to. */
export const START_PROCESSING_TOPIC = 'payroll-start-processing';
/** Broadcast event name on that topic. */
export const START_PROCESSING_EVENT = 'start';

/**
 * The staleness cutoff, in ms — and the modal's MINIMUM time on screen.
 *
 * Until 2026-09-25 this also had to equal the cue's run length. Kane then ruled
 * the whole song plays (2:31), so the two were SPLIT rather than stretched: a
 * 2:31 cutoff would let a tab that reconnects two and a half minutes late start
 * the song from the top, which breaks his own 2026-09-15 ruling *"if they are
 * late they shouldnt hear it."* The cutoff stays 12s. The modal now closes when
 * BOTH this window has passed AND the song has stopped (`shouldCloseStartModal`),
 * so it can neither close mid-song nor sit on in front of silence.
 */
export const START_CUE_WINDOW_MS = 12_000;

/**
 * Hard ceiling on the peer modal, whatever the audio engine reports: the
 * longest a run can be, started as late as the window allows, plus slack for
 * the fetch and decode. A lost `ended` event can therefore never strand the
 * modal over the oversee/follow mirror.
 */
export const START_MODAL_MAX_MS = START_CUE_WINDOW_MS + STAGE_PREPPED_MAX_SECONDS * 1000 + 10_000;

/**
 * Should the peer modal close on its own now? Only once the minimum window has
 * passed AND the cue is no longer loading or playing. Dismissing it by hand is
 * separate — that always closes it and stops the song.
 */
export function shouldCloseStartModal(s: { windowElapsed: boolean; cueActive: boolean }): boolean {
  return s.windowElapsed && !s.cueActive;
}

export interface StartProcessingAnnouncement {
  /** Lowercased email of the clerk who started processing. */
  by: string;
  /** Friendly display name for the modal ("Carla"). */
  byLabel: string;
  /**
   * Their full name, for the "Started by" line, or null when the sender had
   * none (an impersonation session's name is its raw email) or runs an older
   * build that never sent one.
   */
  byName: string | null;
  /** `Date.now()` at the moment they confirmed. */
  at: number;
  /** Which surface they started from — the modal says so. */
  surface: 'wizard' | 'dispatch';
}

/**
 * Parse a payload off the wire. Anything malformed resolves to `null` and is
 * never rendered — a broadcast payload is untrusted input like any other.
 */
export function parseStartPayload(raw: unknown): StartProcessingAnnouncement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const by = typeof r.by === 'string' ? r.by.trim().toLowerCase() : '';
  const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0;
  const surface = r.surface === 'wizard' || r.surface === 'dispatch' ? r.surface : null;
  if (!by || !at || !surface) return null;
  const byLabel = typeof r.byLabel === 'string' && r.byLabel.trim() ? r.byLabel.trim() : by.split('@')[0]!;
  return { by, byLabel, byName: parseFullName(r.byName), at, surface };
}

/**
 * A display name off the wire, or null. An email is not a name (impersonation
 * sessions set `name` to one), and the length is capped so a hostile payload
 * cannot stretch the modal.
 */
export function parseFullName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name.includes('@')) return null;
  return name.slice(0, 80);
}

/**
 * Should this announcement actually pop the modal and play?
 *
 * Three ways it must not:
 *   - it is your own start (the channel is configured `self: false`, but a
 *     second tab of the same person is not covered by that);
 *   - it carries no timestamp, so staleness cannot be judged;
 *   - it is STALE. Kane, 2026-09-15: *"if they are late they shouldnt hear it."*
 *     Broadcast is not replayed to a late joiner, so the usual case is handled
 *     by the transport — but a reconnecting or backgrounded tab CAN be handed a
 *     message after the fact, and that arrival must be silent. The cutoff is
 *     `START_CUE_WINDOW_MS` (12s), deliberately NOT the song's length — a peer
 *     starts the song from the top, so a longer cutoff would mean a tab joining
 *     minutes behind everyone else.
 */
export function shouldAnnounceStart(
  msg: StartProcessingAnnouncement | null,
  selfEmail: string | null | undefined,
  nowMs: number,
): boolean {
  if (!msg) return false;
  const self = (selfEmail ?? '').trim().toLowerCase();
  if (self && msg.by === self) return false;
  if (!msg.at) return false;
  const age = nowMs - msg.at;
  // A clock skewed into the future is treated as fresh, not as infinitely stale.
  if (age > START_CUE_WINDOW_MS) return false;
  return true;
}

/** One line of modal copy. Kept here so the test can pin it. */
export function startProcessingHeadline(msg: StartProcessingAnnouncement): string {
  return `${msg.byLabel} is starting payroll`;
}

/**
 * Who started it, in full — Kane 2026-09-25: *"the modal should also show the
 * person who started it."* The headline's first name alone cannot tell two
 * Carlas apart, so this names the person AND the account.
 */
export function startedByLine(msg: StartProcessingAnnouncement): string {
  return `${msg.byName ?? msg.byLabel} · ${msg.by}`;
}
