// Server-side storage for built-in departments' sub-departments -- one JSON
// object in app_settings (no dedicated table, no migration), mirroring
// registry-db.ts exactly. See builtin-subs.ts for the model and why HSL is
// excluded.

import { casUpdateAppSetting, getAppSettingWithMetaStrict } from '@/lib/supabase/app-settings';
import { BUILTIN_SUBS_SETTING_KEY, type BuiltinSubMap } from './builtin-subs';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import type { DepartmentSubUnit } from './registry';

const BUILTIN_KEYS = new Set(DEPARTMENTS.map((d) => d.key));

function sanitizeSub(raw: unknown): DepartmentSubUnit | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === 'string' ? r.key.trim().toLowerCase() : '';
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  // A colon would make `<parent>:<a>:<b>`, which parentOfDeptKey splits at the
  // FIRST colon -- rail and rate row would disagree on the parent.
  if (!key || !name || key.includes(':')) return null;
  return { key, name };
}

/** Parses the stored JSON. Corrupt JSON reads as empty but is NEVER persisted
 *  over here -- only an explicit save may overwrite. Unknown department keys are
 *  dropped, so a retired built-in cannot resurrect a rail entry. */
function parseMap(value: string | null): BuiltinSubMap {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: BuiltinSubMap = {};
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!BUILTIN_KEYS.has(key)) continue;
      const subs = (Array.isArray(raw) ? raw : [])
        .map(sanitizeSub)
        .filter((s): s is DepartmentSubUnit => s !== null);
      // De-dupe by key, first occurrence wins.
      const seen = new Set<string>();
      const deduped = subs.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)));
      if (deduped.length > 0) out[key] = deduped;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Reads the map plus its revision. THROWS on a failed read -- a transient DB
 * error must never be mistaken for "no sub-departments", because a later save
 * would then wipe every department's sub-teams. An absent key is genuinely
 * empty.
 */
export async function getBuiltinSubsWithRevision(): Promise<{ map: BuiltinSubMap; revision: string | null }> {
  const row = await getAppSettingWithMetaStrict(BUILTIN_SUBS_SETTING_KEY);
  // An ABSENT key is genuinely empty; a failed read throws inside the helper.
  return { map: parseMap(row?.value ?? null), revision: row?.updatedAt ?? null };
}

export async function getBuiltinSubs(): Promise<BuiltinSubMap> {
  return (await getBuiltinSubsWithRevision()).map;
}

/**
 * Compare-and-swap the sub-department list for ONE built-in department.
 *
 * `expectedRevision` is the `app_settings.updated_at` the editor loaded; a
 * mismatch answers `conflict` rather than merging, so two accountants editing at
 * once cannot silently overwrite each other -- the same contract as
 * `replaceDepartmentRegistryEntry`.
 */
export async function replaceBuiltinSubs(
  builtinKey: string,
  subDepartments: DepartmentSubUnit[],
  expectedRevision: string | null,
): Promise<{ ok: boolean; conflict?: boolean; error?: string }> {
  if (!BUILTIN_KEYS.has(builtinKey)) return { ok: false, error: 'That is not a built-in department.' };

  const loaded = await getBuiltinSubsWithRevision();
  if ((expectedRevision ?? null) !== (loaded.revision ?? null)) {
    return { ok: false, conflict: true };
  }

  const next: BuiltinSubMap = { ...loaded.map };
  const cleaned = subDepartments
    .map((s) => sanitizeSub(s))
    .filter((s): s is DepartmentSubUnit => s !== null);
  if (cleaned.length > 0) next[builtinKey] = cleaned;
  else delete next[builtinKey];

  const res = await casUpdateAppSetting(
    BUILTIN_SUBS_SETTING_KEY,
    JSON.stringify(next),
    loaded.revision,
  );
  return { ok: res.ok, conflict: res.conflict, ...(res.error ? { error: res.error } : {}) };
}
