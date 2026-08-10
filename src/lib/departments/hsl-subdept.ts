// HSL sub-department identity helpers.
//
// ONE canonical label unifies the three HSL keyspaces: the master-list
// Department cell `hsl:<HslDeptKey>` (same string as the department_managers
// access grant). These helpers are the single place that knows:
//   - which raw strings name a SPECIFIC sub-team vs the HSL family,
//   - how to display them ("HSL — Intake Specialist", never the raw key),
//   - how transfer/sheet matching treats them: family-aware on the SOURCE
//     side (an `hsl:*` cell is an "HSL" row when moving someone out), but
//     EXACT on a sub-team TARGET (sub-team identity is the whole point).
// Client-safe: constants + pure functions only.

import { HSL_DEPT_KEYS, HSL_DEPTS, type HslDeptKey } from '@/lib/hsl-bonus/schema';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

/** Canonical master-list Department label for an HSL sub-department. */
export function hslSubDeptLabel(key: HslDeptKey): string {
  return `hsl:${key}`;
}

/** The HslDeptKey inside a raw `hsl:*` label, or null when the label is not a
 *  known sub-team (plain "HSL", unknown key, non-HSL label). */
export function hslSubKeyFromRaw(raw: string | null | undefined): HslDeptKey | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s.startsWith('hsl:')) return null;
  const key = s.slice(4);
  return (HSL_DEPT_KEYS as readonly string[]).includes(key) ? (key as HslDeptKey) : null;
}

/** True when `raw` names a SPECIFIC HSL sub-team (not just the family). */
export function isHslSubDeptLabel(raw: string | null | undefined): boolean {
  return hslSubKeyFromRaw(raw) !== null;
}

/**
 * True for ANY label in the HSL family: 'HSL', 'hsl', 'Hogan Smith Law',
 * 'hogan_smith_law', and every `hsl:<sub>` cell — including a sub-key this
 * build doesn't recognize, because `normalizeDeptToKey` collapses the whole
 * `hsl:` prefix and a typo must not drop someone out of the HSL cohort.
 *
 * Use this instead of `dept.toLowerCase() === 'hsl'`. That exact comparison is
 * how the 70 sub-labeled people silently fell out of the HSL week model
 * (Mon–Sun weeks, +₱15/h weekend premium day-scoping, overnight combination)
 * on every surface that hadn't gone through `normalizeDeptToKey`.
 */
export function isHslFamilyLabel(raw: string | null | undefined): boolean {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return false;
  // Callers pass a mix of raw master labels AND already-normalized payroll keys
  // (the wizard's employeeDepts map holds keys). normalizeDeptToKey has no entry
  // for its own output, so check that form explicitly — the omission is what
  // made PayrollWizard.tsx:7773 need a two-clause guard.
  if (s === 'hogan_smith_law') return true;
  return normalizeDeptToKey(s) === 'hogan_smith_law';
}

/** Display label: `hsl:intake_specialist` → "HSL — Intake Specialist".
 *  Every other label passes through trimmed. */
export function formatDeptLabel(raw: string | null | undefined): string {
  const sub = hslSubKeyFromRaw(raw);
  if (sub) return `HSL — ${HSL_DEPTS[sub].name}`;
  const s = (raw ?? '').trim();
  // Unknown `hsl:*` sub-key: still never show the bare slug to a human.
  if (s.toLowerCase().startsWith('hsl:')) return `HSL — ${s.slice(4)}`;
  return s;
}

/** Family key for comparison: payroll synonym map first, raw lowercased label
 *  for departments the map doesn't know (mirrors stale-transfers deptMatchKey). */
function familyKey(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  return normalizeDeptToKey(trimmed) ?? trimmed.toLowerCase();
}

/** SOURCE matching for transfers / sheet write-backs: does this Department
 *  cell count as a row in `fromRaw`? Family-aware — `hsl:intake_specialist`
 *  matches a move out of "HSL" and vice versa; "Callbacks" matches
 *  "Callback Team". */
export function deptCellMatchesSource(
  cellRaw: string | null | undefined,
  fromRaw: string | null | undefined,
): boolean {
  const cell = (cellRaw ?? '').trim().toLowerCase();
  const from = (fromRaw ?? '').trim().toLowerCase();
  if (!from || !cell) return false;
  if (cell === from) return true;
  const fk = familyKey(from);
  return !!fk && familyKey(cell) === fk;
}

/** TARGET satisfaction: is this Department cell already the requested target?
 *  A sub-team target demands the EXACT cell (a plain "HSL" cell still needs
 *  the relabel). A non-sub target keeps family semantics — notably, an
 *  `hsl:*` cell already satisfies a plain-"HSL" target, so a generic
 *  into-HSL transfer never clobbers an existing sub-team assignment. */
export function deptCellSatisfiesTarget(
  cellRaw: string | null | undefined,
  toRaw: string | null | undefined,
): boolean {
  const cell = (cellRaw ?? '').trim().toLowerCase();
  const to = (toRaw ?? '').trim().toLowerCase();
  if (!to || !cell) return false;
  if (cell === to) return true;
  if (isHslSubDeptLabel(to)) return false;
  const tk = familyKey(to);
  return !!tk && familyKey(cell) === tk;
}
