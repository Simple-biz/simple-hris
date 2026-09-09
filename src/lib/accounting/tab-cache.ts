'use client';

import { normEmail } from '@/lib/email/norm-email';

/**
 * In-session cache for the Accounting / CEO / Payroll-Clerk tab datasets.
 *
 * ## What it is for
 *
 * The Accounting shell (`src/App.tsx`) animates between tabs with a keyed
 * `motion.div`, so switching tabs fully unmounts the previous tab and remounts
 * the next one. Without a cache every switch re-runs the tab's fetches from
 * scratch and flashes a loading spinner, even though the data was already on
 * screen seconds ago. The CEO shell (`CeoApp.tsx`) and the Payroll-Clerk shell
 * (`PayrollClerkApp.tsx`) read the same store for the same reason.
 *
 * Values live in an in-memory Map (survives tab switches because the shell
 * itself stays mounted) and are mirrored to **`sessionStorage`** (survives a
 * full page reload within the same browser tab). Consumers follow
 * stale-while-revalidate: seed component state from the cache so data paints
 * instantly, then re-fetch quietly in the background and write the fresh result
 * back.
 *
 * `undefined` is reserved to mean "nothing cached" — callers never store it, so
 * an empty array / `null` is still a valid, distinct cached value.
 *
 * `localStorage` **must not** be used here, for the same reason as the Employee
 * and Manager stores: it outlives the browser, and this cache holds a company
 * roster, a dispatch queue and payout totals.
 *
 * ## Identity, schema version and age — added 2026-09-09
 *
 * This store predates `src/lib/employee/tab-cache.ts` and
 * `src/lib/manager/tab-cache.ts`, both of which were written against rules this
 * one was missing. It now carries the same envelope:
 *
 * - **identity** — every entry is stamped with the viewer it was written for and
 *   reads reject any other stamp. All three shells honour an `?email=` override
 *   and write it to the SAME `sessionStorage` key in the SAME tab, so without
 *   the stamp an elevated viewer previewing as someone else and then returning
 *   to their own dashboard repaints the other identity's roster and payouts.
 * - **schema version** — a deploy that changes a cached payload's shape must not
 *   read the old shape back out of a still-open tab.
 * - **age ceiling** — `sessionStorage` dies with the tab, but a tab can live for
 *   days; a lid closed Friday and opened Monday must not paint Friday's payout
 *   totals as current.
 *
 * Reads **fail closed**: a mismatched identity, an unknown version, a malformed
 * envelope or an entry past {@link MAX_AGE_MS} is treated as absent, which costs
 * a fetch and nothing more.
 *
 * ### Why this store self-binds and the other two do not
 *
 * `EmployeeApp.renderContent` returns `null` until identity resolves, so the
 * Employee store can be strictly inert until `bindEmployeeCacheIdentity` runs.
 * The three shells here render their tabs immediately and resolve the viewer in
 * an effect, and their consumers seed through plain `useState` initialisers
 * (`getTabCache(...)`) rather than a hook — so an inert-until-bound store would
 * miss on every reload and never look again. That is
 * `manager-dashboard-cache.md`'s "getting it wrong makes the feature silently do
 * nothing", reached by a different road.
 *
 * So a read with no bound identity performs a **synchronous self-bind** from the
 * same `sessionStorage` key the shells resolve from ({@link SESSION_EMAIL_STORAGE_KEY},
 * written at login by `app/login/page.tsx`). That is available before the first
 * render on a reload, which is exactly the case the mirror exists for. The
 * shells still call {@link bindAccountingCacheIdentity} explicitly, because that
 * is what PURGES on a viewer swap; the self-bind only ever adopts an identity,
 * it never purges.
 *
 * On the server `storage()` returns `null`, so reads are inert and every
 * consumer's `useState` initialiser produces its `initial` — unchanged from
 * before this envelope existed.
 *
 * ## The skip-fetch flag
 *
 * Unlike the Employee, Manager and KPI stores, this one deliberately keeps
 * {@link hasFetchedThisSession} — see
 * `docs/features/accounting-dashboard-cache.md` § *The skip-flag policy* for
 * which datasets may use it and which may not. The short version: it is for
 * lookup lists and heavy aggregate snapshots, and it is **banned** on any
 * dataset carrying a per-person pay figure or a shared approval queue, because
 * there a skipped fetch freezes one person's view of work somebody else has
 * already done. `tab-cache.test.ts` pins that boundary.
 */

/** Bumped whenever a cached SHAPE changes; orphans blobs written by an older deploy. */
const SCHEMA_VERSION = 1;

const STORAGE_PREFIX = 'acct-cache:';

/** Where the currently-bound identity is remembered, so a reload can detect a swap. */
const IDENTITY_KEY = `${STORAGE_PREFIX}@identity`;

/**
 * The viewer key all three shells resolve from, and the source of the
 * synchronous self-bind described above.
 *
 * Declared here rather than imported from `@/lib/rbac/views` on purpose: that
 * module is a React module (it exports hooks), and this one is a storage leaf
 * imported by a dozen call sites. `tab-cache.test.ts` asserts this constant
 * still equals `SESSION_EMAIL_KEY` so the two cannot drift.
 */
export const SESSION_EMAIL_STORAGE_KEY = 'employee_session_email';

/**
 * Hard ceiling on how old a cached value may be before it is treated as absent.
 *
 * Twelve hours, matching the Employee and Manager stores: same-day reloads stay
 * instant (the case being solved) and nothing from a previous working day can
 * paint. Datasets that need a tighter window enforce their own on top — the
 * Payroll Notes readiness snapshot treats anything over 6h as a cold load
 * (`payroll-wizard-notes.md`), and the stricter of the two always wins.
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

/** null until bound or self-bound. While null the cache is inert. */
let boundIdentity: string | null = null;

/** Test seam. Production never calls this; `null` restores real sessionStorage. */
let storageOverride: Storage | null = null;

/** @internal — tests only. */
export function __setAccountingCacheStorage(s: Storage | null): void {
  storageOverride = s;
}

/** @internal — tests only. Drops in-memory state without touching storage. */
export function __resetAccountingCacheMemory(): void {
  memory.clear();
  fetchedThisSession.clear();
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

/**
 * The identity reads and writes are stamped with.
 *
 * Adopts the shell's session email when nothing has been bound yet (see the
 * module doc). Never purges — only {@link bindAccountingCacheIdentity} and
 * {@link clearAllAccountingCache} do that.
 */
function currentIdentity(): string | null {
  if (boundIdentity !== null) return boundIdentity;
  const s = storage();
  if (!s) return null;
  try {
    const adopted = normEmail(s.getItem(SESSION_EMAIL_STORAGE_KEY));
    if (adopted !== null) boundIdentity = adopted;
    return boundIdentity;
  } catch {
    return null;
  }
}

function isFreshEnvelope(env: Envelope<unknown>, identity: string, now: number): boolean {
  return (
    env.v === SCHEMA_VERSION &&
    env.id === identity &&
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

/** Every `acct-cache:` key currently in storage, identity marker excluded. */
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
 * Call it as soon as the shell's viewer email resolves. An empty / unresolvable
 * email is IGNORED rather than treated as a sign-out: all three shells start
 * with `viewerEmail === null` and fill it in from an effect, so purging on a
 * falsy value would wipe the cache on the first render of every page load and
 * defeat the mirror entirely. Sign-out calls {@link clearAllAccountingCache}
 * directly instead — the next person on that tab should never have the bytes on
 * disk at all.
 */
export function bindAccountingCacheIdentity(email: string | null | undefined): void {
  const next = normEmail(email);
  if (next === null) return; // unresolved, not signed out — see doc comment

  // No short-circuit on `boundIdentity === next`. A self-bind (see the module
  // doc) adopts the shell's session email WITHOUT consulting the on-disk
  // identity marker, so the marker can still name a previous viewer whose bytes
  // are sitting in storage. Those bytes are already unreadable — every read
  // checks `env.id` — but "the next person on that tab should never have the
  // bytes on disk at all" is the rule, so the marker is reconciled on every
  // bind, not only on a change of `boundIdentity`.
  const s = storage();
  let previous: string | null = null;
  try {
    previous = s?.getItem(IDENTITY_KEY) ?? null;
  } catch {
    previous = null;
  }
  if (previous !== null && previous !== next) {
    // Someone else's data is sitting here. Drop it before anything can read it.
    clearAllAccountingCache();
  }
  boundIdentity = next;
  try {
    s?.setItem(IDENTITY_KEY, next);
  } catch {
    /* the in-memory identity still governs this page load */
  }
}

/** The identity the cache is currently bound to, or null if inert. */
export function boundAccountingCacheIdentity(): string | null {
  return boundIdentity;
}

function readEnvelope<T>(key: string): Envelope<T> | undefined {
  const identity = currentIdentity();
  if (identity === null) return undefined;
  const now = Date.now();

  const inMemory = memory.get(key);
  if (inMemory) {
    if (isFreshEnvelope(inMemory, identity, now)) return inMemory as Envelope<T>;
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
  if (!isFreshEnvelope(env, identity, now)) {
    clearTabCache(key);
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
export function getTabCache<T>(key: string): T | undefined {
  return readEnvelope<T>(key)?.data;
}

/** Epoch ms `key` was written, or undefined — for "as of" labels. */
export function readTabCacheStamp(key: string): number | undefined {
  return readEnvelope<unknown>(key)?.at;
}

export function hasTabCache(key: string): boolean {
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
export function setTabCache<T>(key: string, value: T): void {
  const identity = currentIdentity();
  if (identity === null) return;
  if (value === undefined) return;
  const env: Envelope<T> = { v: SCHEMA_VERSION, id: identity, at: Date.now(), data: value };
  memory.set(key, env as Envelope<unknown>);
  const s = storage();
  if (!s) return;
  try {
    s.setItem(storageKey(key), JSON.stringify(env));
  } catch {
    /* see doc comment — the in-memory copy still serves this page load */
  }
}

export function clearTabCache(key: string): void {
  memory.delete(key);
  // A dataset that is being invalidated must be re-pulled, not skipped.
  fetchedThisSession.delete(key);
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(storageKey(key));
  } catch {
    /* ignore */
  }
}

/**
 * Drop every cached entry, the identity marker, and every skip-fetch flag.
 *
 * Called on sign-out and on an identity swap. Enumerates the prefix rather than
 * walking {@link TAB_CACHE_KEYS} so a key added by a future tab, or one left
 * behind by an older deploy, is still removed.
 *
 * Clearing {@link fetchedThisSession} is not optional: a flag that outlived its
 * data would report "already pulled" for a dataset that has just been purged,
 * and the pane that skipped on the strength of it would stay permanently empty.
 */
export function clearAllAccountingCache(): void {
  memory.clear();
  fetchedThisSession.clear();
  boundIdentity = null;
  const s = storage();
  if (!s) return;
  try {
    for (const k of storedDataKeys(s)) s.removeItem(k);
    s.removeItem(IDENTITY_KEY);
  } catch {
    /* ignore */
  }
}

// Tracks which datasets have actually been PULLED FROM THE SERVER during this
// page-load session. Deliberately NOT persisted: a full reload starts empty, so
// data is re-pulled fresh. A tab switch, by contrast, only remounts the tab —
// the flag survives, so the (potentially heavy) refetch can be skipped and the
// tab repaints instantly from the cache above.
//
// It is cleared by `clearTabCache` and `clearAllAccountingCache`, so a flag can
// never outlive the data it refers to.
//
// See `docs/features/accounting-dashboard-cache.md` § *The skip-flag policy* for
// where this may and may not be used. It is BANNED on per-person pay figures and
// on shared approval queues.
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
//
// Keys do NOT carry the viewer's email — the identity stamp does that isolation.
// A key only needs the parameters that select a genuinely different dataset for
// the SAME viewer (a week, a status filter).
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
  // Bank Preferred change requests render as rows in the same Issues table and
  // are cached per status filter alongside the disputes they sit with.
  bankPreferredRequests: (statusFilter: string) => `bank-preferred-requests:${statusFilter}`,
  overviewPayouts: 'overview:payouts',
  overviewPabMetrics: 'overview:pab-metrics',
  peopleRoster: 'people:list',
  transfers: 'transfers:list',
  // Payroll Notes / Readiness FAB (PayrollWizardNotesFab). The FAB unmounts
  // whenever you leave the Payroll Wizard tab, and its panes unmount on
  // every inner tab switch — without these it re-pulled every dataset (incl.
  // the heavy readiness snapshot, twice: ring + pane) each time.
  payrollNotesRows: 'payroll-notes:rows',
  payrollNotesWorkers: 'payroll-notes:workers',
  payrollNotesUploads: 'payroll-notes:hubstaff-uploads',
  /** Readiness snapshots are cached per week; '' = the server's default week.
   *  Read by BOTH the FAB's score ring and the Readiness pane. */
  payrollReadiness: (sourceFile: string | null) => `payroll-notes:readiness:${sourceFile ?? ''}`,
  /** Offboarded final-pay candidates, cached per week like readiness ('' = the
   *  server's default week). Stamped shape: { people, weekLabel, degraded, at }. */
  payrollNotesOffboarded: (sourceFile: string | null) =>
    `payroll-notes:offboarded:${sourceFile ?? ''}`,
} as const;
