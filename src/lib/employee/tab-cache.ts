'use client';

import { normEmail } from '@/lib/email/norm-email';

/**
 * Reload-surviving cache for the Employee portal's read-only datasets.
 *
 * ## What it is for
 *
 * The employee shell (`EmployeeApp.tsx`) keeps every visited tab MOUNTED — the
 * tab loop renders `Array.from(mountedTabs)` and merely hides the inactive ones
 * — so hopping between tabs already costs nothing. The expensive event is a
 * **page reload**: React state dies, and the Overview alone re-runs ~22
 * `cache: 'no-store'` fetches before it can paint a single peso.
 *
 * So this cache is deliberately scoped to that one event. Values are held in an
 * in-memory Map and mirrored into **`sessionStorage`**, which is exactly the
 * lifetime Kane asked for (2026-08-31):
 *
 *   | event                                  | cache                              |
 *   |----------------------------------------|------------------------------------|
 *   | tab switch                             | kept (state was never lost anyway) |
 *   | F5 / reload / back-nav                 | **kept** — the point of this module|
 *   | close the browser tab                  | gone                               |
 *   | quit the browser                       | gone                               |
 *   | sign out                               | gone (purged, see below)           |
 *   | a different person signs in on that tab| gone (purged, see below)           |
 *
 * `localStorage` was NOT used, and must not be: it outlives the browser, which
 * would leave one person's pay figures sitting on a shared machine indefinitely.
 *
 * ## The rule that makes it safe on a money surface
 *
 * **A cached value paints; it never decides.** Consumers seed their state from
 * the cache so the screen is instant, then run their normal unconditional fetch
 * and overwrite it. There is deliberately NO "already fetched, skip it" flag
 * here — the Accounting equivalent has one (`hasFetchedThisSession`), and
 * importing that idea would be a bug on this surface.
 * `upsertPaystubDispatchQueue` re-stages `payload` / `amount_php` / `amount_usd`
 * onto an already-PAID row with no post-pay detector, so a pay figure can change
 * underneath a cached copy with nothing to announce it. Stale-while-revalidate
 * is fine. Stale-and-stop is how someone reads last week's number as this week's.
 *
 * {@link readEmployeeCacheStamp} exposes the write time so a surface that wants
 * to say "as of 10:42" can.
 *
 * ## Identity
 *
 * Every entry is stamped with the identity it was written under, and reads
 * reject any stamp that is not the currently bound one. The cache is **inert
 * until {@link bindEmployeeCacheIdentity} is called**, and binding a different
 * identity purges everything first.
 *
 * That is not belt-and-braces. `EmployeeApp` resolves identity from the
 * authenticated session but honors `?email=` for elevated viewers previewing
 * another employee's portal, and it writes the result to `sessionStorage` in the
 * SAME tab. Without this stamp, an admin previewing Jane and then landing on
 * their own portal would repaint Jane's pay from cache — precisely the "stale or
 * spoofed email can never surface another person's data" property that
 * `EmployeeApp.tsx:252-258` exists to guarantee.
 *
 * Mirrors `src/lib/accounting/tab-cache.ts` in shape; the identity stamp, the
 * schema version, the age ceiling and the absent skip-flag are what this
 * surface needs on top.
 */

/** Bumped whenever a cached SHAPE changes; orphans blobs written by an older deploy. */
const SCHEMA_VERSION = 1;

const STORAGE_PREFIX = 'emp-cache:';

/** Where the currently-bound identity is remembered, so a reload can detect a swap. */
const IDENTITY_KEY = `${STORAGE_PREFIX}@identity`;

/**
 * Hard ceiling on how old a cached value may be before it is treated as absent.
 *
 * sessionStorage dies with the tab, but a tab can live for days — a laptop lid
 * closed on Friday and opened on Monday would otherwise paint Friday's pay week
 * as the current one. Twelve hours keeps same-day reloads instant (the case
 * being solved) and refuses to paint anything from a previous working day.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

interface Envelope<T> {
  /** Schema version — see {@link SCHEMA_VERSION}. */
  v: number;
  /** Identity this value was fetched for. */
  id: string;
  /** Epoch ms the value was written. */
  at: number;
  data: T;
}

const memory = new Map<string, Envelope<unknown>>();

/** null until bound. While null the cache is inert: reads miss, writes no-op. */
let boundIdentity: string | null = null;

/** Test seam. Production never calls this; `null` restores real sessionStorage. */
let storageOverride: Storage | null = null;

/** @internal — tests only. */
export function __setEmployeeCacheStorage(s: Storage | null): void {
  storageOverride = s;
}

/** @internal — tests only. Drops in-memory state without touching storage. */
export function __resetEmployeeCacheMemory(): void {
  memory.clear();
  boundIdentity = null;
}

function storage(): Storage | null {
  if (storageOverride) return storageOverride;
  if (typeof window === 'undefined') return null;
  try {
    // Accessing this throws outright in some privacy modes — a missing cache is
    // never fatal, so degrade to memory-only rather than taking the page down.
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function storageKey(key: string): string {
  return STORAGE_PREFIX + key;
}

function isFreshEnvelope(env: Envelope<unknown>, now: number): boolean {
  return (
    env.v === SCHEMA_VERSION &&
    boundIdentity !== null &&
    env.id === boundIdentity &&
    Number.isFinite(env.at) &&
    now - env.at < MAX_AGE_MS
  );
}

/** Parses a stored string into an envelope, or undefined if it is not one. */
function decode(raw: string | null): Envelope<unknown> | undefined {
  if (raw == null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const env = parsed as Partial<Envelope<unknown>>;
    if (typeof env.v !== 'number' || typeof env.id !== 'string' || typeof env.at !== 'number') {
      return undefined;
    }
    if (!('data' in env)) return undefined;
    return env as Envelope<unknown>;
  } catch {
    return undefined;
  }
}

/** Every `emp-cache:` key currently in storage, identity marker excluded. */
function storedDataKeys(s: Storage): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k && k.startsWith(STORAGE_PREFIX) && k !== IDENTITY_KEY) keys.push(k);
    }
  } catch {
    /* a storage that throws mid-enumeration simply yields what it managed */
  }
  return keys;
}

/**
 * Point the cache at a viewer, purging everything if that is a different viewer
 * than the entries already on disk were written for.
 *
 * Call this the moment identity resolves and BEFORE any consumer mounts.
 * Passing `null` (signed out / identity lost) purges and leaves the cache inert.
 */
export function bindEmployeeCacheIdentity(email: string | null): void {
  const next = normEmail(email);
  if (next === null) {
    clearAllEmployeeCache();
    boundIdentity = null;
    return;
  }
  const s = storage();
  let previous: string | null = null;
  try {
    previous = s?.getItem(IDENTITY_KEY) ?? null;
  } catch {
    previous = null;
  }
  if (previous !== null && previous !== next) {
    // Someone else's data is sitting here. Drop it before anything can read it.
    clearAllEmployeeCache();
  }
  boundIdentity = next;
  try {
    s?.setItem(IDENTITY_KEY, next);
  } catch {
    /* the in-memory identity still governs this page load */
  }
}

/** The identity the cache is currently bound to, or null if inert. */
export function boundEmployeeCacheIdentity(): string | null {
  return boundIdentity;
}

function readEnvelope<T>(key: string): Envelope<T> | undefined {
  if (boundIdentity === null) return undefined;
  const now = Date.now();

  const inMemory = memory.get(key);
  if (inMemory) {
    if (isFreshEnvelope(inMemory, now)) return inMemory as Envelope<T>;
    memory.delete(key);
  }

  const s = storage();
  if (!s) return undefined;
  let raw: string | null = null;
  try {
    raw = s.getItem(storageKey(key));
  } catch {
    return undefined;
  }
  const env = decode(raw);
  if (!env) return undefined;
  if (!isFreshEnvelope(env, now)) {
    clearEmployeeCache(key);
    return undefined;
  }
  // Promote so the next read skips the JSON parse.
  memory.set(key, env);
  return env as Envelope<T>;
}

/**
 * The cached value for `key`, or `undefined` when there is none.
 *
 * `undefined` means "nothing cached" and is never stored, so `null` and `[]`
 * remain valid, distinct cached values.
 */
export function getEmployeeCache<T>(key: string): T | undefined {
  return readEnvelope<T>(key)?.data;
}

/** Epoch ms `key` was written, or undefined — for "as of" labels. */
export function readEmployeeCacheStamp(key: string): number | undefined {
  return readEnvelope<unknown>(key)?.at;
}

export function hasEmployeeCache(key: string): boolean {
  return readEnvelope<unknown>(key) !== undefined;
}

/**
 * Cache `value` under `key` for the bound identity.
 *
 * No-ops while the cache is unbound, and no-ops for `undefined` (which is
 * reserved to mean "nothing cached"). A storage failure — quota, private mode,
 * a value with a cycle in it — leaves the in-memory copy serving this page load
 * and is otherwise silent, because a cache miss costs a fetch and nothing more.
 */
export function setEmployeeCache<T>(key: string, value: T): void {
  if (boundIdentity === null) return;
  if (value === undefined) return;
  const env: Envelope<T> = { v: SCHEMA_VERSION, id: boundIdentity, at: Date.now(), data: value };
  memory.set(key, env as Envelope<unknown>);
  const s = storage();
  if (!s) return;
  try {
    s.setItem(storageKey(key), JSON.stringify(env));
  } catch {
    /* see doc comment — the in-memory copy still serves this page load */
  }
}

export function clearEmployeeCache(key: string): void {
  memory.delete(key);
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(storageKey(key));
  } catch {
    /* ignore */
  }
}

/**
 * Drop every cached entry AND the identity marker.
 *
 * Called on sign-out and on an identity swap. Enumerates the prefix rather than
 * walking {@link EMPLOYEE_CACHE_KEYS} so a key added by a future tab, or one
 * left behind by an older deploy, is still removed.
 */
export function clearAllEmployeeCache(): void {
  memory.clear();
  const s = storage();
  if (!s) return;
  try {
    for (const k of storedDataKeys(s)) s.removeItem(k);
    s.removeItem(IDENTITY_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Stable cache keys, one per dataset. Centralized so call sites cannot drift
 * apart on spelling.
 *
 * Keys do NOT carry the viewer's email — the identity stamp does that isolation.
 * A key only needs the parameters that select a genuinely different dataset for
 * the SAME viewer (a week, a date window); add those as a key factory.
 *
 * **Every key here is wired to a live call site.** An unused key is an invitation
 * to cache something under a shape it was not written for — if a dataset stops
 * being cached, delete its key with the call site.
 *
 * To cache one more dataset: add a key, swap that call site's `useState` for
 * `useEmployeeCachedState(KEY, initial)`, and leave its fetch effect alone. If
 * the state holds a `Date`, `Set`, `Map` or anything else `JSON.stringify` does
 * not round-trip, cache the RAW api payload and derive the render shape with a
 * `useMemo` — see `parseRateHistoryRows` in `EmployeeDashboard.tsx`.
 */
export const EMPLOYEE_CACHE_KEYS = {
  /** `GET /api/employees?email=` — name, emails and department for the viewer. */
  masterRow: 'employee:master-row',
  /** `GET /api/employee-rate-history?email=` — RAW rows; parsed for the PAB badge. */
  rateHistory: 'employee:rate-history',
  /** `GET /api/employee/paystub` (weeks mode) — week LIST, not the derived Set. */
  paidPaystubWeeks: 'employee:paid-paystub-weeks',
  /** `GET /api/people/special-transfers?email=` — the one-off transfers strip. */
  specialTransfers: 'employee:special-transfers',
  /** Profile → `GET /api/employees?email=` merged with `/api/employee-master-record`
   *  — the FULL master row (address fields included), distinct from `masterRow`. */
  profileMaster: 'employee:profile-master',
  /** Profile → `GET /api/employee-hourly-rates?email=` — the resolved rate row. */
  profileRate: 'employee:profile-rate',
  /** Profile → `GET /api/employee-skill-sets?email=` — the normalised fields. */
  profileSkillSet: 'employee:profile-skill-set',
  /** Profile → Pay Stubs `GET /api/employee/paystub?summary=1` — the RAW summary
   *  rows (plain JSON: strings, numbers, nulls). Bank/payout rows are deliberately
   *  NOT cached: account numbers stay out of storage. */
  paystubSummary: 'employee:paystub-summary',
} as const;
