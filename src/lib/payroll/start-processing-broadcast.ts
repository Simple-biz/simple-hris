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

/** Realtime Broadcast topic both surfaces subscribe to. */
export const START_PROCESSING_TOPIC = 'payroll-start-processing';
/** Broadcast event name on that topic. */
export const START_PROCESSING_EVENT = 'start';

/**
 * How long the cue runs, in ms. MUST equal `STAGE_PREPPED_RUN_SECONDS` in
 * `src/lib/sound/ping-chime.ts` — it is both the modal's auto-dismiss deadline
 * and the staleness cutoff below. A test pins the two together.
 */
export const START_CUE_WINDOW_MS = 12_000;

export interface StartProcessingAnnouncement {
  /** Lowercased email of the clerk who started processing. */
  by: string;
  /** Friendly display name for the modal ("Carla"). */
  byLabel: string;
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
  return { by, byLabel, at, surface };
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
 *     message after the fact, and that arrival must be silent. The cutoff is the
 *     cue's own run length: once the operator's music has finished, there is
 *     nothing left to join.
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
