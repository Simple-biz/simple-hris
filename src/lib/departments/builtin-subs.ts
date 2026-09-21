// Sub-departments on a MASTER-LIST (built-in) department. Kane, 2026-09-21:
// "I want us to make sure that if we edit these departments we can add sub
// departments in it!"
//
// Until now only HSL had sub-teams, hard-coded as HSL_DEPT_KEYS. This makes them
// DATA for every other built-in, stored as one JSON blob in `app_settings` —
// deliberately no new table, exactly like the in-app department registry.
//
// KEY CONVENTION: `<builtinKey>:<subKey>` (e.g. `lead_gen:nurture`). That is the
// same namespacing `subDeptStructureKey` uses for in-app departments, and it is
// what `parentOfDeptKey` (dept-rail.ts) and `resolveDeptCatalogRate`
// (resolve-rate.ts) already resolve generically — neither needed a change.
//
// HSL IS EXCLUDED ON PURPOSE. Its sub-teams stay code:
//   - `hslSubDeptOptions()` is the single source the onboarding picker, transfer
//     targets, the Pay Structure rail and the catalog export all read, while the
//     KPI surfaces (HslBonusCalculator, AdminRoles, use-bonus-scoring-queue,
//     ManagerBonusHistory, payroll-readiness, PayrollWizard) read HSL_DEPT_KEYS
//     *directly*. A data-driven HSL sub would be placeable but invisible to the
//     calculators;
//   - putting it in the KPI keyspace instead gives it a calculator card nobody
//     asked for AND a permanent `draft` row in Payroll Readiness that no one can
//     clear — measured behaviour, which is why `simple_texting` became a
//     placement-only key instead (see hsl-subdept.ts).
// HSL already HAS sub-teams; the departments that have none are the point here.

import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { HSL_BUILTIN_KEY, slugifyDeptKey, subDeptStructureKey, type DepartmentSubUnit } from './registry';

/** app_settings key holding the JSON map. */
export const BUILTIN_SUBS_SETTING_KEY = 'payment_catalog.departments.builtin_subs';

/** builtinKey -> its sub-departments, in display order. */
export type BuiltinSubMap = Record<string, DepartmentSubUnit[]>;

export const MAX_BUILTIN_SUBS = 24;

/** Can this built-in department carry DATA sub-departments? */
export function supportsDataSubDepartments(key: string): boolean {
  if (key === HSL_BUILTIN_KEY) return false;
  return DEPARTMENTS.some((d) => d.key === key);
}

/** The sub-departments stored for a built-in (never undefined). */
export function builtinSubsFor(map: BuiltinSubMap | null | undefined, key: string): DepartmentSubUnit[] {
  return map?.[key] ?? [];
}

/** The master-cell / rate-row label for one sub: `<builtinKey>:<subKey>`. */
export function builtinSubLabel(parentKey: string, subKey: string): string {
  return subDeptStructureKey(parentKey, subKey);
}

/** `{value,label}` per sub-department of one built-in, for pickers and rails. */
export function builtinSubOptions(
  map: BuiltinSubMap | null | undefined,
  key: string,
): Array<{ value: string; label: string }> {
  const parent = DEPARTMENTS.find((d) => d.key === key);
  if (!parent) return [];
  return builtinSubsFor(map, key).map((s) => ({
    value: builtinSubLabel(key, s.key),
    label: `${parent.name} — ${s.name}`,
  }));
}

/** Every built-in sub across every department — the rail / options feed. */
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
  if (key === HSL_BUILTIN_KEY) {
    return {
      ok: false,
      error: 'HSL sub-teams are defined in code — they carry KPI calculators and cannot be edited here.',
    };
  }
  if (!Array.isArray(input.subDepartments)) return { ok: false, error: 'Malformed sub-department payload.' };
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
  const prefix = `${parentKey.toLowerCase()}:`;
  for (const raw of rosterDeptCells) {
    const cell = (raw ?? '').trim().toLowerCase();
    if (!cell.startsWith(prefix)) continue;
    const sub = cell.slice(prefix.length);
    if (!sub) continue;
    out.set(sub, (out.get(sub) ?? 0) + 1);
  }
  return out;
}
