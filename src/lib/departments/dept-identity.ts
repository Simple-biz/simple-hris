// Display identity for catalog (non-HSL) departments: the accent colour and the
// human label a department wears wherever a manager sees it — the KPI
// Calculator's cards, the Bonus History rows and the Overview "Bonuses to
// score" panel.
//
// This used to be a per-file constant copied into each surface with a "keep in
// lockstep with …" comment. One shared table instead, so a new department (or a
// recoloured one) lands everywhere at once.

import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { formatDeptLabel, isHslSubDeptLabel } from '@/lib/departments/hsl-subdept';

/** Per-department accent hex. Distinct hues on purpose — the sales family in
 *  particular must stay tellable apart from the fallback. */
export const CATALOG_DEPT_COLOR: Record<string, string> = {
  accounting: '#10b981',
  edit: '#3b82f6',
  devs: '#8b5cf6',
  lead_gen: '#f59e0b',
  callback: '#06b6d4',
  qc: '#f97316',
  discovery: '#14b8a6',
  hr: '#ec4899',
  // The fallback colour IS #6366f1, so Sales gets its own value to keep the two
  // sales-family cards apart.
  sales: '#ef4444',
  sales_assistant: '#6366f1',
  smm: '#d946ef',
  pm_team: '#0ea5e9',
  client_va: '#84cc16',
  site_building: '#64748b',
};

/** Accent for departments with no entry above (in-app / master-list depts). */
export const DEFAULT_CATALOG_DEPT_COLOR = '#6366f1';

export function catalogDeptColor(key: string): string {
  return CATALOG_DEPT_COLOR[key] ?? DEFAULT_CATALOG_DEPT_COLOR;
}

/** Unknown keys are in-app (Payment Catalog -> Department) departments whose
 *  slug derives from the label -- humanize it back ("executive_assistants" ->
 *  "Executive Assistants"). Already-human labels pass through unchanged.
 *
 *  HSL sub-teams are NAMESPACED, not slugs: the generic humanizer turns
 *  `hsl:filing_specialist` into the nonsense "Hsl:filing Specialist", so they
 *  resolve through `formatDeptLabel` first ("HSL — Filing Specialist"). Same
 *  guard `overview-metrics.ts` already carries; see hsl-subdepartments.md:32,
 *  "displayed anywhere a human reads it". */
export function humanizeDeptKey(key: string): string {
  if (isHslSubDeptLabel(key) || key.trim().toLowerCase().startsWith('hsl:')) {
    return formatDeptLabel(key);
  }
  return key.replace(/_+/g, ' ').replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase());
}

/** Built-in department name, falling back to the humanized slug. */
export function catalogDeptName(key: string): string {
  return DEPARTMENTS.find((d) => d.key === key)?.name ?? humanizeDeptKey(key);
}

/**
 * The Payment Catalog's name for a department key, including departments that
 * exist ONLY in the catalog's in-app registry.
 *
 * `catalogDeptName` alone knows the built-in `DEPARTMENTS` list and humanizes
 * everything else, which is wrong twice for catalog departments: a registry
 * entry has a real display name that humanizing the slug may not reproduce
 * (`medical_billing` → "Medical Billing" only by luck), and a NAMESPACED
 * sub-department key is mangled outright — `medical_billing:intake_team`
 * humanizes to "Medical billing:intake Team".
 *
 * So: registry sub-key → registry parent → built-in → humanized slug. HSL keeps
 * its own path inside `humanizeDeptKey`, which routes `hsl:*` through
 * `formatDeptLabel` (hsl-subdepartments.md §12 — the slug never reaches a human).
 *
 * @param names `key → display name` for BOTH parents and `parent:sub` keys.
 *              Build it with {@link buildCatalogDeptNameMap}.
 */
export function catalogDeptNameFrom(
  key: string | null | undefined,
  names?: ReadonlyMap<string, string> | null,
): string {
  const k = (key ?? '').trim();
  if (!k) return '';
  const registered = names?.get(k);
  if (registered) return registered;
  // A namespaced key whose parent is registered but whose sub is not: name the
  // parent rather than humanizing the whole slug into nonsense.
  const sep = k.indexOf(':');
  if (sep > 0) {
    const parent = names?.get(k.slice(0, sep));
    if (parent) return parent;
  }
  return catalogDeptName(k);
}

/** `key → name` for every Payment Catalog department, parents and sub-units. */
export function buildCatalogDeptNameMap(
  entries: ReadonlyArray<{ key: string; name: string; subDepartments?: ReadonlyArray<{ key: string; name: string }> }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    const parent = (e.name ?? '').trim();
    const pk = (e.key ?? '').trim();
    if (!pk || !parent) continue;
    map.set(pk, parent);
    for (const sub of e.subDepartments ?? []) {
      const sk = (sub.key ?? '').trim();
      const sn = (sub.name ?? '').trim();
      if (sk && sn) map.set(`${pk}:${sk}`, `${parent} — ${sn}`);
    }
  }
  return map;
}
