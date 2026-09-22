// Sub-team-targeted bonus assignments (Kane, 2026-09-21: "there is no way to
// view all subdepartments underneath Assignments").
//
// A department-scoped assignment's `departmentKey` may now be a built-in
// SUB-TEAM key (`lead_gen:nurture`). The KPI calculator draws its card per
// PARENT department (`normalizeDeptToKey` collapses the key), so the only new
// question is per member: does this bonus reach THIS person?
//
//   - bare parent key      -> everyone on the card (unchanged behaviour)
//   - namespaced sub-team  -> only members whose raw master cell IS that
//                             sub-team; a member with no known cell (a
//                             manager-added external) never qualifies
//
// This is additive, not most-specific-wins: a Nurture person receives Lead
// Gen's bonuses AND Nurture's. That is the semantics Kane described ("applies
// to Intake only") and it is what inheritance already did for the parent.
//
// Applied rows keep the PARENT key (`saveDept` writes `department: deptKey`),
// so the wizard's payable set is untouched and the double-pay guard in
// bonus-catalog.md §3.1 ("namespaced is the vector") still holds: a namespaced
// key never reaches `bonus_catalog_applied`.
//
// CLIENT-SAFE: pure functions only.

import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { HSL_BUILTIN_KEY } from '@/lib/departments/registry';

/** The parent card an assignment lands on — the same collapse every consumer
 *  (`commonByDept`, the scoring queue, readiness) already performs. */
export function assignmentParentKey(departmentKey: string): string {
  const k = (departmentKey ?? '').trim();
  return normalizeDeptToKey(k) ?? k;
}

/**
 * The raw master cell a SUB-TEAM assignment is restricted to, lower-cased, or
 * null when the assignment is department-wide.
 *
 * Only a namespaced key whose prefix is a REAL department counts: an in-app
 * registry sub (`executive_assistants:x`) normalizes to null and stays
 * department-wide, exactly as before this change.
 */
export function assignmentScopeCell(departmentKey: string): string | null {
  const k = (departmentKey ?? '').trim();
  if (!k.includes(':')) return null;
  if (normalizeDeptToKey(k) === null) return null;
  return k.toLowerCase();
}

/** Does an assignment restricted to `scopeCell` (null = whole department)
 *  reach a member whose raw master cell is `memberCell`? */
export function assignmentReachesMember(
  scopeCell: string | null,
  memberCell: string | null | undefined,
): boolean {
  if (!scopeCell) return true;
  const cell = (memberCell ?? '').trim().toLowerCase();
  return cell !== '' && cell === scopeCell;
}

/**
 * bonusId -> the sub-team cells it is restricted to, for ONE parent card.
 *
 * A bonus assigned to a sub-team AND to the bare parent is department-wide:
 * the bare assignment already reaches everyone, so the restriction is moot and
 * is dropped rather than left to fight the wider one. Absent from the map =
 * unrestricted.
 */
export function buildCommonScopeIndex(
  assignments: readonly { scope: string; departmentKey: string; bonusId: string }[],
): Map<string, Map<string, Set<string>>> {
  const scoped = new Map<string, Map<string, Set<string>>>();
  const wide = new Map<string, Set<string>>(); // parent -> bonusIds assigned bare
  for (const a of assignments) {
    if (a.scope !== 'department') continue;
    const parent = assignmentParentKey(a.departmentKey);
    const cell = assignmentScopeCell(a.departmentKey);
    if (!cell) {
      const w = wide.get(parent) ?? new Set<string>();
      w.add(a.bonusId);
      wide.set(parent, w);
      continue;
    }
    const byBonus = scoped.get(parent) ?? new Map<string, Set<string>>();
    const cells = byBonus.get(a.bonusId) ?? new Set<string>();
    cells.add(cell);
    byBonus.set(a.bonusId, cells);
    scoped.set(parent, byBonus);
  }
  for (const [parent, byBonus] of scoped) {
    const w = wide.get(parent);
    if (!w) continue;
    for (const bonusId of w) byBonus.delete(bonusId);
    if (byBonus.size === 0) scoped.delete(parent);
  }
  return scoped;
}

/**
 * A target the Assignments tab must NOT offer because nothing would ever draw or
 * pay it: an HSL sub-team. HSL bonuses are code rules in `hsl-bonus/schema.ts`,
 * the HSL calculator never reads the catalog, and the wizard excludes the HSL
 * family from the catalog's payable set on purpose (bonus-catalog.md §3.1;
 * audit item 139). Offering the target would be offering a lie.
 */
export function isDeadBonusTargetKey(departmentKey: string): boolean {
  const k = (departmentKey ?? '').trim();
  return k.includes(':') && normalizeDeptToKey(k) === HSL_BUILTIN_KEY;
}
