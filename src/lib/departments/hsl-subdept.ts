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

/**
 * The ONE department label that stands for the whole HSL family in every
 * picker and filter (Kane 2026-08-10: "We need to only have 1 department for
 * HSL"). Sub-team identity is a SEPARATE selection that composes onto it via
 * `hslSubDeptLabel`, never a second department in its own right.
 *
 * Deliberately the plain roster label, not "Hogan Smith Law": 528 of the 598
 * active HSL-family master rows already read exactly this.
 */
export const HSL_FAMILY_DEPT_LABEL = 'HSL';

// ── Two sub-team keyspaces, deliberately separate ────────────────────────────
//
// `HSL_DEPT_KEYS` (src/lib/hsl-bonus/schema.ts) answers "does this sub-team have
// its OWN KPI calculator?". It is NOT the same question as "can I place someone
// here?", and conflating the two is what this split fixes.
//
// Kane relaying Carla, 2026-08-12: *"Successfully Transferred Calls - 50 each /
// Sign ups from Transferred Calls - 250 each. We calculate it under the callback
// team bonus on HSL. Callback and Simpletexting have the same bonus, so they are
// calculated under one calculator."*
//
// So Simple Texting is a real HSL team — placeable, priceable, transferable —
// whose bonuses are scored inside the Callback Team calculator.
// Adding it to HSL_DEPT_KEYS would have given it:
//   - its own KPI Calculator card (HslBonusCalculator) — the duplicate calculator
//     Carla explicitly does NOT want, and exactly what `simple_texting`'s
//     2026-08-04 removal deleted. That removal STANDS;
//   - a permanent `draft` row in Payroll Readiness → KPI Submissions:
//     payroll-readiness.ts:571 iterates every HSL_DEPT_KEYS with no grant filter
//     and no roster filter, and its HSL branch has no zero-roster `no_bonus`
//     downgrade (that exists only for custom depts, :550). A dept with nobody in
//     it counts in `kpiDue` and never in `kpiSubmitted`, so it would hold the
//     25%-weight KPI dimension — and the readiness score — under 100 every week,
//     forever, until a manager marked an empty department "ready".
//
// Nothing here reaches a KPI surface: every KPI consumer (HslBonusCalculator,
// AdminRoles, use-bonus-scoring-queue, ManagerBonusHistory, payroll-readiness,
// PayrollWizard, employee-kpi-results, Overview) reads HSL_DEPT_KEYS / HSL_DEPTS
// directly and never routes through this module.

/** Ordered placement-only sub-team keys. Add one here + an entry below (the same
 *  two-edit shape as HSL_DEPT_KEYS + HSL_DEPTS); retire one by removing both (§7c).
 *
 *  RETIRED — do not re-add without asking Carla first:
 *    `lead_nurture` shipped 2026-08-12 and was withdrawn 2026-08-13. Carla and CJ
 *    settled that it named the SAME team as Simple Texting and collided with
 *    Lucky's separate Lead Nurture team; CJ: *"We can use HSL – SimpleTexting to
 *    avoid any confusion with Lucky's Lead Nurture Team."* Kane: *"we need to
 *    remove the other one."* Nobody was ever placed in it (0 master cells, 0
 *    rates rows, 0 grants, 0 roster rows), so the withdrawal repriced nobody.
 *    `hsl-subdept.test.ts` pins it absent so it cannot drift back in. */
export const HSL_PLACEMENT_ONLY_SUB_KEYS = ['simple_texting', 'hearing_prep_mail_sorting'] as const;

export type HslPlacementOnlySubKey = (typeof HSL_PLACEMENT_ONLY_SUB_KEYS)[number];

/**
 * Sub-teams you can place into but that have no calculator of their own.
 * `scoredUnder` is typed `HslDeptKey`, so the calculator that actually scores
 * them cannot be renamed or retired without a compile error here — the pointer
 * can never rot into a dangling string.
 */
export const HSL_PLACEMENT_ONLY_SUB_TEAMS: Record<
  HslPlacementOnlySubKey,
  { readonly name: string; readonly scoredUnder: HslDeptKey }
> = {
  simple_texting: { name: 'Simple Texting', scoredUnder: 'callback_team' },
  // Kane, 2026-08-14. All 3 live members already sit on the Pre-/Post-Hearing
  // Prep roster (hsl_team_members.dept_key='post_hearing_prep', role_raw
  // "Hearing Prep Team-Mail Sorting"), so scoredUnder mirrors how they are
  // scored today — the Simple Texting pattern, not a new calculator.
  hearing_prep_mail_sorting: {
    name: 'Hearing Prep Team – Mail Sorting',
    scoredUnder: 'post_hearing_prep',
  },
};

/** Every sub-team key that may legitimately appear in a master `Department`
 *  cell — the KPI-scoring teams plus the placement-only ones. */
export type HslSubTeamKey = HslDeptKey | HslPlacementOnlySubKey;

/** Does this key name a sub-team with its OWN KPI calculator? */
export function isHslKpiDeptKey(key: string): key is HslDeptKey {
  return (HSL_DEPT_KEYS as readonly string[]).includes(key);
}

/** Does this key name a placement-only sub-team (scored under another one)? */
export function isHslPlacementOnlySubKey(key: string): key is HslPlacementOnlySubKey {
  return (HSL_PLACEMENT_ONLY_SUB_KEYS as readonly string[]).includes(key);
}

/** Display name for any sub-team key, from whichever keyspace owns it. */
export function hslSubTeamName(key: HslSubTeamKey): string {
  return isHslPlacementOnlySubKey(key)
    ? HSL_PLACEMENT_ONLY_SUB_TEAMS[key].name
    : HSL_DEPTS[key].name;
}

/** Canonical master-list Department label for an HSL sub-department. */
export function hslSubDeptLabel(key: HslSubTeamKey): string {
  return `hsl:${key}`;
}

/** The sub-team key inside a raw `hsl:*` label, or null when the label is not a
 *  known sub-team (plain "HSL", unknown key, non-HSL label). Covers BOTH
 *  keyspaces: a placement-only team is every bit as real a placement as a
 *  KPI-scoring one, and callers that mean "has a calculator" must ask
 *  `isHslKpiDeptKey`, not this. */
export function hslSubKeyFromRaw(raw: string | null | undefined): HslSubTeamKey | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s.startsWith('hsl:')) return null;
  const key = s.slice(4);
  if (isHslKpiDeptKey(key)) return key;
  if (isHslPlacementOnlySubKey(key)) return key;
  return null;
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
  if (sub) return `HSL — ${hslSubTeamName(sub)}`;
  const s = (raw ?? '').trim();
  // Unknown `hsl:*` sub-key: still never show the bare slug to a human.
  if (s.toLowerCase().startsWith('hsl:')) return `HSL — ${s.slice(4)}`;
  return s;
}

/**
 * Collapse any HSL-family label to the single family label; every other label
 * passes through trimmed and unchanged.
 *
 * This is what keeps department PICKERS and FILTERS at one "HSL" entry while
 * the master Department cell keeps holding `hsl:<key>`. Use it on the option
 * list only — never on the value written to the cell, and never inside a
 * master-sheet sync path (those mirror the sheet verbatim, per
 * docs/features/sales-dept-split.md).
 */
export function collapseHslFamilyLabel(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  return isHslFamilyLabel(s) ? HSL_FAMILY_DEPT_LABEL : s;
}

/**
 * Is this department value ready to be written to a master-list `Department`
 * cell as a NEW placement? Non-empty, and — inside the HSL family — an exact
 * `hsl:<key>` sub-team.
 *
 * The bare family label "HSL" is deliberately NOT placeable: the sub-team is
 * what carries the base rate, so accepting a bare "HSL" would put a new hire on
 * the parent fallback with nobody having chosen it. Existing plain-"HSL" rows
 * are untouched by this — it gates new writes only, never reads.
 *
 * Placement-only sub-teams pass. Having no calculator of their own says nothing
 * about whether someone can WORK there, and `resolveDeptCatalogRate` prices them
 * exactly like any other sub-team (own `hsl:<key>` rate first, parent as the
 * permanent fallback) — so a placement here can never resolve ₱0.
 */
export function isPlaceableDeptLabel(raw: string | null | undefined): boolean {
  const s = (raw ?? '').trim();
  if (!s) return false;
  return isHslFamilyLabel(s) ? isHslSubDeptLabel(s) : true;
}

/** One `{value,label}` per HSL sub-team — BOTH keyspaces, because every one of
 *  them is a place a person can actually sit. Single definition so the onboarding
 *  picker, the transfer dialog, the Pay Structure rail and the catalog export can
 *  never drift on which teams exist or how they read.
 *
 *  Placement-only teams come last, after the KPI-scoring ones, so the existing
 *  order (and anyone's muscle memory for it) is undisturbed. */
export function hslSubDeptOptions(): Array<{ value: string; label: string }> {
  const keys: readonly HslSubTeamKey[] = [...HSL_DEPT_KEYS, ...HSL_PLACEMENT_ONLY_SUB_KEYS];
  return keys.map((key) => ({
    value: hslSubDeptLabel(key),
    label: formatDeptLabel(hslSubDeptLabel(key)),
  }));
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
