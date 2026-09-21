'use client';

/**
 * What the Payment Catalog puts in -- and takes back out of -- the shared
 * Accounting tab cache (`src/lib/accounting/tab-cache.ts`).
 *
 * The Accounting shell unmounts the tab on every switch (`App.tsx`'s
 * `AnimatePresence key={activeTab}`), so returning to the catalog re-ran the six
 * `CATALOG_SOURCES` reads behind a "Loading catalog..." card with the whole
 * eight-tab surface blank. These readers let it paint what was last on screen
 * while that refetch runs.
 *
 * ## The seed PAINTS; it never DECIDES
 *
 * The Payment Catalog is the rate source of truth, which puts it squarely in the
 * banned category of `accounting-dashboard-cache.md` § *The skip-flag policy*:
 * `hasFetchedThisSession` may never gate `ratesSummary`, the mount fetch always
 * runs, and `tab-cache.test.ts` greps the call sites to keep it that way. A
 * skipped refetch here would freeze one accountant's view of a rate somebody
 * else already changed.
 *
 * ## Why the envelope is not enough
 *
 * The store guarantees identity, schema version and a 12h ceiling. It does NOT
 * guarantee the shape inside: a blob written by a build whose payload shape has
 * since changed, or hand-edited in devtools, still passes the envelope. So every
 * reader below re-validates, and anything it cannot vouch for degrades to the
 * same empty value a cold load would produce -- never to a guess.
 */

import { getTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import type { BonusAssignment, BonusDef } from '@/lib/bonus-catalog/types';
import type { PayStructure } from '@/lib/payment-catalog/pay-structure';
import type { SystemBonus } from '@/lib/payment-catalog/system-bonus';
import type { DepartmentRegistryEntry } from '@/lib/departments/registry';
import type { BuiltinSubMap } from '@/lib/departments/builtin-subs';
import type { PayProcessor } from '@/lib/payment-catalog/pay-processors';
import type { BankGroup } from '@/lib/payment-catalog/banks';
import type { FxRates } from '@/lib/fx/currency-fx';

export type CatalogTab =
  | 'overview'
  | 'search'
  | 'departments'
  | 'pay-processors'
  | 'pay-structure'
  | 'library'
  | 'assignments'
  | 'system-bonuses';

/** Every tab id the tab strip renders. The one list a cached view selection is
 *  validated against -- an id absent from it is not renderable. */
export const CATALOG_TAB_IDS: readonly CatalogTab[] = [
  'overview',
  'search',
  'departments',
  'pay-processors',
  'pay-structure',
  'library',
  'assignments',
  'system-bonuses',
] as const;

export const DEFAULT_CATALOG_TAB: CatalogTab = 'overview';

/**
 * The six `CATALOG_SOURCES` payloads exactly as they were painted, under ONE key.
 *
 * Raw API shapes only (`accounting-dashboard-cache.md` § *Adding another
 * dataset*, rule 5): the mirror is JSON, so every derived index is rebuilt by the
 * component's existing `useMemo`s and the seeded and fetched paths cannot
 * diverge.
 *
 * One entry rather than six because the six land in a single
 * `Promise.allSettled` batch and two of them carry **CAS revisions that may
 * never be separated from the rows they describe** -- the department registry
 * moves with its `revision` and `managers`, and `builtinSubs` moves with
 * `builtinSubsRevision`. Across separate keys the store's own per-key age
 * eviction could drop the rows and keep the token, and a stale revision paired
 * with a fresh registry is how a save clobbers a teammate's edit instead of
 * earning its 409.
 */
export interface CachedCatalog {
  bonuses: BonusDef[];
  assignments: BonusAssignment[];
  payStructures: PayStructure[];
  systemBonuses: SystemBonus[];
  deptRegistry: DepartmentRegistryEntry[];
  deptRegistryRevision: string | null;
  deptManagers: Record<string, string[]>;
  builtinSubs: BuiltinSubMap;
  builtinSubsRevision: string | null;
  payProcessors: PayProcessor[];
  banks: BankGroup[];
}

const isList = (v: unknown): v is unknown[] => Array.isArray(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a blob into a {@link CachedCatalog}, or `null` when there is nothing
 * usable.
 *
 * Exported separately from {@link readCachedCatalog} so the rules can be tested
 * without a storage mock.
 *
 * A partially-valid blob still seeds the parts that ARE valid: that is the same
 * rule the live commits follow, where a read that did not land leaves its slice
 * alone rather than blanking it -- an empty catalog reads as "everything is
 * gone", not as an error.
 */
export function parseCachedCatalog(raw: unknown): CachedCatalog | null {
  if (!isRecord(raw)) return null;
  const list = <T,>(v: unknown): T[] => (isList(v) ? (v as T[]) : []);
  return {
    bonuses: list<BonusDef>(raw.bonuses),
    assignments: list<BonusAssignment>(raw.assignments),
    payStructures: list<PayStructure>(raw.payStructures),
    systemBonuses: list<SystemBonus>(raw.systemBonuses),
    deptRegistry: list<DepartmentRegistryEntry>(raw.deptRegistry),
    // A CAS token is only meaningful beside the rows it describes. If the
    // registry did not survive validation the revision is dropped WITH it, so
    // the Edit Department dialog asks the server instead of comparing-and-
    // swapping on a token for rows nobody is holding.
    deptRegistryRevision:
      isList(raw.deptRegistry) && typeof raw.deptRegistryRevision === 'string'
        ? raw.deptRegistryRevision
        : null,
    deptManagers: isRecord(raw.deptManagers) ? (raw.deptManagers as Record<string, string[]>) : {},
    builtinSubs: isRecord(raw.builtinSubs) ? (raw.builtinSubs as BuiltinSubMap) : {},
    // Same pairing rule, same reason -- `payment_catalog.departments.builtin_subs`
    // carries its own revision.
    builtinSubsRevision:
      isRecord(raw.builtinSubs) && typeof raw.builtinSubsRevision === 'string'
        ? raw.builtinSubsRevision
        : null,
    payProcessors: list<PayProcessor>(raw.payProcessors),
    banks: list<BankGroup>(raw.banks),
  };
}

/** The cached catalog for this viewer, or `null`. */
export function readCachedCatalog(): CachedCatalog | null {
  return parseCachedCatalog(getTabCache<unknown>(TAB_CACHE_KEYS.ratesSummary));
}

/** Validate a cached tab id, falling back to the default. */
export function parseCachedTab(raw: unknown): CatalogTab {
  const tab = isRecord(raw) ? raw.tab : undefined;
  return CATALOG_TAB_IDS.includes(tab as CatalogTab) ? (tab as CatalogTab) : DEFAULT_CATALOG_TAB;
}

/** Which tab the viewer left this catalog on. UI selection only, no row data. */
export function readCachedTab(): CatalogTab {
  return parseCachedTab(getTabCache<unknown>(TAB_CACHE_KEYS.ratesView));
}

/**
 * Validate cached FX rates, or `null`.
 *
 * Both legs must be finite and positive. These only sort the Bonus Library by
 * PHP-equivalent -- they never convert a payout, which happens at apply time in
 * the KPI Calculator -- but a zero or a NaN out of storage would still produce a
 * nonsense ordering, and `null` means the caller keeps `officialFxRates()`.
 */
export function parseCachedFx(raw: unknown): FxRates | null {
  if (!isRecord(raw)) return null;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  return ok(raw.usdToPhp) && ok(raw.usdToCop)
    ? { usdToPhp: raw.usdToPhp, usdToCop: raw.usdToCop }
    : null;
}

/** The cached FX rates, or `null` to keep the official fallback. */
export function readCachedFx(): FxRates | null {
  return parseCachedFx(getTabCache<unknown>(TAB_CACHE_KEYS.ratesFx));
}
