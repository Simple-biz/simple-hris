/**
 * The My Team department rail — the vertical department navigation that replaced
 * the old "Department" dropdown filter (Kane, 2026-09-14: "instead of a filter …
 * tabs arranged vertically on the left side where we can select Department rather
 * than showing everything in one page").
 *
 * The rail GEOMETRY is not reimplemented here. Parent/child folding, one-home
 * assignment and the "No department" bucket all come from
 * `src/lib/payment-catalog/dept-rail.ts`, so HSL discloses its sub-teams the way
 * Kane asked for on 2026-08-21 and a person can never be dropped off a list that
 * claims to name a department's members.
 *
 * What this module adds is the half My Team cannot borrow. The Payment Catalog
 * rail is driven by the pay-structure REGISTRY; My Team has no registry, so its
 * entries must be derived from the department cells the roster actually carries,
 * plus the departments the manager is granted but currently has nobody in (an
 * empty grant still deserves a tab — it is how a mis-scoped grant becomes
 * visible).
 *
 * One deliberate divergence from the catalog: a label that maps to NO payroll key
 * is still a real department to a manager. Measured 2026-09-14, that is 61 people
 * across USEE (26), Site Building US (20), Site Building PH (13), Orphan Ministry
 * and Manager. `normalizeDeptToKey` returns null for all of them, and the catalog
 * sweeps them into "No department" because it is asking a payroll question. The
 * manager is asking who is on my team, so each of those labels earns its own
 * entry and `RAIL_NO_DEPARTMENT_KEY` is left to catch a genuinely BLANK cell
 * (0 today — it exists so a future blank surfaces instead of vanishing).
 *
 * Pure — no I/O, no React — so every branch is exercised by node:test.
 */
import {
  buildDeptRail,
  assignRosterToRail,
  bucketSizes,
  rollUpCounts,
  parentOfDeptKey,
  RAIL_NO_DEPARTMENT_KEY,
  RAIL_NO_DEPARTMENT_NAME,
  HSL_PARENT_KEY,
  type DeptRailEntry,
  type DeptRailGroup,
  type RailAssignable,
} from '@/lib/payment-catalog/dept-rail';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { formatDeptLabel, HSL_FAMILY_DEPT_LABEL } from '@/lib/departments/hsl-subdept';

/** Slug fallback for a label `normalizeDeptToKey` does not recognise. Lowercased
 *  and punctuation-collapsed so "Site Building (US - Freelance)" is stable, and
 *  `@`-free so it can never collide with {@link RAIL_NO_DEPARTMENT_KEY}. */
export function slugifyRailKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The rail entry key a department CELL claims.
 *
 * A namespaced cell keeps its raw key so it lands on its own sub-team rather than
 * on the parent — `normalizeDeptToKey('hsl:intake_specialist')` is
 * `hogan_smith_law`, which is exactly the collapse the rail exists to undo.
 * Everything else prefers the payroll key (so "Accounting" and "Accounting Team"
 * are one entry) and falls back to a slug of its own label.
 *
 * Returns null for a blank cell — its people belong in the No-department bucket.
 */
export function railKeyForDeptCell(cell: string | null | undefined): string | null {
  const raw = (cell ?? '').trim();
  if (!raw) return null;
  if (raw.includes(':')) return raw.toLowerCase();
  const key = normalizeDeptToKey(raw);
  if (key) return key;
  return slugifyRailKey(raw) || null;
}

/** A rail built for one manager's roster. */
export interface TeamDeptRail<T> {
  /** Parents in headcount order, each with its sub-teams. */
  rail: DeptRailGroup[];
  /** Every person, in exactly one bucket. Sizes sum to `roster.length`. */
  byKey: Map<string, T[]>;
  /** What the rail PRINTS: a parent carries its own people plus its children's. */
  counts: Map<string, number>;
  /** The entry selected when nothing is chosen yet — the largest department. */
  defaultKey: string;
}

/**
 * Build the rail for a roster.
 *
 * Ordering is by headcount descending, on the ROLLED-UP count, so "Hogan Smith
 * Law" sorts on its 625 people rather than on the one person sitting on the bare
 * parent label. "No department" is pinned last whatever its size — it is a
 * fallback, not a team. `buildDeptRail` preserves the incoming order of parents
 * and of children within a parent, so sorting the entry list is enough.
 *
 * @param granted the manager's `department_managers` labels. A granted department
 *   with nobody in it still gets an entry (count 0) rather than disappearing.
 */
export function buildTeamDeptRail<T extends RailAssignable>(
  roster: readonly T[],
  granted: readonly string[] = [],
): TeamDeptRail<T> {
  // One entry per distinct key; the first label seen names it, and a cell that
  // normalises onto an existing key joins it rather than splitting the team.
  const byRailKey = new Map<string, DeptRailEntry>();
  const own = new Map<string, number>();
  const note = (cell: string, counted: boolean) => {
    const key = railKeyForDeptCell(cell);
    if (!key) return;
    if (!byRailKey.has(key)) {
      byRailKey.set(key, { key, name: formatDeptLabel(cell) || cell.trim() });
    }
    if (counted) own.set(key, (own.get(key) ?? 0) + 1);
  };
  for (const p of roster) note(p.department ?? '', true);
  for (const g of granted) note(g, false);

  // The HSL parent is SYNTHESISED whenever a sub-team is present. Without it
  // `buildDeptRail` promotes all 16 sub-teams to top level (a child whose parent
  // is absent is promoted, never dropped) — a flat list of 16 HSL rows, which is
  // the shape Kane asked us to fold away. Today exactly one person holds the bare
  // "HSL" label; the rail must not depend on that person staying.
  const hasHslChild = [...byRailKey.keys()].some((k) => parentOfDeptKey(k) === HSL_PARENT_KEY);
  if (hasHslChild && !byRailKey.has(HSL_PARENT_KEY)) {
    byRailKey.set(HSL_PARENT_KEY, {
      key: HSL_PARENT_KEY,
      name: formatDeptLabel(HSL_FAMILY_DEPT_LABEL) || HSL_FAMILY_DEPT_LABEL,
    });
  }

  const entries = [...byRailKey.values()];
  const parentKeys = new Set(entries.map((e) => e.key).filter((k) => !parentOfDeptKey(k)));
  // Roll up BEFORE ordering so a parent sorts on the family, not on its leftovers.
  const totalFor = (e: DeptRailEntry): number => {
    let n = own.get(e.key) ?? 0;
    for (const c of entries) {
      if (c.key !== e.key && parentOfDeptKey(c.key, parentKeys) === e.key) {
        n += own.get(c.key) ?? 0;
      }
    }
    return n;
  };
  const ordered = [...entries].sort(
    (a, b) => totalFor(b) - totalFor(a) || a.name.localeCompare(b.name),
  );

  // The sentinel is always present so `assignRosterToRail` has a home for an
  // unmatched cell, and always last.
  ordered.push({ key: RAIL_NO_DEPARTMENT_KEY, name: RAIL_NO_DEPARTMENT_NAME });

  const rail = buildDeptRail(ordered);
  const byKey = assignRosterToRail(roster, rail);
  const counts = rollUpCounts(bucketSizes(byKey), rail);

  // Drop the sentinel from the rail when nothing landed in it — an always-visible
  // "No department" reading 0 is noise. It returns the moment someone needs it.
  const visible =
    (byKey.get(RAIL_NO_DEPARTMENT_KEY)?.length ?? 0) > 0
      ? rail
      : rail.filter((g) => g.parent.key !== RAIL_NO_DEPARTMENT_KEY);

  return { rail: visible, byKey, counts, defaultKey: visible[0]?.parent.key ?? '' };
}

/**
 * The people shown when a rail entry is selected.
 *
 * Selecting a PARENT shows its whole family — its own people plus every
 * sub-team's — so the number on the rail and the length of the list below it are
 * the same number. `assignRosterToRail` files each person under their most
 * specific home, which is right for "whose team is this person on" and wrong for
 * "show me everyone under Hogan Smith Law": a manager clicking a row that reads
 * 625 must not be handed the 1 person left on the bare parent label.
 */
export function membersForRailKey<T>(
  key: string,
  rail: readonly DeptRailGroup[],
  byKey: ReadonlyMap<string, T[]>,
): T[] {
  const group = rail.find((g) => g.parent.key === key);
  const mine = byKey.get(key) ?? [];
  if (!group || group.children.length === 0) return [...mine];
  return [...mine, ...group.children.flatMap((c) => byKey.get(c.key) ?? [])];
}

/** Flatten the rail to `[parent, ...children]` in display order — the mobile
 *  picker's option list, and the order the snap-back guard scans. */
export function flattenRail(rail: readonly DeptRailGroup[]): DeptRailEntry[] {
  return rail.flatMap((g) => [g.parent, ...g.children]);
}
