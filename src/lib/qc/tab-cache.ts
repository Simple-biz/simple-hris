'use client';

/**
 * QC dashboard tab-switch and reload cache.
 *
 * The QC shell unmounts a tab when you leave it, so every mount fetch re-runs
 * from cold on the way back — and a dashboard switch (`router.push`) tears the
 * whole route down. Built on the shared envelope
 * (`src/lib/dashboard-cache/create-tab-cache.ts`): `sessionStorage`, never
 * `localStorage`; identity-stamped and inert until bound; 12h ceiling; purged on
 * sign-out and on a viewer swap; and **no skip-fetch flag is reachable**, so a
 * cached value paints and never decides.
 */

import { createTabCache } from '@/lib/dashboard-cache/create-tab-cache';
import { createCachedStateHook } from '@/lib/dashboard-cache/create-cached-state-hook';

export const qcTabCache = createTabCache('qc-tab:');

export const { useCacheIdentity: useQcCacheIdentity, useCachedState: useQcCachedState } =
  createCachedStateHook(qcTabCache);

export function clearAllQcCache(): void {
  qcTabCache.clearAll();
}

/**
 * Stable keys. **Every key here is wired to a live call site.**
 *
 * The scoring datasets are keyed BY WEEK: switching weeks is the common move on
 * this dashboard, and one shared key would make each week evict the other and
 * re-fetch on the way back — which is what this store exists to stop. A week is
 * also the one parameter that selects a genuinely different dataset for the same
 * viewer, which is exactly when the store's rules say to put it in the key.
 *
 * **`access` is deliberately absent.** It is a PERMISSION — a cached permission
 * is a cached value DECIDING, and the one thing this store may never do.
 */
export const QC_CACHE_KEYS = {
  /** `GET /api/qc/assignments?period_start=` — RAW, per week. */
  assignments: (week: string) => `assignments:${week}`,
  /** The staged-progress read for one week — RAW, per week. */
  progress: (week: string) => `progress:${week}`,
} as const;
