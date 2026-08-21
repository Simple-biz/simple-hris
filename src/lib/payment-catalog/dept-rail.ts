/**
 * The Payment Catalog → Pay Structure department rail, as a GROUPED tree, and the
 * one place a roster person is assigned to a rail entry.
 *
 * Two problems this exists to solve, both live:
 *
 * 1. **The rail was flat.** All 16 `hsl:*` sub-teams sat as siblings of their own
 *    parent, "Hogan Smith Law" (Kane 2026-08-21: *"I want the Hogan Smith Law to be
 *    a drop down where when toggled we can see the Sub departments below it"*).
 *
 * 2. **The parent claimed people who belong to a sub-team.** `normalizeDeptToKey`
 *    collapses every `hsl:*` cell to `hogan_smith_law`, so any membership test that
 *    goes through it puts all 565 HSL people under the parent as well as under their
 *    own team. Kane spotted it as *"Baldonebro ... shouldn't have appeared under
 *    hogan smith law as she is a case manager already"*.
 *
 * Pure — no I/O — so every branch is exercised by node:test.
 */
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import type { PayStructure } from '@/lib/payment-catalog/pay-structure';
import { isHslSubDeptLabel } from '@/lib/departments/hsl-subdept';

/** A rail entry, exactly the `{key, name}` shape the tab already passes around. */
export interface DeptRailEntry {
  key: string;
  name: string;
}

/** One parent and the children disclosed under it. `children` is empty for a
 *  department that has no sub-teams — it still renders, just without a chevron. */
export interface DeptRailGroup {
  parent: DeptRailEntry;
  children: DeptRailEntry[];
}

/**
 * The bucket for people whose department label resolves to NO rail entry.
 *
 * 61 people today: USEE 26, Site Building (US - Freelance) 20, Site Building
 * (PH - Freelancer) 13, Orphan Ministry 1, Manager 1 — labels `normalizeDeptToKey`
 * deliberately maps to no payroll key (USEE is record-only by design, see
 * bonus-catalog.md §3). They get an entry rather than being dropped, because on a
 * surface that claims to list a department's members **a filter never hides a row**
 * — the same rule the People rail-mix band's own "No department" bucket follows.
 *
 * It is a `key` no department can collide with: `slugifyDeptKey` never emits `@`.
 */
export const RAIL_NO_DEPARTMENT_KEY = '@no_department';
export const RAIL_NO_DEPARTMENT_NAME = 'No department';

/** The canonical key every `hsl:*` cell and label collapses to. */
export const HSL_PARENT_KEY = 'hogan_smith_law';

/**
 * The parent of a rail entry key, or null when it is itself a top-level entry.
 *
 * **Declared, never inferred.** The two sub-department families in this rail use
 * opposite conventions and a `split(':')` would silently get HSL wrong:
 *
 * | Family | Child key | Parent key | Prefix == parent? |
 * |---|---|---|---|
 * | HSL | `hsl:intake_specialist` | `hogan_smith_law` | **NO** |
 * | custom registry | `<parentKey>:<subKey>` | `<parentKey>` | yes |
 *
 * @param customParentKeys the registry parent keys currently in the rail — a custom
 *   child is only nested when its parent is actually present, otherwise it would
 *   disappear into a group that never renders.
 */
export function parentOfDeptKey(
  key: string,
  customParentKeys: ReadonlySet<string> = new Set(),
): string | null {
  const k = (key ?? '').trim();
  if (!k) return null;
  // HSL: the prefix is `hsl:` but the parent key is `hogan_smith_law`.
  if (k.toLowerCase().startsWith('hsl:')) return HSL_PARENT_KEY;
  const colon = k.indexOf(':');
  if (colon <= 0) return null;
  const prefix = k.slice(0, colon);
  return customParentKeys.has(prefix) ? prefix : null;
}

/**
 * Group a flat rail into parents and their children, preserving the incoming order
 * of the parents and of the children within each parent.
 *
 * A child whose parent is not in `entries` is promoted to a top-level entry rather
 * than dropped — losing a department off the rail is strictly worse than showing it
 * un-nested.
 */
export function buildDeptRail(entries: readonly DeptRailEntry[]): DeptRailGroup[] {
  const present = new Set(entries.map((e) => e.key));
  const customParents = new Set(
    entries.map((e) => e.key).filter((k) => !k.toLowerCase().startsWith('hsl:') && !k.includes(':')),
  );
  const groups: DeptRailGroup[] = [];
  const byKey = new Map<string, DeptRailGroup>();

  for (const e of entries) {
    const parent = parentOfDeptKey(e.key, customParents);
    if (parent && present.has(parent)) continue; // placed as a child below
    const g: DeptRailGroup = { parent: e, children: [] };
    groups.push(g);
    byKey.set(e.key, g);
  }
  for (const e of entries) {
    const parent = parentOfDeptKey(e.key, customParents);
    if (!parent || !present.has(parent)) continue;
    byKey.get(parent)?.children.push(e);
  }
  return groups;
}

/** Minimum this module needs to know about a roster person. */
export interface RailRosterPerson {
  email: string;
  department: string;
}

/**
 * Does this department CELL belong to this rail entry?
 *
 * Lifted verbatim from `IndividualPayAdder`'s `deptMatched`, which already handled
 * the three shapes: a built-in label via the alias map, a custom department by exact
 * display name (registry keys have no alias entry), and a namespaced `hsl:<key>` /
 * `<parent>:<sub>` cell by RAW key — because `normalizeDeptToKey` collapses
 * `hsl:collections` to the parent and the display name ("HSL — Collections") never
 * equals the cell.
 *
 * Note this is deliberately LOOSE: an `hsl:collections` cell matches its sub-team
 * entry AND the parent entry, since `normalizeDeptToKey` returns `hogan_smith_law`.
 * That is correct for a "who could I add here" picker and wrong for a membership
 * list — {@link assignRosterToRail} is what resolves it to one home.
 */
export function deptCellMatchesEntry(cell: string, entry: DeptRailEntry): boolean {
  const c = (cell ?? '').trim().toLowerCase();
  if (!c) return false;
  const nameKey = (entry.name ?? '').trim().toLowerCase();
  const rawKey = (entry.key ?? '').trim().toLowerCase();
  return (
    normalizeDeptToKey(cell) === entry.key ||
    c === rawKey ||
    (nameKey !== '' && c === nameKey)
  );
}

/**
 * Assign every roster person to EXACTLY ONE rail entry.
 *
 * Most-specific wins: a person whose cell names a sub-team lands under that sub-team
 * and **not** under its parent. Without this the parent entry lists its whole family
 * — 565 people under "Hogan Smith Law" — which is precisely the Baldonebro report.
 *
 * A person the rail cannot resolve at all goes to {@link RAIL_NO_DEPARTMENT_KEY}.
 *
 * Returns a map from rail key → people, and never loses anyone: the summed sizes
 * always equal `roster.length` (pinned by test).
 */
export function assignRosterToRail<T extends RailRosterPerson>(
  roster: readonly T[],
  rail: readonly DeptRailGroup[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  const push = (key: string, person: T) => {
    const arr = out.get(key);
    if (arr) arr.push(person);
    else out.set(key, [person]);
  };

  // Children first so a sub-team always beats its parent, then parents, then the
  // sentinel. Order inside each tier follows the rail.
  const children: DeptRailEntry[] = [];
  const parents: DeptRailEntry[] = [];
  for (const g of rail) {
    parents.push(g.parent);
    for (const c of g.children) children.push(c);
  }

  for (const person of roster) {
    const cell = (person.department ?? '').trim();
    // A namespaced cell is only ever its own sub-team — never let the parent's
    // alias-map collapse claim it.
    const specific = children.find((c) => deptCellMatchesEntry(cell, c));
    if (specific) { push(specific.key, person); continue; }
    // A cell that names a SPECIFIC sub-team the rail doesn't carry (a retired or
    // mistyped `hsl:<key>`) must not fall through to the parent's collapse either —
    // it is unplaced, and saying so is the point.
    const parent = isHslSubDeptLabel(cell)
      ? undefined
      : parents.find((p) => deptCellMatchesEntry(cell, p));
    if (parent) { push(parent.key, person); continue; }
    push(RAIL_NO_DEPARTMENT_KEY, person);
  }
  return out;
}

/**
 * Counts shown on the rail: an entry's own count, and for a parent its own PLUS
 * every child's — otherwise a collapsed "Hogan Smith Law" reads 0 while hiding a
 * 186-person team.
 */
export function rollUpCounts(
  own: ReadonlyMap<string, number>,
  rail: readonly DeptRailGroup[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of rail) {
    let total = own.get(g.parent.key) ?? 0;
    for (const c of g.children) {
      const n = own.get(c.key) ?? 0;
      out.set(c.key, n);
      total += n;
    }
    out.set(g.parent.key, total);
  }
  return out;
}

/** Size of each rail bucket, for {@link rollUpCounts}. */
export function bucketSizes<T>(byKey: ReadonlyMap<string, T[]>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of byKey) out.set(k, v.length);
  return out;
}

/**
 * Which rail entry an employee-scope pay structure should RENDER under.
 *
 * Not `structure.departmentKey`. That is the key the row was filed under at save
 * time, and for an HSL person it is always the parent: `normalizeDeptToKey`
 * collapses every `hsl:*` cell to `hogan_smith_law`, and that is the function the
 * Search person card uses to pick its write key. Measured 2026-08-21: of the 124
 * individual structures filed on `hogan_smith_law`, **65 belong to people placed on
 * a real sub-team** — which is exactly what Kane saw ("Baldonebro ... she is a case
 * manager already").
 *
 * So the row follows the person's CURRENT placement. Display only — no DB write, no
 * `departmentKey` rewrite — which means it self-heals on every transfer instead of
 * needing a script re-run after each one.
 *
 * Two deliberate fallbacks, both so a row can never vanish:
 *  - person not on the roster (50 of those 124) → keep the stored key,
 *  - placement resolves to a key the rail cannot render → keep the stored key.
 * A stored key the rail also cannot render still shows: `individualForDept` is
 * compared against the selected entry, and the parent remains selectable.
 */
export function homeKeyForStructure(
  structure: PayStructure,
  placementByEmail: ReadonlyMap<string, string>,
  railKeys: ReadonlySet<string>,
): string {
  const em = (structure.employeeEmail ?? '').trim().toLowerCase();
  const placement = em ? placementByEmail.get(em) : undefined;
  if (!placement) return structure.departmentKey;
  const cell = placement.trim();
  // A namespaced cell IS its own key (`hsl:case_managers`), and that key wins —
  // never let the alias-map collapse to the parent decide the home.
  if (railKeys.has(cell)) return cell;
  const lower = cell.toLowerCase();
  if (railKeys.has(lower)) return lower;
  const mapped = normalizeDeptToKey(cell);
  if (mapped && railKeys.has(mapped)) return mapped;
  return structure.departmentKey;
}
