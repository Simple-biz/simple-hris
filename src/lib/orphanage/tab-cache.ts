'use client';

/**
 * In-memory, per-page-session cache for the Orphanage dashboard's data-heavy
 * tabs.
 *
 * The Orphanage shell unmounts a tab when you switch away from it, so every
 * mount-time fetch re-runs and the loading skeleton re-flashes each time you
 * come back to a tab you already viewed. The Gift Tracker is the worst of them:
 * one visit pulls the FULL master list, every gift-tracker note, every shipping
 * submission and the whole fulfilment ledger — four `no-store` round trips, all
 * of which were already on screen a moment earlier.
 *
 * Modelled deliberately on `src/lib/hr/tab-cache.ts`, which is the shipped
 * reference for this exact shape. Same semantics, same prohibitions — if you fix
 * a bug in one, fix it in the other.
 *
 * ## PAINT is not SKIP — and collapsing them back is the regression
 *
 * A cached value **paints; it never decides.**
 *
 *   {@link hasOrphanageTabCache}     "is there something to PAINT?"  → skeleton or not
 *   {@link isOrphanageTabCacheFresh} "may the fetch be SKIPPED?"     → network or not
 *
 * These are different questions and merging them is precisely the bug that was
 * fixed in the HR store on 2026-09-09: an unconditional `if (has(key)) return;`
 * meant a session left open all day never re-pulled anything. A warm-but-stale
 * entry still paints — rows stay, no skeleton — and the consumer revalidates
 * behind it.
 *
 * ## Do not reach for Realtime
 *
 * Browser `postgres_changes` is documented dead for this project
 * (`memory/supabase-realtime-anon-rls-dead`): these tables carry RLS with no
 * anon policy, so a channel reports SUBSCRIBED and then never delivers a row
 * event. "Add the table to the publication" is NOT the fix for a stale tab here
 * — it is a security decision for Kane. Bound the staleness instead, which is
 * what the window below does.
 *
 * ## In-memory ONLY, and that is load-bearing
 *
 * Nothing here is mirrored to `sessionStorage` or `localStorage`. This store
 * therefore carries no identity stamp, which is safe *solely* because it cannot
 * outlive the page — signing out navigates and drops the module.
 *
 * **Do not "improve" this by making it survive reloads without first adding the
 * identity envelope** that `src/lib/accounting/tab-cache.ts` has. A stamp-less
 * mirror leaks one Orphanage user's view of the roster — names, departments,
 * home addresses and who the company still owes a gift — to the next person who
 * opens that browser tab. `tab-cache.test.ts` greps this module for
 * `sessionStorage`/`localStorage` so that change fails loudly rather than
 * quietly.
 */

/**
 * How long a warm entry may suppress the mount fetch.
 *
 * 30s, matching the HR store and the Payroll Notes panes' documented window.
 * Flipping between tabs costs nothing; anything older revalidates behind the
 * rows already on screen.
 */
export const FRESH_WINDOW_MS = 30_000;

interface Stamped {
  /** Epoch ms the value was written. */
  at: number;
  value: unknown;
}

const store = new Map<string, Stamped>();

export function getOrphanageTabCache<T>(key: string): T | undefined {
  const hit = store.get(key);
  return hit === undefined ? undefined : (hit.value as T);
}

/**
 * True when there is a cached value to PAINT, regardless of age.
 *
 * Use this to decide whether a skeleton is needed — never whether to fetch.
 */
export function hasOrphanageTabCache(key: string): boolean {
  return store.has(key);
}

/**
 * True when a cached value is young enough that the mount fetch may be skipped.
 *
 * A miss OR a stale entry both return false, so the caller fetches. A caller
 * with something already painted must revalidate SILENTLY — raising no loading
 * flag, blanking no rows, and showing no error card over data already on screen.
 */
export function isOrphanageTabCacheFresh(key: string, now: number = Date.now()): boolean {
  const hit = store.get(key);
  if (hit === undefined) return false;
  return Number.isFinite(hit.at) && now - hit.at < FRESH_WINDOW_MS;
}

/** Epoch ms `key` was written, or undefined — for "as of" labels. */
export function readOrphanageTabCacheStamp(key: string): number | undefined {
  return store.get(key)?.at;
}

export function setOrphanageTabCache<T>(key: string, value: T): void {
  store.set(key, { at: Date.now(), value });
}

export function clearOrphanageTabCache(key: string): void {
  store.delete(key);
}

/**
 * Drop every entry for a surface after a write, so the next read cannot paint
 * the pre-write value.
 *
 * A manual Refresh, or any mutation the user just performed, must re-open the
 * window rather than serve the stale copy back — recording a gift as received
 * and then seeing it still listed as owed is worse than a slow tab.
 */
export function clearOrphanageTabCachePrefix(prefix: string): void {
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** @internal — tests only. */
export function __resetOrphanageTabCache(): void {
  store.clear();
}

/** Stable cache keys, one per data set a tab loads. */
export const ORPHANAGE_TAB_CACHE_KEYS = {
  /** Shared prefix — `clearOrphanageTabCachePrefix` takes this after a write. */
  giftPrefix: 'orph:gift:',
  giftEmployees: 'orph:gift:employees',
  giftNotes: 'orph:gift:notes',
  giftShipping: 'orph:gift:shipping',
  giftReceipts: 'orph:gift:receipts',
} as const;
