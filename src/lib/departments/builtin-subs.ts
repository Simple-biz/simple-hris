// Sub-departments on a MASTER-LIST (built-in) department. Kane, 2026-09-21:
// "I want us to make sure that if we edit these departments we can add sub
// departments in it!" -- and, on seeing HSL locked: "LET US REFACTOR this for
// HSL if needed".
//
// Until now only HSL had sub-teams, hard-coded as HSL_DEPT_KEYS. This makes them
// DATA for every built-in, stored as one JSON blob in `app_settings` --
// deliberately no new table, exactly like the in-app department registry.
//
// KEY CONVENTION: `<builtinKey>:<subKey>` (e.g. `lead_gen:nurture`) -- the same
// namespacing `subDeptStructureKey` uses for in-app departments, and what
// `parentOfDeptKey` (dept-rail.ts) and `resolveDeptCatalogRate`
// (resolve-rate.ts) already resolve generically.
//
// HSL IS THE ONE EXCEPTION TO THE CONVENTION, NOT TO THE FEATURE. Its data
// sub-teams are labelled `hsl:<subKey>`, never `hogan_smith_law:<subKey>`,
// because `normalizeDeptToKey`'s `hsl:` branch is what keeps a cell inside the
// HSL family -- the Mon-Sun week model, the +P15/h weekend premium and
// dept-scoped bonus matching all hang off it (hsl-subdepartments.md s11). The
// 16 CODE sub-teams (HSL_DEPT_KEYS + the placement-only ones) are PINNED: they
// show in the editor but cannot be renamed or removed here, because 14 of them
// carry a KPI calculator and a Payroll Readiness row. A DATA sub-team added to
// HSL is exactly what Simple Texting already is: a real team people sit in,
// with its own base rate, that has no calculator of its own.

import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { HSL_BUILTIN_KEY, slugifyDeptKey, subDeptStructureKey, type DepartmentSubUnit } from './registry';
import { HSL_DEPT_KEYS } from '@/lib/hsl-bonus/schema';
import {
  HSL_PLACEMENT_ONLY_SUB_KEYS,
  hslSubDeptLabel,
  hslSubDeptOptions,
  hslSubTeamName,
  type HslSubTeamKey,
} from './hsl-subdept';

/** app_settings key holding the JSON map. */
export const BUILTIN_SUBS_SETTING_KEY = 'payment_catalog.departments.builtin_subs';

/** builtinKey -> its sub-departments, in display order. */
export type BuiltinSubMap = Record<string, DepartmentSubUnit[]>;

export const MAX_BUILTIN_SUBS = 24;

/** Can this built-in department carry DATA sub-departments? Every built-in
 *  can, HSL included since Kane's 2026-09-21 refactor call. */
export function supportsDataSubDepartments(key: string): boolean {
  return DEPARTMENTS.some((d) => d.key === key);
}

/**
 * Sub-teams that exist in CODE and are therefore PINNED in the editor: shown,
 * never renamed or removed here. Only HSL has any -- its 14 KPI-scoring teams
 * plus the 2 placement-only ones.
 */
export function pinnedSubDepartments(key: string): DepartmentSubUnit[] {
  if (key !== HSL_BUILTIN_KEY) return [];
  const keys: readonly HslSubTeamKey[] = [...HSL_DEPT_KEYS, ...HSL_PLACEMENT_ONLY_SUB_KEYS];
  return keys.map((k) => ({ key: k, name: hslSubTeamName(k) }));
}

/**
 * `lead_nurture` shipped 2026-08-12 and was withdrawn 2026-08-13: Carla and CJ
 * settled it named the SAME team as Simple Texting and collided with Lucky's
 * separate Lead Nurture team. `hsl-subdept.test.ts` pins it absent from code;
 * this pins it absent from DATA too, so an accountant cannot quietly bring it
 * back through the editor. Ask Carla first.
 */
const RETIRED_HSL_SUB_KEYS: ReadonlySet<string> = new Set(['lead_nurture']);

/** The sub-departments stored for a built-in (never undefined). */
export function builtinSubsFor(map: BuiltinSubMap | null | undefined, key: string): DepartmentSubUnit[] {
  return map?.[key] ?? [];
}

/**
 * The master-cell / rate-row label for one sub: `<builtinKey>:<subKey>` -- except
 * HSL, whose cells and rate rows are `hsl:<subKey>` (see the header). Using the
 * generic form for HSL would drop the person out of the HSL family.
 */
export function builtinSubLabel(parentKey: string, subKey: string): string {
  if (parentKey === HSL_BUILTIN_KEY) return hslSubDeptLabel(subKey as HslSubTeamKey);
  return subDeptStructureKey(parentKey, subKey);
}

/** `{value,label}` per sub-department of one built-in, for pickers and rails. */
export function builtinSubOptions(
  map: BuiltinSubMap | null | undefined,
  key: string,
): Array<{ value: string; label: string }> {
  const parent = DEPARTMENTS.find((d) => d.key === key);
  if (!parent) return [];
  // HSL reads "HSL — <team>" everywhere (hslSubDeptOptions), not "Hogan Smith
  // Law — <team>"; a data team must sit beside the code ones indistinguishably.
  const parentLabel = key === HSL_BUILTIN_KEY ? 'HSL' : parent.name;
  return builtinSubsFor(map, key).map((s) => ({
    value: builtinSubLabel(key, s.key),
    label: `${parentLabel} — ${s.name}`,
  }));
}

/** Code AND data sub-teams of one built-in, as picker options. For HSL that is
 *  the 16 code teams followed by the data ones; for everyone else just data. */
export function builtinSubOptionsWithPinned(
  map: BuiltinSubMap | null | undefined,
  key: string,
): Array<{ value: string; label: string }> {
  const pinned = key === HSL_BUILTIN_KEY ? hslSubDeptOptions() : [];
  return [...pinned, ...builtinSubOptions(map, key)];
}

/** Every built-in DATA sub across every department — the rail / options feed.
 *  HSL's code teams are NOT here; callers already list `hslSubDeptOptions()`. */
export function allBuiltinSubOptions(
  map: BuiltinSubMap | null | undefined,
): Array<{ value: string; label: string }> {
  return DEPARTMENTS.flatMap((d) => builtinSubOptions(map, d.key));
}

/**
 * `{key,name}[]` a person could be placed into, keyed by PARENT KEY — the shape
 * `isPlaceableDeptLabel` takes so it can tell "this department has sub-teams, so
 * a bare parent label is not a placement" without importing this module.
 */
export function placeableSubIndex(map: BuiltinSubMap | null | undefined): Record<string, DepartmentSubUnit[]> {
  const out: Record<string, DepartmentSubUnit[]> = {};
  for (const d of DEPARTMENTS) {
    const subs = builtinSubsFor(map, d.key);
    if (subs.length > 0) out[d.key] = subs;
  }
  return out;
}

/**
 * Is this rail key a BUILT-IN department's sub-team (`lead_gen:nurture`,
 * `hsl:spanish_intake`) rather than a department or an in-app registry entry?
 *
 * Exists for ONE reason: these keys must stay OUT of the Bonus Assignments and
 * System Bonuses target pickers. `bonus-catalog.md` "Bare vs namespaced is
 * load-bearing": the payable set holds UNNAMESPACED slugs, and the KPI
 * calculator resolves an assignment by `normalizeDeptToKey(a.departmentKey)`
 * -- so a bonus assigned to `lead_gen:nurture` silently applies to ALL of Lead
 * Gen, and a namespaced key in a PAB/Tech allowlist never matches anyone. The
 * Pay Structure rail DOES want them (that is where a sub-team's base rate is
 * set), which is why this is a filter at two call sites and not an omission
 * from `customDepartments`.
 *
 * Sub-team-targeted bonuses are a real feature request, not a bug to hide: the
 * fix is a most-specific-first resolver in the calculator, after which this
 * filter comes out. Until then, offering the target is offering a lie.
 */
export function isBuiltinSubTeamKey(key: string): boolean {
  const k = (key ?? '').trim();
  if (!k.includes(':')) return false;
  return normalizeDeptToKey(k) !== null;
}

export interface BuiltinSubsInput {
  builtinKey: string;
  /** The FULL resulting sub-department list; the server diffs it. */
  subDepartments: DepartmentSubUnit[];
}

/** Mirrored client-side (Save gating) and server-side (PATCH). */
export function validateBuiltinSubsInput(input: BuiltinSubsInput): { ok: boolean; error?: string } {
  const key = input.builtinKey?.trim() ?? '';
  if (!DEPARTMENTS.some((d) => d.key === key)) {
    return { ok: false, error: 'That is not a built-in department.' };
  }
  if (!Array.isArray(input.subDepartments)) return { ok: false, error: 'Malformed sub-department payload.' };
  // The payload is the DATA list only. A data key that shadows a code team
  // would silently redirect that team's cells and rate row; a retired one
  // would resurrect a decision Carla already made.
  const pinned = new Set(pinnedSubDepartments(key).map((p) => p.key));
  if (input.subDepartments.length > MAX_BUILTIN_SUBS) {
    return { ok: false, error: `Keep it to ${MAX_BUILTIN_SUBS} sub-departments or fewer.` };
  }
  const seen = new Set<string>();
  for (const s of input.subDepartments) {
    const name = s.name?.trim() ?? '';
    if (!name) return { ok: false, error: 'Every sub-department needs a name.' };
    if (name.length > 60) return { ok: false, error: `"${name}" is too long (60 characters max).` };
    const subKey = (s.key?.trim() || slugifyDeptKey(name)).toLowerCase();
    if (!subKey) return { ok: false, error: `"${name}" does not make a usable key.` };
    // A colon in the sub key would produce `<parent>:<a>:<b>`, which
    // `parentOfDeptKey` splits at the FIRST colon — the rate row and the rail
    // would disagree about who the parent is.
    if (subKey.includes(':')) return { ok: false, error: `"${name}" cannot contain a colon.` };
    if (pinned.has(subKey)) {
      return { ok: false, error: `"${name}" is already an HSL team defined in code — it is listed above.` };
    }
    if (key === HSL_BUILTIN_KEY && RETIRED_HSL_SUB_KEYS.has(subKey)) {
      return {
        ok: false,
        error: `"${name}" was retired on 2026-08-13 (it named the same team as Simple Texting). Ask Carla before bringing it back.`,
      };
    }
    if (seen.has(subKey)) return { ok: false, error: `Two sub-departments resolve to "${subKey}".` };
    seen.add(subKey);
  }
  return { ok: true };
}

export interface BuiltinSubsDiff {
  added: DepartmentSubUnit[];
  removed: DepartmentSubUnit[];
  renamed: Array<{ key: string; from: string; to: string }>;
  changed: boolean;
}

/**
 * An existing sub's KEY IS PINNED — a rename changes the label only, so its
 * `<parent>:<sub>` rate row and every master cell pointing at it stay attached.
 * Same rule as the in-app registry (§6.2); breaking it would strand both.
 */
export function diffBuiltinSubs(
  current: readonly DepartmentSubUnit[],
  next: readonly DepartmentSubUnit[],
): BuiltinSubsDiff {
  const curByKey = new Map(current.map((s) => [s.key, s] as const));
  const nextByKey = new Map(next.map((s) => [s.key, s] as const));

  const added = next.filter((s) => !curByKey.has(s.key));
  const removed = current.filter((s) => !nextByKey.has(s.key));
  const renamed: Array<{ key: string; from: string; to: string }> = [];
  for (const [key, s] of nextByKey) {
    const before = curByKey.get(key);
    if (before && before.name !== s.name) renamed.push({ key, from: before.name, to: s.name });
  }
  return {
    added,
    removed,
    renamed,
    changed: added.length > 0 || removed.length > 0 || renamed.length > 0,
  };
}

/**
 * Sub-departments that still hold people, by sub key — a removal is REFUSED
 * while anyone points at it, exactly as the registry refuses one (§6.2).
 * Dropping the sub would leave their master cell resolving to a team that no
 * longer exists, which `isPlaceableDeptLabel` then refuses to re-place.
 */
export function builtinSubOccupancy(
  parentKey: string,
  rosterDeptCells: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  // `builtinSubLabel` with an empty sub yields exactly the prefix -- `hsl:` for
  // HSL, `<key>:` for everyone else -- so the count reads the same cells the
  // placement writes.
  const prefix = builtinSubLabel(parentKey, '').toLowerCase();
  for (const raw of rosterDeptCells) {
    const cell = (raw ?? '').trim().toLowerCase();
    if (!cell.startsWith(prefix)) continue;
    const sub = cell.slice(prefix.length);
    if (!sub) continue;
    out.set(sub, (out.get(sub) ?? 0) + 1);
  }
  return out;
}
