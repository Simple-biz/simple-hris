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
import { normalizeNameTokens } from '@/lib/name/name-tokens';

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
 * list — {@link assignRosterToRail} and {@link railKeyForCell} are what resolve it to
 * one home, children before parents.
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
    // Children first: a namespaced cell is its own sub-team, and the parent's
    // alias-map collapse must never claim it.
    const specific = children.find((c) => deptCellMatchesEntry(cell, c));
    if (specific) { push(specific.key, person); continue; }
    // Then the parent. An HSL-family cell that matched no child lands here by
    // DESIGN — bare `HSL`, `Hogan Smith Law`, a retired key like
    // `hsl:lead_nurture`, a typo like `hsl:typo_team`: all of them are HSL people
    // with no resolvable sub-team, which is exactly what the parent bucket means.
    // (An earlier version excluded cells naming a known-but-absent sub-team; that
    // branch was unreachable, since the rail always carries all 16, and it made the
    // parent's meaning harder to state than it is.)
    const parent = parents.find((p) => p.key !== RAIL_NO_DEPARTMENT_KEY && deptCellMatchesEntry(cell, p));
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

/** Everything needed to find the human behind a pay-structure row. */
export interface StructureOwnerIndex {
  /** Placement by every email a roster person is known by (work, personal, alternates). */
  placementByEmail: ReadonlyMap<string, string>;
  /** Placement by `normalizeNameTokens` key, for rows keyed on an address the roster
   *  does not carry. **Ambiguous names are deliberately ABSENT** — see
   *  {@link buildStructureOwnerIndex}. */
  placementByNameKey: ReadonlyMap<string, string>;
  /** Every OTHER address the owner of `email` is known by, `email` included. Empty
   *  when the address belongs to nobody on the roster. Used by the "already has an
   *  override" guard, which must hold whichever alias a row happens to be keyed on. */
  aliasesFor(email: string): string[];
}

/**
 * Index the roster so a pay-structure row can find its owner.
 *
 * Email is the primary key. The NAME bridge exists because a structure can be keyed
 * on an address the roster row does not list at all: Baldonebro's stale
 * `joyb@simple.biz` row is a third identity, absent from the work/personal pair her
 * live `joy@hogansmith.com` row carries. Email matching alone leaves it unresolved,
 * and an unresolved row used to keep its stored key — which is how she kept showing
 * under Hogan Smith Law after being placed on Case Managers.
 *
 * **A name that maps to more than one distinct person is dropped, not guessed.** The
 * master list is full of namesakes, so an ambiguous name must resolve to nothing
 * rather than to the wrong department. Same reasoning as the bank-exemption name
 * fallback, which is likewise email-first.
 */
export function buildStructureOwnerIndex(
  roster: readonly { email: string; name: string; department: string; aliases: string[] }[],
): StructureOwnerIndex {
  const placementByEmail = new Map<string, string>();
  // key -> the single owning email, or null once a second distinct person claims it
  const nameOwner = new Map<string, string | null>();
  const nameDept = new Map<string, string>();

  for (const r of roster) {
    for (const em of [r.email, ...r.aliases]) {
      const k = (em ?? '').trim().toLowerCase();
      if (k && !placementByEmail.has(k)) placementByEmail.set(k, r.department);
    }
    const nk = normalizeNameTokens(r.name ?? '');
    if (!nk) continue;
    const seen = nameOwner.get(nk);
    if (seen === undefined) {
      nameOwner.set(nk, r.email);
      nameDept.set(nk, r.department);
    } else if (seen !== null && seen !== r.email) {
      nameOwner.set(nk, null); // ambiguous — a namesake, so trust neither
    }
  }
  const placementByNameKey = new Map<string, string>();
  for (const [nk, owner] of nameOwner) {
    if (owner !== null) placementByNameKey.set(nk, nameDept.get(nk)!);
  }
  const aliasGroups = new Map<string, string[]>();
  for (const r of roster) {
    const group = [...new Set([r.email, ...r.aliases].map((e) => (e ?? '').trim().toLowerCase()).filter(Boolean))];
    for (const em of group) if (!aliasGroups.has(em)) aliasGroups.set(em, group);
  }
  return {
    placementByEmail,
    placementByNameKey,
    aliasesFor: (email: string) => aliasGroups.get((email ?? '').trim().toLowerCase()) ?? [],
  };
}

/**
 * Which rail entry an employee-scope pay structure should RENDER under.
 *
 * **The row follows the PERSON, always.** Not `structure.departmentKey` — that is the
 * key the row was filed under at save time, and for an HSL person it is always the
 * parent, because `normalizeDeptToKey` collapses every `hsl:*` cell to
 * `hogan_smith_law` and that is the function the Search person card uses to pick its
 * write key. Measured 2026-08-21: of the 124 individual structures filed on
 * `hogan_smith_law`, 65 belonged to people placed on a real sub-team.
 *
 * Resolution order, and each step exists because the previous one missed a live case:
 *  1. the structure's own email → placement,
 *  2. the owner's NAME → placement, for a row keyed on an address the roster row does
 *     not list (Kane, twice: *"Baldonebro ... is already a case manager"*),
 *  3. no owner anywhere → **"No department"**, never the stored key. A department is a
 *     claim about a real person; parking an unresolvable ghost on Hogan Smith Law is
 *     exactly the false statement being complained about. Nothing vanishes — the
 *     "No department" entry is on the rail precisely so it cannot.
 *
 * A resolvable owner whose placement the rail cannot render (USEE, Site Building
 * freelancers) also lands in "No department", which is where the PERSON is listed —
 * so a row and its owner are never in different places.
 *
 * Display only: `onUpsert` still files under `selectedDept`, so this self-heals on
 * every transfer instead of needing a script re-run. No money is affected —
 * `buildCatalogRateIndex` keys employee structures `byEmail` and never reads
 * `departmentKey` (`resolve-rate.ts:70-80`, `:119`).
 */
export function homeKeyForStructure(
  structure: PayStructure,
  owners: StructureOwnerIndex,
  rail: readonly DeptRailGroup[],
): string {
  const em = (structure.employeeEmail ?? '').trim().toLowerCase();
  const byEmail = em ? owners.placementByEmail.get(em) : undefined;
  const nk = normalizeNameTokens(structure.employeeName ?? '');
  const placement = byEmail ?? (nk ? owners.placementByNameKey.get(nk) : undefined);
  if (placement === undefined) return RAIL_NO_DEPARTMENT_KEY;
  // Resolve the cell with the rail's OWN matcher, most-specific first — the same
  // call `assignRosterToRail` makes. A second, weaker chain (key/lowercase/alias-map)
  // could not see a CUSTOM department, whose entry matches only by display NAME, so
  // every in-app-department person's override row was exiled to "No department".
  return railKeyForCell(placement, rail);
}

/**
 * The rail entry a raw department CELL belongs to, most-specific first, or
 * {@link RAIL_NO_DEPARTMENT_KEY}. The single definition of "where does this cell
 * live", shared by member assignment and structure re-homing so a person and their
 * own rate row can never land in different places.
 */
export function railKeyForCell(cell: string, rail: readonly DeptRailGroup[]): string {
  const raw = (cell ?? '').trim();
  if (!raw) return RAIL_NO_DEPARTMENT_KEY;
  for (const g of rail) {
    for (const c of g.children) if (deptCellMatchesEntry(raw, c)) return c.key;
  }
  for (const g of rail) {
    if (g.parent.key === RAIL_NO_DEPARTMENT_KEY) continue;
    if (deptCellMatchesEntry(raw, g.parent)) return g.parent.key;
  }
  return RAIL_NO_DEPARTMENT_KEY;
}
