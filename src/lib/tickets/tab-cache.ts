'use client';

/**
 * Tickets board tab-switch and reload cache.
 *
 * Built on the shared envelope (`src/lib/dashboard-cache/create-tab-cache.ts`):
 * `sessionStorage`, never `localStorage`; identity-stamped and inert until
 * bound; 12h ceiling; purged on sign-out and on a viewer swap; and **no
 * skip-fetch flag is reachable**.
 *
 * That last property matters more here than anywhere else in this store's
 * family: a ticket board is **a queue other people act on**. Someone else moves
 * a card, closes it or reassigns it while you are on another dashboard, and a
 * skipped fetch would leave you dragging a card that has already moved. Seed the
 * paint, always refetch — `manager-dashboard-cache.md`'s "stale-and-stop is how
 * two managers approve the same request twice".
 *
 * **`access` (`'view' | 'edit'`) is deliberately absent** and no key here may be
 * spelled for it. It is a PERMISSION: a cached permission is a cached value
 * DECIDING, which is the one thing this store may never do. It is also the
 * difference between a read-only board and a draggable one, so a stale copy
 * would offer edits the server will refuse.
 */

import { createTabCache } from '@/lib/dashboard-cache/create-tab-cache';
import { createCachedStateHook } from '@/lib/dashboard-cache/create-cached-state-hook';

export const ticketsTabCache = createTabCache('tkt-tab:');

export const {
  useCacheIdentity: useTicketsCacheIdentity,
  useCachedState: useTicketsCachedState,
} = createCachedStateHook(ticketsTabCache);

export function clearAllTicketsCache(): void {
  ticketsTabCache.clearAll();
}

/** Stable keys. **Every key here is wired to a live call site.** */
export const TICKETS_CACHE_KEYS = {
  /** `GET /api/tickets` — the live board's RAW rows. */
  board: 'board',
  /** `GET /api/tickets?archived=1` — the Archived view's RAW rows, its own key
   *  because the two lists are fetched separately and are different datasets. */
  archived: 'archived',
  /** `GET /api/tickets/members` — the assignee picker's roster. */
  members: 'members',
} as const;
