'use client';

/**
 * In-memory, per-page-session cache for the HR dashboard's data-heavy tabs.
 *
 * The HR shell animates between tabs with a keyed `motion.div`, so switching tabs
 * fully unmounts the previous tab and remounts the next one — which otherwise
 * re-runs every mount-time fetch and re-flashes the loading skeleton each time
 * you come back to a tab you already viewed. Tabs seed their state from this
 * cache and skip the initial fetch when it's warm, so returning to a tab paints
 * instantly with no extra Supabase query.
 *
 * Deliberately NOT persisted to sessionStorage/localStorage: a full page reload
 * should pull fresh data. Only in-session tab switches reuse the cache. Freshness
 * within a session is maintained by each tab's existing Realtime subscription
 * and post-mutation refetches (both of which write back through the same fetch
 * that populates the cache), plus the manual Refresh buttons.
 *
 * Mirrors src/lib/accounting/tab-cache.ts (the Accounting equivalent).
 */
const store = new Map<string, unknown>();

export function getHrTabCache<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function hasHrTabCache(key: string): boolean {
  return store.has(key);
}

export function setHrTabCache<T>(key: string, value: T): void {
  store.set(key, value);
}

export function clearHrTabCache(key: string): void {
  store.delete(key);
}

/** Stable cache keys, one per data set a tab loads. */
export const HR_TAB_CACHE_KEYS = {
  pendingEmployees: 'hr:pending-employees',
  onboardingSubmissions: 'hr:onboarding-submissions',
  newHireChecklist: 'hr:new-hire-checklist',
  overviewRoster: 'hr:overview-roster',
  overviewOffboard: 'hr:overview-offboard',
  overviewMesa: 'hr:overview-mesa',
  overviewFpu: 'hr:overview-fpu',
  overviewOnboardingCounts: 'hr:overview-onboarding-counts',
  transfers: 'hr:transfers',
  offboardRoster: 'hr:offboard-roster',
  offboardHistory: 'hr:offboard-history',
  globalMasterList: 'hr:global-master-list',
} as const;
