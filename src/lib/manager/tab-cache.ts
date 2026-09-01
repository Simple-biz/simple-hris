'use client';

import { normEmail } from '@/lib/email/norm-email';

/**
 * Remount- and reload-surviving cache for the Manager dashboard shell.
 *
 * ## What it is for
 *
 * `ManagerApp` renders its content pane inside an `AnimatePresence mode="wait"`
 * keyed on `activeTab` (`ManagerApp.tsx:402-404`), so **every tab unmounts when
 * you leave it** and every fetch it owns re-runs from cold when you come back.
 * That is unlike the Employee shell, which renders `Array.from(mountedTabs)` and
 * merely *hides* the inactive ones — which is why the Employee cache
 * (`src/lib/employee/tab-cache.ts`) is scoped to reloads alone and this one is
 * not.
 *
 * The unmount is **load-bearing and must stay**: it is what flushes the KPI
 * Calculator's pending autosave (see `memory/kpi-calculator-autosave`, *"Pending
 * writes flush on tab-hide / pagehide / unmount"*). So the fix for "it reloads
 * every time I switch tabs" is to cache the paint, never to keep the tabs
 * mounted. Listed as still-open in `memory/dashboard-switch-performance`
 * (*"/manager re-fetches on every tab switch"*).
 *
 * Values are held in an in-memory Map and mirrored into **`sessionStorage`**, so
 * a value survives a tab switch, a reload and a hop to another dashboard, and
 * dies with the browser tab.
 *
 * ## The rule that makes this safe
 *
 * **A cached value paints; it never decides.**
 *
 * Every consumer seeds its state from the cache so the screen is instant, then
 * runs its normal unconditional fetch and overwrites it. There is deliberately
 * **no "already fetched, skip it" flag** here. The Accounting store
 * (`src/lib/accounting/tab-cache.ts`) exports `hasFetchedThisSession`; importing
 * that idea onto this surface would be a bug for the same reason it would be on
 * the Employee portal (`docs/features/employee-dashboard-cache.md`): a manager's
 * roster, their approval queue and their transfer requests are all changed by
 * *other people*, so a skipped fetch freezes one manager's view of a queue
 * somebody else has since emptied. Stale-then-corrected is fine.
 * Stale-and-stop is how two managers approve the same request twice.
 *
 * A `no-skip-flag` test greps this module's own exports so the flag cannot
 * return by copy-paste.
 *
 * ## What deliberately does NOT go in here
 *
 * - **Presence / "last seen"** (`/api/presence/last-seen`). A liveness signal
 *   repainted from a 12-hour-old copy is a *wrong* answer, not a stale one —
 *   "active now" is the whole content of the value. It re-fetches cold, on
 *   purpose.
 * - **Signed evidence URLs** on time-adjustment rows. They expire; a cached one
 *   paints a broken image where the uncached path paints nothing. The rows are
 *   cached, the `signedUrls` map is not.
 * - **The company-wide leave-request list.** `/api/leave-requests?scope=all`
 *   returns every request in the company and the shell uses exactly one number
 *   from it. Caching the list would spend the whole `sessionStorage` budget on
 *   rows nothing reads, so {@link MANAGER_CACHE_KEYS.pendingLeaveCount} holds
 *   the badge count itself — which is the state, so there is no second
 *   derivation for the seed path to diverge from.
 * - **Anything carrying a pay rate.** Managers see no compensation on any My
 *   Team surface (`docs/features/manager-my-team.md`), and nothing cached here
 *   may become the back door that reintroduces one.
 *
 * ## Identity
 *
 * Every entry is stamped with the viewer it was written for, reads reject any
 * other stamp, the cache is **inert until {@link bindManagerCacheIdentity} is
 * called**, and binding a different viewer purges everything first.
 *
 * That is load-bearing, not decoration: which departments a manager sees, whose
 * approvals sit in their queue and which roster they hold all follow from the
 * viewer, and `ManagerApp` honours a `?email=` override in the same tab
 * (`ManagerApp.tsx:134-146`). Two managers sharing a machine must never paint
 * each other's team.
 *
 * ## Sibling stores
 *
 * `src/lib/employee/tab-cache.ts`, `src/lib/accounting/tab-cache.ts` and
 * `src/lib/manager/kpi-cache.ts` are the same store with a different prefix and
 * key set. They are separate modules on purpose today (each ships its own
 * invariants and its own tests), but the internals below are now the fourth
 * copy — extracting a shared factory is the obvious follow-up and is recorded in
 * `docs/features/manager-dashboard-cache.md` § *Not done*.
 */

/** Bumped whenever a cached SHAPE changes; orphans blobs written by an older deploy. */
const SCHEMA_VERSION = 1;

const STORAGE_PREFIX = 'mgr-tab:';

/** Where the currently-bound viewer is remembered, so a reload can detect a swap. */
const IDENTITY_KEY = `${STORAGE_PREFIX}@identity`;

/**
 * Hard ceiling on how old a cached value may be before it is treated as absent.
 *
 * Matches the Employee portal's ceiling for the same reason: sessionStorage dies
 * with the tab, but a tab can live for days, and a laptop lid closed on Friday
 * and opened on Monday must not paint Friday's approval queue as this morning's
 * work.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Most data entries kept at once, oldest-written evicted first.
 *
 * Several keys are parameterised by pay week, so a manager reading back through
 * a month of bonus history mints a new key per week. Unbounded, that walks into
 * a `QuotaExceededError` on the write that matters most — the live week's.
 */
const MAX_ENTRIES = 32;

interface Envelope<T> {
  /** Schema version — see {@link SCHEMA_VERSION}. */
  v: number;
  /** Viewer this value was fetched for. */
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
export function __setManagerCacheStorage(s: Storage | null): void {
  storageOverride = s;
}

/** @internal — tests only. Drops in-memory state without touching storage. */
export function __resetManagerCacheMemory(): void {
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

/** Every `mgr-tab:` key currently in storage, identity marker excluded. */
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
 * Call this the moment the viewer resolves and BEFORE any tab mounts. Passing
 * `null` (signed out / identity lost) purges and leaves the cache inert.
 */
export function bindManagerCacheIdentity(email: string | null): void {
  const next = normEmail(email);
  if (next === null) {
    clearAllManagerCache();
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
    // Another manager's team is sitting here. Drop it before anything can read it.
    clearAllManagerCache();
  }
  boundIdentity = next;
  try {
    s?.setItem(IDENTITY_KEY, next);
  } catch {
    /* the in-memory identity still governs this page load */
  }
}

/** The viewer the cache is currently bound to, or null if inert. */
export function boundManagerCacheIdentity(): string | null {
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
    clearManagerCache(key);
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
export function getManagerCache<T>(key: string): T | undefined {
  return readEnvelope<T>(key)?.data;
}

/** Epoch ms `key` was written, or undefined — for an "as of" stamp. */
export function readManagerCacheStamp(key: string): number | undefined {
  return readEnvelope<unknown>(key)?.at;
}

export function hasManagerCache(key: string): boolean {
  return readEnvelope<unknown>(key) !== undefined;
}

/**
 * Drop the oldest data entries until at most {@link MAX_ENTRIES} remain.
 *
 * Reads each stored envelope's own `at` rather than relying on insertion order,
 * so a reload (which repopulates from storage in arbitrary order) still evicts
 * the genuinely oldest entry rather than whatever happened to be enumerated first.
 */
function trimToCapacity(s: Storage, keepKey: string): void {
  const stored = storedDataKeys(s);
  if (stored.length <= MAX_ENTRIES) return;
  const dated = stored
    .filter((k) => k !== keepKey)
    .map((k) => {
      const env = decode(
        (() => {
          try {
            return s.getItem(k);
          } catch {
            return null;
          }
        })(),
      );
      // An undecodable blob has no age to compare, so evict it first.
      return { k, at: env && Number.isFinite(env.at) ? env.at : 0 };
    })
    .sort((a, b) => a.at - b.at);
  let excess = stored.length - MAX_ENTRIES;
  for (const { k } of dated) {
    if (excess <= 0) break;
    try {
      s.removeItem(k);
    } catch {
      /* ignore — the next write will try again */
    }
    memory.delete(k.slice(STORAGE_PREFIX.length));
    excess -= 1;
  }
}

/**
 * Cache `value` under `key` for the bound viewer.
 *
 * No-ops while the cache is unbound, and no-ops for `undefined` (which is
 * reserved to mean "nothing cached"). A storage failure — quota, private mode —
 * leaves the in-memory copy serving this page load and is otherwise silent,
 * because a cache miss costs a fetch and nothing more.
 */
export function setManagerCache<T>(key: string, value: T): void {
  if (boundIdentity === null) return;
  if (value === undefined) return;
  const env: Envelope<T> = { v: SCHEMA_VERSION, id: boundIdentity, at: Date.now(), data: value };
  memory.set(key, env as Envelope<unknown>);
  const s = storage();
  if (!s) return;
  const full = storageKey(key);
  try {
    s.setItem(full, JSON.stringify(env));
  } catch {
    // Most likely quota. Make room by dropping the oldest entries and try once
    // more; if it still fails, the in-memory copy serves this page load.
    try {
      trimToCapacity(s, full);
      s.setItem(full, JSON.stringify(env));
    } catch {
      /* see doc comment */
    }
    return;
  }
  trimToCapacity(s, full);
}

export function clearManagerCache(key: string): void {
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
 * Called on a viewer swap and on sign-out. Enumerates the prefix rather than
 * walking known keys, so an entry for a week nobody is looking at any more, or
 * one left behind by an older deploy, is still removed.
 */
export function clearAllManagerCache(): void {
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
 * Stable cache keys. Centralized so call sites cannot drift apart on spelling.
 *
 * Keys do NOT carry the viewer's email — the identity stamp does that isolation.
 * They DO carry every parameter that selects a genuinely different dataset for
 * the same viewer.
 *
 * **Every key here is wired to a live call site.** An unused key is an
 * invitation to cache something under a shape it was not written for; if a
 * dataset stops being cached, delete its key with the call site.
 *
 * To cache one more dataset: add a key, swap that call site's `useState(initial)`
 * for `useManagerCachedState(KEY, initial)`, and **leave the fetch effect
 * alone** — that is what keeps stale-while-revalidate true by construction.
 * Cache the RAW payload, never a derived shape holding a `Set`, `Map` or `Date`.
 */
export const MANAGER_CACHE_KEYS = {
  /** `/api/manager/department-members` — the roster rows plus the server's scope. */
  teamRoster: 'shell:team-roster',
  /**
   * `/api/manager/time-adjustments` rows ONLY.
   *
   * The response's `signedUrls` map is deliberately excluded — those URLs
   * expire, and a cached one paints a broken image where an uncached one paints
   * nothing at all.
   */
  timeAdjustmentRows: 'shell:time-adjustment-rows',
  /**
   * The pending-approvals badge count.
   *
   * Its own key rather than `timeAdjustmentRows.length`, because the two are
   * deliberately different numbers: the shell counts rows with `status ===
   * 'pending'`, while the Time Adjustments tab reports "things waiting on ME"
   * across both approver hats and overwrites the badge with that
   * (`ManagerApp.tsx:1640`). Whichever wrote last is the one to restore.
   */
  pendingApprovalCount: 'shell:pending-approval-count',
  /**
   * The pending-leave badge count.
   *
   * The count, not the list: `/api/leave-requests?scope=all` is company-wide and
   * the shell reads one number off it. The cached value IS the state here, so
   * there is no second derivation the seed path could diverge from.
   */
  pendingLeaveCount: 'shell:pending-leave-count',
  /** The viewer's resolved display name for the Overview greeting. */
  viewerName: 'overview:viewer-name',
  /**
   * `/api/bonus-catalog` raw payload — bonus definitions plus assignments.
   *
   * Shared by the Overview scoring queue and the Departments KPI calculator:
   * same URL, same shape, one key.
   */
  bonusCatalog: 'ref:bonus-catalog',
  /** `/api/app-settings?keys=usd_to_php_rate,usd_to_cop_rate` raw values map. */
  fxRates: 'ref:fx-rates',
  /**
   * The three summary payloads behind the Overview "Bonuses to score" panel,
   * **with the pay week they describe stored inside the value**.
   *
   * Raw — the render shape is re-derived by `buildBonusScoringItems`, which both
   * the seed and the fetch path call.
   *
   * The week is inside rather than in the key so the panel can paint before
   * `usePayWeeks` has resolved the live week (that resolve is a fetch of its
   * own, and keying on its answer would mean a skeleton on every Overview
   * visit). **Paint only**: the panel labels the week it is showing
   * (`fmtPayWeek`), so a cached week is self-declaring on screen, and when the
   * live resolve lands on a different week the seeded paint is replaced by that
   * week's load. Nothing downstream keys a write on it — the calculators resolve
   * their own week, and this panel only deep-links a department.
   */
  scoringSummaries: 'overview:scoring',
  /** `/api/offboarding-queue` raw rows (My Team row badges). */
  offboardingQueue: 'team:offboarding-queue',
  /** `/api/resignation-requests?scope=all` raw rows (My Team row badges). */
  resignations: 'team:resignations',
  /** `/api/employee-skill-sets` raw payload for the team roster. */
  skillSets: 'team:skill-sets',
  /** The three `/api/department-transfers` scopes, cached as one raw triple. */
  transfers: 'transfers:scopes',
  /** The Bonus History tab's three raw summary payloads. */
  bonusHistory: 'bonus-history:summaries',
} as const;
