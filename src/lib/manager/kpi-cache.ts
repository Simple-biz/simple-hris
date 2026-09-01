'use client';

import { normEmail } from '@/lib/email/norm-email';

/**
 * Remount- and reload-surviving cache for the Manager KPI Calculator.
 *
 * ## What it is for
 *
 * `ManagerApp` renders its content pane inside an `AnimatePresence mode="wait"`
 * keyed on `activeTab` (`ManagerApp.tsx:404`), so leaving the KPI Calculator tab
 * **unmounts both calculators** — that is deliberate and load-bearing (it is what
 * flushes a pending autosave, see `memory/kpi-calculator-autosave`). The cost is
 * that coming back re-runs every fetch from cold:
 *
 *   | calculator | per visit                                                     |
 *   |------------|---------------------------------------------------------------|
 *   | HSL        | 1 week-resolve + **3 per branch** (entries · status · members)  |
 *   | Departments| 1 week-resolve + catalog + FX + **2–3 per dept**               |
 *
 * all `cache: 'no-store'`. A manager with six branches pays 19 round-trips to
 * look at a number they were looking at ten seconds ago. Listed as still-open in
 * `memory/dashboard-switch-performance` ("/manager re-fetches on every tab
 * switch"). This module closes it without touching the mounting model.
 *
 * Values are held in an in-memory Map and mirrored into **`sessionStorage`**, so
 * the cache survives a tab switch, a reload, and a hop to another dashboard, and
 * dies with the browser tab.
 *
 * ## The rule that makes this safe on a money surface
 *
 * **A cached value paints; it never decides.**
 *
 * Every consumer seeds its state from the cache so the screen is instant, then
 * runs its normal unconditional fetch and overwrites it. There is deliberately
 * NO "already fetched, skip it" flag here — the Accounting store
 * (`src/lib/accounting/tab-cache.ts`) exports `hasFetchedThisSession`, and
 * importing that idea onto this surface would be a bug for the same reason it
 * would be on the Employee portal (`docs/features/employee-dashboard-cache.md`):
 * KPI entries are edited concurrently by other scorers and re-pulled by
 * `useLiveRefresh`, so a skipped fetch freezes one manager's view of a week that
 * somebody else has since changed. Stale-then-corrected is fine.
 * Stale-and-stop is how two people score the same week twice.
 *
 * Three things follow, and none of them may be relaxed:
 *
 * 1. **`weekResolved` is never seeded from here.** The payroll week is the one
 *    flag every read and write is held on — `(department, period_start)` is a KPI
 *    row's only address and the local-clock seed is a guess, so writing before
 *    the Hubstaff batch resolves it strands rows under a key no reader asks for
 *    (`docs/features/hsl-kpi-calculator-2026-07.md` → *First-load reveal*;
 *    `kpiAutosaveGate`'s `week-unresolved`). {@link KPI_CACHE_KEYS.presumedWeek}
 *    exists only to pick WHICH cached week to paint while the live resolve is in
 *    flight. If the live answer differs, the painted week is simply a different
 *    key and is replaced.
 * 2. **Nothing seeded from here is ever `dirty`.** A cached payload came out of
 *    the database, so it is by definition already persisted. Seeding it dirty
 *    would let merely *opening* the tab autosave it — the exact failure
 *    `DeptState.seeded` exists to prevent.
 * 3. **Only raw API payloads go in.** A `Set` JSON-round-trips to `{}` and a
 *    `Date` to a string. `DeptState.rosterEmails` is a `Set` and
 *    `DeptState.subTeams` holds SSD inputs that are *deliberately* never
 *    persisted (blank-after-reload is what makes `subTeamInputsBlank` stop
 *    `recomputeSsdEntries` writing ₱0 over banked shares). Both are re-derived,
 *    by the same function the fetch path uses, from the raw rows cached here.
 *
 * ## Identity
 *
 * Every entry is stamped with the viewer it was written for, reads reject any
 * other stamp, the cache is **inert until {@link bindKpiCacheIdentity} is
 * called**, and binding a different viewer purges everything first.
 *
 * That is load-bearing, not decoration: which departments a manager may score,
 * which members are in their QC assignment, and whose name lands in `applied_by`
 * all follow from the viewer. Two managers sharing a machine must never paint
 * each other's branches.
 *
 * Mirrors `src/lib/employee/tab-cache.ts` in shape. What is different here: keys
 * are parameterised by `(surface, department, payroll week)` rather than fixed,
 * because a manager can switch weeks and the same dept key means different rows
 * in the manager and QC tables.
 */

/** Bumped whenever a cached SHAPE changes; orphans blobs written by an older deploy. */
const SCHEMA_VERSION = 1;

const STORAGE_PREFIX = 'mgr-kpi:';

/** Where the currently-bound viewer is remembered, so a reload can detect a swap. */
const IDENTITY_KEY = `${STORAGE_PREFIX}@identity`;

/**
 * Hard ceiling on how old a cached value may be before it is treated as absent.
 *
 * Matches the Employee portal's ceiling for the same reason: sessionStorage dies
 * with the tab, but a tab can live for days, and a laptop lid closed on Friday
 * and opened on Monday must not paint Friday's scores as this week's work. The
 * week is part of every data key as well, so this is the second of two holds,
 * not the only one.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Most data entries kept at once, oldest-written evicted first.
 *
 * The department calculator has a week picker, so a manager reviewing a month of
 * history mints a new key per (dept, week) pair. Unbounded, that walks into a
 * `QuotaExceededError` on the write that matters most — the current week's. The
 * ceiling is generous enough that a full roster of branches for the live week
 * plus a few weeks of back-reading all fit.
 */
const MAX_ENTRIES = 48;

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
export function __setKpiCacheStorage(s: Storage | null): void {
  storageOverride = s;
}

/** @internal — tests only. Drops in-memory state without touching storage. */
export function __resetKpiCacheMemory(): void {
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

/** Every `mgr-kpi:` key currently in storage, identity marker excluded. */
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
 * Call this the moment the viewer resolves and BEFORE any calculator mounts.
 * Passing `null` (signed out / identity lost) purges and leaves the cache inert.
 */
export function bindKpiCacheIdentity(email: string | null): void {
  const next = normEmail(email);
  if (next === null) {
    clearAllKpiCache();
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
    // Another manager's branches are sitting here. Drop them before anything
    // can read them.
    clearAllKpiCache();
  }
  boundIdentity = next;
  try {
    s?.setItem(IDENTITY_KEY, next);
  } catch {
    /* the in-memory identity still governs this page load */
  }
}

/** The viewer the cache is currently bound to, or null if inert. */
export function boundKpiCacheIdentity(): string | null {
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
    clearKpiCache(key);
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
export function getKpiCache<T>(key: string): T | undefined {
  return readEnvelope<T>(key)?.data;
}

/** Epoch ms `key` was written, or undefined — for the "as of" stamp. */
export function readKpiCacheStamp(key: string): number | undefined {
  return readEnvelope<unknown>(key)?.at;
}

export function hasKpiCache(key: string): boolean {
  return readEnvelope<unknown>(key) !== undefined;
}

/**
 * Drop the oldest data entries until at most {@link MAX_ENTRIES} remain.
 *
 * Reads each stored envelope's own `at` rather than relying on insertion order,
 * so a reload (which repopulates from storage in arbitrary order) still evicts
 * the genuinely oldest week rather than whatever happened to be enumerated first.
 */
function trimToCapacity(s: Storage, keepKey: string): void {
  const stored = storedDataKeys(s);
  if (stored.length <= MAX_ENTRIES) return;
  const dated = stored
    .filter((k) => k !== keepKey)
    .map((k) => {
      const env = decode((() => {
        try {
          return s.getItem(k);
        } catch {
          return null;
        }
      })());
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
export function setKpiCache<T>(key: string, value: T): void {
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
    // Most likely quota. Make room by dropping the oldest weeks and try once
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

export function clearKpiCache(key: string): void {
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
 * Called on a viewer swap. Enumerates the prefix rather than walking known keys
 * so an entry for a week nobody is looking at any more, or one left behind by an
 * older deploy, is still removed.
 */
export function clearAllKpiCache(): void {
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
 * Which calculator a cached entry belongs to.
 *
 * The department calculator's `manager` and `qc` variants read and write
 * DIFFERENT tables (`bonus_catalog_applied` vs the `qc_kpi_submissions` staging
 * table) through different routes, under the same department keys. Keying them
 * apart is what stops an officer's first-pass painting as the official applied
 * rows a manager is about to lock.
 */
export type KpiCacheSurface = 'hsl' | 'dept-manager' | 'dept-qc';

export function deptSurface(variant: 'manager' | 'qc'): KpiCacheSurface {
  return variant === 'qc' ? 'dept-qc' : 'dept-manager';
}

/**
 * Stable cache keys. Centralized so call sites cannot drift apart on spelling.
 *
 * Keys do NOT carry the viewer's email — the identity stamp does that isolation.
 * They DO carry every parameter that selects a genuinely different dataset for
 * the same viewer: the surface, the department, and the payroll week.
 *
 * **Every key here is wired to a live call site.** An unused key is an invitation
 * to cache something under a shape it was not written for.
 *
 * To cache one more dataset: add a key factory, seed the call site's state from
 * it, and **leave the fetch effect alone** — that is what keeps
 * stale-while-revalidate true by construction. Cache the RAW payload, never a
 * derived shape holding a `Set`, `Map` or `Date`.
 */
export const KPI_CACHE_KEYS = {
  /**
   * The payroll week last resolved live from the Hubstaff batch, per surface.
   *
   * **Paint only.** This picks which cached week to show while the live resolve
   * is in flight; it never sets `weekResolved` and therefore never unlocks a
   * write. See the module doc, point 1.
   */
  presumedWeek: (surface: KpiCacheSurface): string => `${surface}:presumed-week`,

  /**
   * Raw payload for one HSL branch in one week: the `hsl_bonus_entries` rows,
   * the `hsl_bonus_period_status` rows and the `hsl_team_members` rows, exactly
   * as the three routes returned them.
   */
  hslBranch: (dept: string, week: string): string => `hsl:branch:${dept}:${week}`,

  /**
   * Raw payload for one department in one week: the applied rows (from whichever
   * table the variant reads) and the resolved period status.
   */
  deptApplied: (surface: KpiCacheSurface, dept: string, week: string): string =>
    `${surface}:applied:${dept}:${week}`,

  /**
   * `/api/bonus-catalog` — the bonus definitions and their assignments.
   *
   * Not parameterised: the route answers the same for every surface and every
   * week. **Paint only**, and more strictly so than the rest of this registry —
   * a definition decides the peso figure a save stores
   * (`docs/features/bonus-catalog.md` → *FX at save time*), so the department
   * calculator seeds its display from this while `catalogLoaded`, and with it
   * `weekPending`, still waits on the live fetch before scoring is possible.
   */
  catalog: 'catalog',
} as const;
