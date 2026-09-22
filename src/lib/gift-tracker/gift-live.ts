/**
 * The Gift Tracker's live channel — browser-safe constants shared by the three
 * routes that write a gift-shipping row (they broadcast from the server) and the
 * "Recently filled / updated" sub-tab that listens.
 *
 * WHY BROADCAST AND NOT `postgres_changes`, AND NOT THE BANK FEED'S PULSE KEY:
 * the browser client is `anon`. `employee_gift_shipping_details` is RLS-gated
 * from it, and so is `app_settings` — one "Admins only" policy, verified against
 * the live catalog on 2026-09-02 (memory/supabase-realtime-anon-rls-dead,
 * restated in `realtime-broadcast.ts`). So a row event can never reach this tab,
 * and neither can a bump of an `app_settings` pulse key.
 *
 * `PeopleBankChanges.tsx:155` does exactly that and says it works. Kane named it
 * as the precedent for this tab; he then ruled (a) on the posted conflict — the
 * measured finding stands, so the route that just wrote the row announces it
 * instead. That surface is NOT changed here, and the discrepancy is recorded as
 * an Open item rather than assumed away.
 *
 * OWN topic — never reuse `fpu-classes-sync`, the dispatch topics, or
 * `payroll-start-processing`: realtime-js keeps one channel per topic per
 * client, and a second `.channel()` on a topic the page already joined collides
 * with it.
 */

export const GIFT_LIVE_TOPIC = 'gift-shipping-sync';
export const GIFT_LIVE_EVENT = 'submitted';

/** The three ways a gift-shipping row can be written. A closed set, mirrored by
 *  the `channel` each write route already stamps into its own audit row. */
export type GiftSubmissionChannel = 'external_link' | 'employee_self' | 'staff';

export interface GiftLivePayload {
  /** Which surface wrote it. */
  channel: GiftSubmissionChannel;
  /** Milestone indexes touched by this write. */
  milestones: number[];
  ts: number;
}

/**
 * Fallback cadence when the socket is down, or when a row was written by
 * something that does not broadcast (a staff edit through another route, a
 * direct database change). A lost message costs seconds, never correctness.
 */
export const GIFT_LIVE_POLL_MS = 20_000;

/** Coalesce a burst — 60 public saves landed in 13 minutes on 2026-09-22 — into
 *  one reload rather than 60. */
export const GIFT_LIVE_DEBOUNCE_MS = 500;
