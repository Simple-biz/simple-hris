/**
 * Catalog-aware rate resolution for payroll math.
 *
 * The Payment Catalog (`payment_catalog_pay_structures`) drives rates with this
 * priority, applied at COMPUTE TIME (nothing is written to the DB here):
 *
 *     individual (employee) structure  →  sheet rate  →  department base
 *
 * - An **employee** structure is a person's unique/negotiated rate. It wins over
 *   everything (their raise always applies).
 * - The **sheet** rate is the employee's existing rate already stored in HRIS
 *   (`employee_rate_history` / `employee_hourly_rates`). It is the middle layer
 *   so a tenured employee keeps their raised rate even without a personal
 *   catalog entry.
 * - A **department** structure is just a BASE / fallback — the starting rate for
 *   anyone in the department who has no individual rate at all (e.g. a brand-new
 *   hire). It never overrides an existing individual rate.
 *
 * Callers interleave the sheet themselves:
 *     effective = employeeCatalog ?? sheetRate ?? departmentBase
 *
 * Currency: each structure carries its own currency (PHP or USD). Because all
 * downstream pay math accumulates in PHP, a USD rate is converted to its
 * PHP-equivalent here (× the FX rate); the native rate + currency are returned
 * alongside for display.
 *
 * "Live cycle only": callers decide WHEN to apply the overlay. `current-pay.ts`
 * (the live dispatch cycle) always applies it; historical estimates apply it
 * only for current/future periods so past replays keep resolving from dated
 * history.
 */
import { deptKeyAliasSlugs, type DepartmentRegistryEntry } from '@/lib/departments/registry';
import {
  type PayStructure,
  type PayCurrency,
  defaultOtRate,
} from '@/lib/payment-catalog/pay-structure';
import { phpPerUnit, type FxRates } from '@/lib/fx/currency-fx';
import { normEmail } from '@/lib/email/norm-email';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { slugifyDeptKey } from '@/lib/departments/registry';
import { isHslFamilyLabel } from '@/lib/departments/hsl-subdept';

/** Indexed view of the catalog for O(1) per-employee resolution. */
export interface CatalogRateIndex {
  /** normalized employee email → employee-scoped structure. */
  byEmail: Map<string, PayStructure>;
  /** canonical department key → department-scoped structure. */
  byDeptKey: Map<string, PayStructure>;
  /** slug → structure key for the FORMER/CURRENT labels of renamed in-app
   *  departments (see buildCatalogRateIndex). Absent when no registry was given. */
  aliasKeys?: ReadonlyMap<string, string>;
}

/** A catalog rate resolved for one employee, ready for PHP pay math. */
export interface ResolvedCatalogRate {
  /** PHP-equivalent regular rate (USD converted at the FX rate). */
  regPhp: number;
  /** PHP-equivalent OT rate (defaults to 1.5× regular when the structure omits it). */
  otPhp: number;
  /** Rate in its native currency (for display). */
  regNative: number;
  otNative: number;
  currency: PayCurrency;
  /** Which scope matched. */
  source: 'employee' | 'department';
}

/**
 * Build a lookup from the flat list returned by `listPayStructures()`. When two
 * structures share a key the later one wins (matches `upsert`-by-id semantics).
 */
export function buildCatalogRateIndex(
  structures: PayStructure[],
  /**
   * The in-app department registry, when the caller has it. A RENAMED registry
   * department keeps its key (the slug of its ORIGINAL name), so a master cell
   * carrying the NEW name slugs to something that is not a structure key. The
   * registry's alias slugs (`deptKeyAliasSlugs`) close that gap here; without
   * it, the person silently loses the department base. Optional so the eleven
   * existing callers keep compiling — pass it wherever the registry is loaded.
   */
  registry: readonly DepartmentRegistryEntry[] = [],
): CatalogRateIndex {
  const byEmail = new Map<string, PayStructure>();
  const byDeptKey = new Map<string, PayStructure>();
  for (const s of structures) {
    if (s.scope === 'employee') {
      const em = normEmail(s.employeeEmail ?? '');
      if (em) byEmail.set(em, s);
    } else if (s.scope === 'department') {
      byDeptKey.set(s.departmentKey, s);
    }
  }
  const aliasKeys = registry.length > 0 ? deptKeyAliasSlugs(registry) : undefined;
  return aliasKeys && aliasKeys.size > 0 ? { byEmail, byDeptKey, aliasKeys } : { byEmail, byDeptKey };
}

function toResolved(s: PayStructure, fx: FxRates): ResolvedCatalogRate {
  const regNative = Number.isFinite(s.regularRate) ? s.regularRate : 0;
  // OT is optional in the catalog; fall back to the documented 1.5× default so a
  // catalog-covered employee never mixes a catalog regular with a sheet OT.
  const otNative =
    s.otRate != null && Number.isFinite(s.otRate) ? s.otRate : defaultOtRate(regNative);
  // PHP-equivalent of 1 unit of the structure's currency (USD via usdToPhp, COP
  // via the USD-anchored cross-rate, PHP -> 1).
  const factor = phpPerUnit(s.currency, fx);
  return {
    regPhp: regNative * factor,
    otPhp: otNative * factor,
    regNative,
    otNative,
    currency: s.currency,
    source: s.scope === 'employee' ? 'employee' : 'department',
  };
}

/**
 * Resolve the INDIVIDUAL (employee-scoped) catalog rate, trying each supplied
 * alias email. Returns null when the employee has no personal structure — the
 * caller then falls back to the sheet rate, then the department base.
 *
 * @param emails one or more alias emails (work / personal / alternates).
 * @param fx USD-anchored FX rates used to convert USD/COP structures to PHP-equivalent.
 */
export function resolveEmployeeCatalogRate(
  index: CatalogRateIndex,
  emails: string | Iterable<string>,
  fx: FxRates,
): ResolvedCatalogRate | null {
  const list = typeof emails === 'string' ? [emails] : Array.from(emails);
  for (const e of list) {
    const em = normEmail(e);
    if (!em) continue;
    const s = index.byEmail.get(em);
    if (s) return toResolved(s, fx);
  }
  return null;
}

/**
 * Which department label the DEPARTMENT-base leg should resolve through.
 *
 * Both payout engines historically preferred the label on the employee's
 * `employee_hourly_rates` row over the master-list cell. That is right almost
 * everywhere — the rates row is the payroll-side record — but it is WRONG for
 * HSL, because the HSL rates mirror hardcodes `"Hogan Smith Law"` on every HSL
 * row (`hsl-upload-db.ts`). So a person whose master cell says
 * `hsl:intake_specialist` had their sub-team buried under the flattened parent
 * label, and no sub-team base rate could ever apply to them. That is the
 * "HARD HOLD" recorded in docs/features/hsl-subdepartments.md §8.
 *
 * The fix is deliberately NARROW: prefer the master label **only when the master
 * label is HSL-family**, which is precisely the case the mirror flattens.
 * Everywhere else the rates-row label stays authoritative.
 *
 * Why not simply prefer the master label everywhere (which is how §8 phrased the
 * pending edit): measured against live data on 2026-08-14, a blanket flip changed
 * exactly one person — `carla@` (master `USEE`, rates row `Lead Gen`) — from a
 * ₱175 department base to **no base at all**, because `USEE` has no rate row.
 * Broadening the change to fix HSL would have introduced that regression for a
 * population the HSL cutover has nothing to do with. So the rule states the
 * actual defect instead of a superset of it.
 *
 * @param masterRaw the master-list `Department` cell (identity source of truth)
 * @param ratesRaw  the `employee_hourly_rates."Department"` label
 */
export function resolveDeptLabelForRate(
  masterRaw: string | null | undefined,
  ratesRaw: string | null | undefined,
): string | null {
  const master = (masterRaw ?? '').trim();
  const rates = (ratesRaw ?? '').trim();
  // An HSL master cell names the SUB-TEAM; the rates row can only ever say the
  // flattened parent, which resolves a strictly less specific rate.
  if (master && isHslFamilyLabel(master)) return master;
  return rates || master || null;
}

/**
 * Resolve the DEPARTMENT base rate — the lowest-priority fallback, applied only
 * when the employee has neither a personal structure nor a sheet rate.
 *
 * @param deptRaw the employee's department NAME (normalized to a key here) or an
 *                already-canonical key; null when unknown.
 */
export function resolveDeptCatalogRate(
  index: CatalogRateIndex,
  deptRaw: string | null | undefined,
  fx: FxRates,
): ResolvedCatalogRate | null {
  if (!deptRaw) return null;
  // SUB-department base rates: a namespaced label/key ("hsl:intake_specialist",
  // "medical_billing:intake_team") carries its OWN base rate — the parent
  // department's base is only the fallback. This MUST run before
  // normalizeDeptToKey, which collapses every hsl:* label to hogan_smith_law
  // and would make sub-department structures unreachable.
  const namespaced = deptRaw.trim().toLowerCase();
  if (namespaced.includes(':')) {
    const sub = index.byDeptKey.get(namespaced);
    if (sub) return toResolved(sub, fx);
  }
  // Accept a raw department name or an already-canonical key. In-app
  // departments (Payment Catalog -> Department) key their structures by the
  // slug of their label ("Executive Assistants" -> "executive_assistants"),
  // which the built-in alias map doesn't know -- so when it misses, try the
  // slug before giving up. Keeps Readiness / People / live dispatch resolving
  // a custom department's base rate exactly like a built-in one.
  const slug = slugifyDeptKey(deptRaw);
  const key =
    normalizeDeptToKey(deptRaw) ??
    (index.byDeptKey.has(deptRaw)
      ? deptRaw
      : slug && index.byDeptKey.has(slug)
        ? slug
        // A renamed in-app department: the label's slug is an ALIAS of the key.
        : (slug && index.aliasKeys?.get(slug)) || null);
  if (!key) return null;
  const s = index.byDeptKey.get(key);
  return s ? toResolved(s, fx) : null;
}
