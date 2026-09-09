'use client';

/**
 * In-memory, per-page-session cache for the HR dashboard's data-heavy tabs.
 *
 * The HR shell animates between tabs with a keyed `motion.div`, so switching tabs
 * fully unmounts the previous tab and remounts the next one — which otherwise
 * re-runs every mount-time fetch and re-flashes the loading skeleton each time
 * you come back to a tab you already viewed. Tabs seed their state from this
 * cache so returning to a tab paints instantly.
 *
 * Deliberately NOT persisted to `sessionStorage`/`localStorage`: a full page
 * reload should pull fresh data, and nothing here should outlive the page. That
 * is also why this store carries no identity stamp — it cannot survive a
 * sign-out the way `src/lib/accounting/tab-cache.ts` can, because signing out
 * navigates and drops the module. (Do not "improve" this by mirroring it to
 * storage without also adding the identity envelope that store has.)
 *
 * ## Freshness — the skip window (2026-09-09)
 *
 * Entries are stamped, and a warm entry only suppresses the mount fetch while it
 * is younger than {@link FRESH_WINDOW_MS}. Past that it still PAINTS, and the
 * consumer revalidates in the background.
 *
 * This replaced an unconditional `if (hasHrTabCache(key)) return;` skip, which
 * this file's own docstring justified by "each tab's existing Realtime
 * subscription". That justification did not hold:
 *
 * - Ten of the twelve datasets below have no subscription at all — only
 *   `pendingEmployees` and `onboardingSubmissions` ever open one.
 * - Browser `postgres_changes` is documented dead for this project
 *   (`memory/supabase-realtime-anon-rls-dead`): the tables carry RLS with no
 *   anon policy, so a channel reports SUBSCRIBED and then never delivers a row
 *   event. Per that memory the fix is never "add the table to the publication".
 *
 * So an HR session left open all day never re-pulled the global master list, the
 * offboarding queue or the screening board on a tab return — only F5 or a manual
 * Refresh moved them. This window keeps the instant repaint that tab-switching
 * needs while bounding how stale a painted row can be.
 *
 * A cached value **paints; it never decides** — the rule the Employee, Manager
 * and KPI stores are built on. {@link hasHrTabCache} answers "is there something
 * to paint", {@link isHrTabCacheFresh} answers "may the fetch be skipped", and
 * those are deliberately different questions.
 *
 * ### The one dataset that keeps its once-per-session skip
 *
 * `orientationAttendance` (`src/hooks/useHrOrientationAttendance.ts`) still
 * fetches once per page session and does NOT consult the window. That is a
 * documented decision, not an oversight: `hr-orientation-attendance.md:108-126`
 * specifies "the tab fetches once per page session", makes the panel's Refresh
 * button the freshness path, and states outright that a cached payload running
 * a few minutes behind the always-live "Listed" count "is intentional, not
 * drift". Do not fold it into the window without changing that doc first.
 */

/**
 * How long a warm entry may suppress the mount fetch.
 *
 * 30s, matching the Payroll Notes panes' documented fresh window
 * (`payroll-wizard-notes.md` § *No reload on the way back*): flipping between HR
 * tabs costs nothing, and anything older revalidates behind the rows that are
 * already on screen.
 */
export const FRESH_WINDOW_MS = 30_000;

interface Stamped {
  /** Epoch ms the value was written. */
  at: number;
  value: unknown;
}

const store = new Map<string, Stamped>();

export function getHrTabCache<T>(key: string): T | undefined {
  const hit = store.get(key);
  return hit === undefined ? undefined : (hit.value as T);
}

/**
 * True when there is a cached value to PAINT, regardless of age.
 *
 * Use this to decide whether a skeleton is needed — not whether to fetch.
 */
export function hasHrTabCache(key: string): boolean {
  return store.has(key);
}

/**
 * True when a cached value is young enough that the mount fetch may be skipped.
 *
 * A miss OR a stale entry both return false, so the caller fetches. A caller
 * with something already painted must revalidate SILENTLY — see
 * {@link hasHrTabCache}.
 */
export function isHrTabCacheFresh(key: string, now: number = Date.now()): boolean {
  const hit = store.get(key);
  if (hit === undefined) return false;
  return Number.isFinite(hit.at) && now - hit.at < FRESH_WINDOW_MS;
}

/** Epoch ms `key` was written, or undefined — for "as of" labels. */
export function readHrTabCacheStamp(key: string): number | undefined {
  return store.get(key)?.at;
}

export function setHrTabCache<T>(key: string, value: T): void {
  store.set(key, { at: Date.now(), value });
}

export function clearHrTabCache(key: string): void {
  store.delete(key);
}

/** @internal — tests only. */
export function __resetHrTabCache(): void {
  store.clear();
}

/** Stable cache keys, one per data set a tab loads. */
export const HR_TAB_CACHE_KEYS = {
  pendingEmployees: 'hr:pending-employees',
  onboardingSubmissions: 'hr:onboarding-submissions',
  newHireChecklist: 'hr:new-hire-checklist',
  /** Company-wide orientation attendance — one fetch serves every week the
   *  New Hire Checklist selector can land on, so switching weeks never refetches. */
  orientationAttendance: 'hr:orientation-attendance',
  overviewRoster: 'hr:overview-roster',
  overviewOffboard: 'hr:overview-offboard',
  overviewOnboardingCounts: 'hr:overview-onboarding-counts',
  transfers: 'hr:transfers',
  offboardHistory: 'hr:offboard-history',
  offboardQueue: 'hr:offboard-queue',
  globalMasterList: 'hr:global-master-list',
  screening: 'hr:screening',
} as const;
