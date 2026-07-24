// Server-side storage for the custom department registry -- a JSON array in
// app_settings (no dedicated table, no migration). See registry.ts for the
// data model and why the registry exists at all.

import { getAppSettingStrict, upsertAppSetting } from '@/lib/supabase/app-settings';
import {
  DEPARTMENTS_REGISTRY_SETTING_KEY,
  type DepartmentRegistryEntry,
} from './registry';

function sanitizeEntry(raw: unknown): DepartmentRegistryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === 'string' ? r.key.trim() : '';
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!key || !name) return null;
  const subs = Array.isArray(r.subDepartments) ? r.subDepartments : [];
  const subDepartments = subs
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const sub = s as Record<string, unknown>;
      const subKey = typeof sub.key === 'string' ? sub.key.trim() : '';
      const subName = typeof sub.name === 'string' ? sub.name.trim() : '';
      return subKey && subName ? { key: subKey, name: subName } : null;
    })
    .filter((s): s is { key: string; name: string } => s !== null);
  const memberSubDepartments: Record<string, string> = {};
  if (r.memberSubDepartments && typeof r.memberSubDepartments === 'object') {
    for (const [email, subKey] of Object.entries(r.memberSubDepartments as Record<string, unknown>)) {
      if (typeof subKey === 'string' && subKey) memberSubDepartments[email.toLowerCase()] = subKey;
    }
  }
  return {
    key,
    name,
    subDepartments,
    memberSubDepartments,
    createdBy: typeof r.createdBy === 'string' ? r.createdBy : null,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
  };
}

/** Reads the registry. THROWS on a failed read (a transient DB error must not
 *  be mistaken for "no custom departments" -- a later save would then wipe the
 *  registry). An absent key is genuinely an empty registry. */
export async function getDepartmentRegistry(): Promise<DepartmentRegistryEntry[]> {
  const value = await getAppSettingStrict(DEPARTMENTS_REGISTRY_SETTING_KEY);
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeEntry).filter((e): e is DepartmentRegistryEntry => e !== null);
  } catch {
    // Corrupt JSON: surface as empty but DO NOT persist anything over it here;
    // only an explicit save may overwrite.
    return [];
  }
}

/** Inserts or replaces one entry (matched by key) and persists the registry. */
export async function upsertDepartmentRegistryEntry(
  entry: DepartmentRegistryEntry,
): Promise<{ error: string | null }> {
  let registry: DepartmentRegistryEntry[];
  try {
    registry = await getDepartmentRegistry();
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not read the department registry' };
  }
  const next = registry.filter((e) => e.key !== entry.key);
  next.push(entry);
  next.sort((a, b) => a.name.localeCompare(b.name));
  return upsertAppSetting(DEPARTMENTS_REGISTRY_SETTING_KEY, JSON.stringify(next));
}
