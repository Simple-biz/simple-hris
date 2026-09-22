'use client';

import { normEmail } from '@/lib/email/norm-email';

/**
 * Remount- and reload-surviving cache for the Admin dashboard shell.
 *
 * ## What it is for
 *
 * `app/admin/page.tsx` renders exactly one tab through a `switch` on
 * `activeTab`, so **every Admin tab unmounts when you leave it** and every fetch
 * it owns re-runs from cold when you come back — the same shape as the Manager
 * shell, and the opposite of the Employee portal (which only hides its tabs).
 * The 2026-09-09 dashboard-cache audit measured Admin as the worst surface by
 * volume (65 fetches, 36 of them `no-store`, zero seeding) and left it open
 * pending a store; this is that store, started 2026-09-17 on the Webhooks &
 * Integrations page (Kane: *"add cache practices as well where it doesn't go
 * away after switching tabs or reload"*). Other Admin tabs join by adding a key
 * and swapping one `useState` — see {@link ADMIN_CACHE_KEYS}.
 *
 * Values are held in an in-memory Map and mirrored into **`sessionStorage`**
 * (never `localStorage`), so a value survives a tab switch, a reload and a hop to
 * another dashboard, and dies with the browser tab.
 *
 * ## The rule that makes this safe
 *
 * **A cached value paints; it never decides.**
 *
 * Every consumer seeds its state from the cache so the screen is instant, then
 * runs its normal unconditional fetch and overwrites it. There is deliberately
 * **no "already fetched, skip it" flag** here (the Accounting store's
 * `hasFetchedThisSession` is that store's ratified exception, not a pattern).
 * An integration client can be revoked, rotated or throttled by another admin
 * in another tab; a skipped fetch would show a dead key as live. A
 * `no-skip-flag` test greps this module's own exports so the flag cannot return
 * by copy-paste.
 *
 * ## What deliberately does NOT go in here
 *
 * - **Anything that is a secret.** The external-API client list carries a key
 *   PREFIX (`hris_live_abc123`) — a fingerprint, not a credential — and that is
 *   the most sensitive thing cached. The plaintext key exists only in the
 *   create/rotate response and is never state that could be cached; a test pins
 *   that no key is spelled like one.
 * - **Unsaved edits.** The Webhooks tab caches its entries only on LOAD and on a
 *   successful SAVE, never on keystroke, so a reload cannot resurrect a draft the
 *   page then reports as "Saved".
 * - **Bank or account fields.** Nothing on this shell holds one; nothing cached
 *   here may become the back door that reintroduces one.
 *
 * ## Identity
 *
 * Every entry is stamped with the viewer it was written for, reads reject any
 * other stamp, the cache is **inert until {@link bindAdminCacheIdentity} is
 * called**, and binding a different viewer purges everything first. Admin honours
 * a `?email=` override in the same tab (`AdminSidebar.tsx`), and two admins may
 * share a machine; neither may paint the other's view.
 *
 * ## Sibling stores
 *
 * `src/lib/employee/tab-cache.ts`, `src/lib/manager/tab-cache.ts`,
 * `src/lib/manager/kpi-cache.ts`, `src/lib/hr/tab-cache.ts`,
 * `src/lib/orphanage/tab-cache.ts` and `src/lib/accounting/tab-cache.ts` are the
 * same envelope with a different prefix and key set. This is a further copy of
 * the Manager store, taken knowingly (memory/admin-dashboard-cache-blueprint-pending
 * records the "extract a factory first" alternative as Kane's call, not the
 * session's); its tests pin the same failure classes.
 */

/** Bumped whenever a cached SHAPE changes; orphans blobs written by an older deploy. */
const SCHEMA_VERSION = 1;

const STORAGE_PREFIX = 'adm-tab:';

/** Where the currently-bound viewer is remembered, so a reload can detect a swap. */
const IDENTITY_KEY = `${STORAGE_PREFIX}@identity`;

/**
 * Hard ceiling on how old a cached value may be before it is treated as absent.
 * A laptop lid closed on Friday must not paint Friday's client list as this
 * morning's — a key revoked over the weekend would read as live until the fetch
 * lands.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Most data entries kept at once, oldest-written evicted first. */
const MAX_ENTRIES = 32;

interface Envelope<T> {
  v: number;
  id: string;
  at: number;
  data: T;
}

const memory = new Map<string, Envelope<unknown>>();

/** null until bound. While null the cache is inert: reads miss, writes no-op. */
let boundIdentity: string | null = null;

/** Test seam. Production never calls this; `null` restores real sessionStorage. */
let storageOverride: Storage | null = null;

/** @internal — tests only. */
export function __setAdminCacheStorage(s: Storage | null): void {
  storageOverride = s;
}

/** @internal — tests only. Drops in-memory state without touching storage. */
export function __resetAdminCacheMemory(): void {
  memory.clear();
  boundIdentity = null;
}

function storage(): Storage | null {
  if (storageOverride) return storageOverride;
  if (typeof window === 'undefined') return null;
  try {
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
 * than the entries already on disk were written for. Passing `null` purges and
 * leaves the cache inert.
 */
export function bindAdminCacheIdentity(email: string | null): void {
  const next = normEmail(email);
  if (next === null) {
    clearAllAdminCache();
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
  if (previous !== null && previous !== next) clearAllAdminCache();
  boundIdentity = next;
  try {
    s?.setItem(IDENTITY_KEY, next);
  } catch {
    /* the in-memory identity still governs this page load */
  }
}

/** The viewer the cache is currently bound to, or null if inert. */
export function boundAdminCacheIdentity(): string | null {
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
    clearAdminCache(key);
    return undefined;
  }
  memory.set(key, env);
  return env as Envelope<T>;
}

/** The cached value for `key`, or `undefined` when there is none (`null` and `[]` are real values). */
export function getAdminCache<T>(key: string): T | undefined {
  return readEnvelope<T>(key)?.data;
}

/** Epoch ms `key` was written, or undefined — for an "as of" stamp. */
export function readAdminCacheStamp(key: string): number | undefined {
  return readEnvelope<unknown>(key)?.at;
}

export function hasAdminCache(key: string): boolean {
  return readEnvelope<unknown>(key) !== undefined;
}

function trimToCapacity(s: Storage, keepKey: string): void {
  const stored = storedDataKeys(s);
  if (stored.length <= MAX_ENTRIES) return;
  const dated = stored
    .filter((k) => k !== keepKey)
    .map((k) => {
      let raw: string | null = null;
      try {
        raw = s.getItem(k);
      } catch {
        raw = null;
      }
      const env = decode(raw);
      return { k, at: env && Number.isFinite(env.at) ? env.at : 0 };
    })
    .sort((a, b) => a.at - b.at);
  let excess = stored.length - MAX_ENTRIES;
  for (const { k } of dated) {
    if (excess <= 0) break;
    try {
      s.removeItem(k);
    } catch {
      /* the next write will try again */
    }
    memory.delete(k.slice(STORAGE_PREFIX.length));
    excess -= 1;
  }
}

/**
 * Cache `value` under `key` for the bound viewer. No-ops while unbound and for
 * `undefined`. A storage failure leaves the in-memory copy serving this page load.
 */
export function setAdminCache<T>(key: string, value: T): void {
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
    try {
      trimToCapacity(s, full);
      s.setItem(full, JSON.stringify(env));
    } catch {
      /* in-memory copy serves this page load */
    }
    return;
  }
  trimToCapacity(s, full);
}

export function clearAdminCache(key: string): void {
  memory.delete(key);
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(storageKey(key));
  } catch {
    /* ignore */
  }
}

/** Drop every cached entry AND the identity marker — on a viewer swap and on sign-out. */
export function clearAllAdminCache(): void {
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
 * Stable cache keys. **Every key here is wired to a live call site.** Cache the
 * RAW payload, never a derived shape holding a `Set`, `Map` or `Date`; leave the
 * fetch effect alone so stale-while-revalidate stays true by construction.
 */
export const ADMIN_CACHE_KEYS = {
  /**
   * `GET /api/admin/external-api-clients` — the raw list response (clients with
   * their key PREFIXES, 7-day counts, unattributed calls, flags, paths). Never
   * the plaintext key: that is not list state.
   */
  integrationsClients: 'integrations:clients',
  /** Which tab of Webhooks & Integrations is open — `'webhooks' | 'integrations'`. */
  webhooksSection: 'webhooks:section',
  /**
   * The webhooks config entries as LOADED or SAVED — never as edited. A draft
   * that survived a reload would paint under a "Saved" button.
   */
  webhooksEntries: 'webhooks:entries',

  /* ── Wired 2026-09-22, on Kane's ruling against the blueprint's open Qs ──── */

  /**
   * `GET /api/employees` — the master-list roster, **projected through
   * `toCachedMasterRow`**.
   *
   * ONE key shared by every Admin tab that needs the roster (the blueprint's
   * **Q3**, answered *shared*): the rows are identical, the fetch is the same
   * URL, and two keys would mean two copies of ~2,800 rows in a storage budget
   * measured in megabytes — with the second copy free to drift.
   *
   * The projection is not optional. A raw `EmployeeRow` carries the person's
   * home address, contact phone, pay rates and a `bankInfo` block; see
   * `src/lib/employee/master-row-cache.ts` for why that may not be mirrored and
   * how the partition is enforced at compile time.
   */
  roster: 'roster',
  /** `GET /api/employee-roles` — RAW assignment rows (email + role key). */
  rolesAssignments: 'roles:assignments',
  /** `GET /api/departments` — RAW `{ departments, builtinSubs }`. */
  rolesDepartments: 'roles:departments',
  /** `GET /api/department-managers` — RAW manager assignment rows. */
  rolesDeptManagers: 'roles:dept-managers',
  /** Overview → headcount only. The Overview pulls the roster to `.length` it and
   *  throws the rows away, so the COUNT is what is stored, not 2,800 rows. */
  overviewEmployeeCount: 'overview:employee-count',
  /** Overview → the parsed `webhooks.config` entries (plain JSON). */
  overviewWebhooks: 'overview:webhooks',
  /** Overview → `GET /api/admin/data-tables-status` — the core-table status card. */
  overviewCoreTables: 'overview:core-tables',
  /** Diagnostics → Payroll Cycles: the aggregate summary and the stamp it was
   *  generated at. Two keys because the stamp is rendered ON SCREEN — a cached
   *  aggregate is self-declaring rather than passing as fresh. */
  diagnosticsCyclePerformance: 'diagnostics:cycle-performance',
  diagnosticsCyclePerformanceGeneratedAt: 'diagnostics:cycle-performance:generated-at',
  /** Diagnostics → HR Pipeline: same shape, same reason. */
  diagnosticsHrPipeline: 'diagnostics:hr-pipeline',
  diagnosticsHrPipelineGeneratedAt: 'diagnostics:hr-pipeline:generated-at',
} as const;
