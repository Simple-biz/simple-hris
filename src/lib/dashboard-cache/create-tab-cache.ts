'use client';

/**
 * The shipped tab-cache envelope, written ONCE, for stores created from here on.
 *
 * ## Why this exists, and what it deliberately does NOT do
 *
 * Seven stores already ship the same ~250 lines with a different prefix and key
 * set: `employee/tab-cache`, `manager/tab-cache`, `manager/kpi-cache`,
 * `accounting/tab-cache`, `admin/tab-cache`, `hr/tab-cache` and
 * `orphanage/tab-cache`. Extracting a factory across them has been the named
 * open follow-up since 2026-09-01, and on 2026-09-22 Kane answered the
 * sequencing question directly: **copy the envelope again rather than migrate
 * the shipped seven first.**
 *
 * This module honours that answer and stops short of overrunning it. It migrates
 * **nothing**. Not one shipped store imports it, and none should as part of this
 * change — that migration is still its own review, against all seven test
 * suites. What it does is keep the count at seven instead of ten: QC, Contractor
 * and Tickets needed a store each, and three more hand-copies of an envelope
 * whose duplication is already the recorded debt would have made the eventual
 * migration half again as large for three small surfaces.
 *
 * ## Which shape this is
 *
 * The **Manager/Admin** shape, not the Accounting one:
 *
 * - `sessionStorage`, never `localStorage` — `localStorage` outlives the browser
 *   and would strand one person's data on a shared machine.
 * - Every entry carries an identity stamp, a schema version and a write time.
 *   Reads FAIL CLOSED on anything malformed.
 * - **Inert until bound.** Reads miss and writes no-op until
 *   `bindIdentity(email)` runs; binding a DIFFERENT viewer purges everything
 *   first. All three shells honour `?email=` in the same tab.
 * - 12-hour ceiling, capacity-bounded with oldest-written evicted first, and
 *   quota or private mode degrades to memory-only rather than throwing.
 * - **No skip-fetch flag, and none can be added here.** Nothing this factory
 *   returns can answer "has this been fetched already", so a consumer cannot
 *   skip its fetch even by accident. The Accounting store's
 *   `hasFetchedThisSession` is that store's ratified exception (Kane, 2026-09-09
 *   — keep-and-police), not a pattern to spread.
 *
 * > **A cached value PAINTS. It never DECIDES.**
 *
 * Consumers seed their state from the cache and then run their existing,
 * unconditional fetch, which overwrites it. Stale-while-revalidate, always.
 *
 * ## What may never be cached, in any store built from this
 *
 * A bank field, an account or routing number, a plaintext key or token, a signed
 * URL (they expire — a cached one paints a broken image), or presence (a stale
 * liveness signal is a WRONG answer, not a stale one). Note that the dangerous
 * shape is not a badly-named key: `employee:profile-rate` leaked payment routing
 * for three weeks because the ROW it cached carried it. When a row mixes
 * categories, project it — `src/lib/employee/master-row-cache.ts` shows the
 * compile-time-partitioned shape.
 *
 * And nothing `JSON.stringify` cannot round-trip: a `Set` or `Map` serialises to
 * `{}` and a `Date` returns as a string. Cache the RAW payload and derive the
 * render shape through a module-scope pure function, so the seeded and the
 * fetched path cannot disagree.
 */

import { normEmail } from '@/lib/email/norm-email';

/** Hard ceiling on how old a cached value may be before it is treated as absent. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Most data entries kept at once, oldest-written evicted first. */
const MAX_ENTRIES = 32;

interface Envelope<T> {
  v: number;
  id: string;
  at: number;
  data: T;
}

export interface TabCache {
  /** Point the cache at a viewer; a different viewer purges first. `null` purges and goes inert. */
  bindIdentity(email: string | null): void;
  /** The viewer currently bound, or `null` when inert. */
  boundIdentity(): string | null;
  /** The cached value, or `undefined` when there is none. `null` and `[]` are real values. */
  get<T>(key: string): T | undefined;
  /** Epoch ms `key` was written — for an "as of" stamp. */
  readStamp(key: string): number | undefined;
  /** Is there something to PAINT under `key`? */
  has(key: string): boolean;
  set<T>(key: string, value: T): void;
  clear(key: string): void;
  /** Drop every entry AND the identity marker — on a viewer swap and on sign-out. */
  clearAll(): void;
  /** @internal — tests only. `null` restores real `sessionStorage`. */
  __setStorage(s: Storage | null): void;
  /** @internal — tests only. Drops in-memory state without touching storage. */
  __resetMemory(): void;
}

/**
 * Build one store.
 *
 * @param storagePrefix Namespace for this store's keys, e.g. `'qc-tab:'`. Must
 *   end in `:` so one store's purge cannot enumerate another's keys by prefix.
 * @param schemaVersion Bump whenever a cached SHAPE changes; orphans blobs
 *   written by an older deploy.
 */
export function createTabCache(storagePrefix: string, schemaVersion = 1): TabCache {
  if (!storagePrefix.endsWith(':')) {
    // Not a defensive nicety: without the separator, a store prefixed `qc-tab`
    // would enumerate — and `clearAll` would DELETE — the keys of one prefixed
    // `qc-tab-archive`.
    throw new Error(`tab cache prefix must end in ":" — got ${JSON.stringify(storagePrefix)}`);
  }

  const IDENTITY_KEY = `${storagePrefix}@identity`;
  const memory = new Map<string, Envelope<unknown>>();
  let boundIdentity: string | null = null;
  let storageOverride: Storage | null = null;

  function storage(): Storage | null {
    if (storageOverride) return storageOverride;
    if (typeof window === 'undefined') return null;
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  }

  const storageKey = (key: string) => storagePrefix + key;

  function isFreshEnvelope(env: Envelope<unknown>, now: number): boolean {
    return (
      env.v === schemaVersion &&
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
        if (k && k.startsWith(storagePrefix) && k !== IDENTITY_KEY) keys.push(k);
      }
    } catch {
      /* a storage that throws mid-enumeration simply yields what it managed */
    }
    return keys;
  }

  function clearAll(): void {
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

  function clear(key: string): void {
    memory.delete(key);
    const s = storage();
    if (!s) return;
    try {
      s.removeItem(storageKey(key));
    } catch {
      /* ignore */
    }
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
      clear(key);
      return undefined;
    }
    memory.set(key, env);
    return env as Envelope<T>;
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
      memory.delete(k.slice(storagePrefix.length));
      excess -= 1;
    }
  }

  return {
    bindIdentity(email: string | null): void {
      const next = normEmail(email);
      if (next === null) {
        clearAll();
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
      if (previous !== null && previous !== next) clearAll();
      boundIdentity = next;
      try {
        s?.setItem(IDENTITY_KEY, next);
      } catch {
        /* the in-memory identity still governs this page load */
      }
    },

    boundIdentity: () => boundIdentity,

    get: <T,>(key: string): T | undefined => readEnvelope<T>(key)?.data,

    readStamp: (key: string): number | undefined => readEnvelope<unknown>(key)?.at,

    has: (key: string): boolean => readEnvelope<unknown>(key) !== undefined,

    set<T>(key: string, value: T): void {
      if (boundIdentity === null) return;
      if (value === undefined) return;
      const env: Envelope<T> = { v: schemaVersion, id: boundIdentity, at: Date.now(), data: value };
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
    },

    clear,
    clearAll,

    __setStorage(s: Storage | null): void {
      storageOverride = s;
    },

    __resetMemory(): void {
      memory.clear();
      boundIdentity = null;
    },
  };
}
