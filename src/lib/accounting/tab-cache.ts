'use client';

// In-session cache for Accounting tab datasets.
//
// The Accounting shell (src/App.tsx) animates between tabs with a keyed
// motion.div, so switching tabs fully unmounts the previous tab and remounts
// the next one. Without a cache every switch re-runs the tab's fetches from
// scratch and flashes a loading spinner, even though the data was already on
// screen seconds ago.
//
// This is a plain key/value store backed by an in-memory Map (survives tab
// switches because the shell itself stays mounted) and mirrored to
// sessionStorage (survives a full page reload within the same browser tab).
// Consumers follow the stale-while-revalidate pattern: seed component state
// from the cache so data paints instantly, then re-fetch quietly in the
// background and write the fresh result back.
//
// `undefined` is reserved to mean "nothing cached" — callers never store it,
// so an empty array / null is still a valid, distinct cached value.

const memory = new Map<string, unknown>();
const STORAGE_PREFIX = 'acct-cache:';

function storageKey(key: string): string {
  return STORAGE_PREFIX + key;
}

export function getTabCache<T>(key: string): T | undefined {
  if (memory.has(key)) return memory.get(key) as T;
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.sessionStorage.getItem(storageKey(key));
    if (raw == null) return undefined;
    const parsed = JSON.parse(raw) as T;
    // Promote into memory so subsequent reads skip JSON parsing.
    memory.set(key, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

export function hasTabCache(key: string): boolean {
  return getTabCache(key) !== undefined;
}

export function setTabCache<T>(key: string, value: T): void {
  memory.set(key, value);
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    // Quota exceeded or a non-serializable value — the in-memory copy still
    // serves this session, so a storage miss is non-fatal.
  }
}

export function clearTabCache(key: string): void {
  memory.delete(key);
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(storageKey(key));
  } catch {
    /* ignore */
  }
}

// Tracks which datasets have actually been PULLED FROM THE SERVER during this
// page-load session. Deliberately NOT persisted: a full reload starts empty, so
// data is re-pulled fresh. A tab switch, by contrast, only remounts the tab —
// the flag survives, so the (potentially heavy) refetch can be skipped and the
// tab repaints instantly from the cache above. Freshness within a session is
// then maintained by Realtime, post-mutation refetches, and manual Refresh
// buttons, which all fetch unconditionally.
const fetchedThisSession = new Set<string>();

/** True once {@link markFetchedThisSession} has run for `key` this page session. */
export function hasFetchedThisSession(key: string): boolean {
  return fetchedThisSession.has(key);
}

/** Record that `key` was successfully pulled from the server this page session. */
export function markFetchedThisSession(key: string): void {
  fetchedThisSession.add(key);
}

// Stable cache keys, one per cached dataset. Centralized so callers can't
// drift apart on spelling.
export const TAB_CACHE_KEYS = {
  ratesSummary: 'rates:summary',
  dispatchQueue: 'dispatch:queue',
  // v2: rows are roster-gated — the bump orphans pre-gate (unfiltered) entries.
  mesaRequests: 'mesa:requests:v2',
  mesaNonMembers: 'mesa:non-members',
  mesaActiveMembers: 'mesa:active-members',
  pabReasonCodes: 'pab-disputes:reason-codes',
  // PAB disputes are cached per status filter, e.g. `pab-disputes:pending`.
  pabDisputes: (statusFilter: string) => `pab-disputes:${statusFilter}`,
  overviewPayouts: 'overview:payouts',
  overviewPabMetrics: 'overview:pab-metrics',
  peopleRoster: 'people:list',
  transfers: 'transfers:list',
} as const;
