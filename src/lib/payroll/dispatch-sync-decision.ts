import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

/**
 * When does an open Payment Dispatch screen re-run its full queue load?
 *
 * A full load is about 11 API calls, and one of them recomputes the whole
 * week's pay (~1,100 people). Until 2026-10-08 every open screen ran it TWICE
 * per payment anywhere. The first run came from the broadcast. The second came
 * from the 15 s signature poll, whose baseline was the last POLL, not the last
 * LOAD. The payer's own screen also ran it twice, because the server's broadcast
 * echoes back to it. Hidden tabs reloaded on every payment as well. That
 * day the database reached load average 43 with three to five clerks paying,
 * and Mark Paid failed with "Could not verify prior payments".
 *
 * The fix compares every trigger against the signature of the data that is
 * actually ON SCREEN. That is `count|newest created_at` of the cycle's dispatch
 * rows, the same pair `GET /api/payment-dispatches?signature=1` returns. A
 * screen reloads only when the database holds something it has not loaded.
 */

/** `count|newest created_at (ms)`. Milliseconds on both sides: Postgres keeps
 *  microseconds and trims trailing zeros, so the raw strings are not comparable. */
export type DispatchSignature = string;

export function signatureOf(count: number, latest: string | null | undefined): DispatchSignature {
  const ms = latest ? Date.parse(latest) : NaN;
  return `${count}|${Number.isFinite(ms) ? ms : ''}`;
}

/** The signature of the rows a load just put on screen (all statuses, one cycle). */
export function signatureOfRows(rows: Pick<PaymentDispatchRow, 'created_at'>[]): DispatchSignature {
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const r of rows) {
    const ms = r.created_at ? Date.parse(r.created_at) : NaN;
    if (Number.isFinite(ms) && ms > newestMs) {
      newestMs = ms;
      newest = r.created_at;
    }
  }
  return signatureOf(rows.length, newest);
}

export type SyncTrigger =
  /** Another screen, or the server, said the queue changed. */
  | 'broadcast'
  /** The 15 s fallback poll, or the tab regaining focus. */
  | 'poll';

export interface SyncDecisionInput {
  trigger: SyncTrigger;
  /** The live signature, or null when that read failed. */
  live: DispatchSignature | null;
  /** The signature of the queue on screen, or null when no load has applied yet. */
  loaded: DispatchSignature | null;
  /** The live signature the last reload was started for, while that reload has
   *  not yet applied (it failed, or was kept over the cache). */
  tried: DispatchSignature | null;
}

/**
 * `reload`, `skip`, or `baseline` (skip, and remember `live` as `tried`).
 *
 * Never weaker than before 2026-10-08 on the broadcast path: a broadcast still
 * reloads whenever it cannot PROVE the screen is current (the signature read
 * failed, or nothing has loaded yet). The poll keeps its old rule of one reload
 * per change: an unreadable signature, or a change it already tried, is
 * skipped, so a struggling database is not hit every 15 s. With nothing loaded
 * and nothing tried, its first reading is only a baseline, exactly as the old
 * poll's first observation was.
 */
export function decideSync({ trigger, live, loaded, tried }: SyncDecisionInput): 'reload' | 'skip' | 'baseline' {
  if (trigger === 'broadcast') {
    if (live === null || loaded === null) return 'reload';
    return live === loaded ? 'skip' : 'reload';
  }
  if (live === null) return 'skip';
  if (loaded === null && tried === null) return 'baseline';
  if (live === loaded || live === tried) return 'skip';
  return 'reload';
}
