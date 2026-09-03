// Server-side storage for the custom department registry -- a JSON array in
// app_settings (no dedicated table, no migration). See registry.ts for the
// data model and why the registry exists at all.

import {
  casUpdateAppSetting,
  getAppSettingStrict,
  getAppSettingWithMetaStrict,
  upsertAppSetting,
} from '@/lib/supabase/app-settings';
import {
  DEPARTMENTS_REGISTRY_SETTING_KEY,
  type DepartmentMemberRecord,
  type DepartmentRegistryEntry,
} from './registry';

function sanitizeMember(raw: unknown): DepartmentMemberRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  const workEmail = typeof r.workEmail === 'string' ? r.workEmail.trim().toLowerCase() : '';
  if (!name || !workEmail) return null;
  return {
    name,
    workEmail,
    personalEmail:
      typeof r.personalEmail === 'string' && r.personalEmail.trim()
        ? r.personalEmail.trim().toLowerCase()
        : null,
    isManager: r.isManager === true,
    subDepartment: typeof r.subDepartment === 'string' && r.subDepartment ? r.subDepartment : null,
    startDate: typeof r.startDate === 'string' && r.startDate ? r.startDate : null,
    addedBy: typeof r.addedBy === 'string' ? r.addedBy : null,
    addedAt: typeof r.addedAt === 'string' ? r.addedAt : null,
  };
}

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
  const members = (Array.isArray(r.members) ? r.members : [])
    .map(sanitizeMember)
    .filter((m): m is DepartmentMemberRecord => m !== null);
  // Former names (a rename keeps the key). Trimmed, de-duplicated, never the
  // current name — so deptEntryLabels() is exactly "name + previousNames".
  const seenLabels = new Set([name.toLowerCase()]);
  const previousNames = (Array.isArray(r.previousNames) ? r.previousNames : [])
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => {
      if (!v || seenLabels.has(v.toLowerCase())) return false;
      seenLabels.add(v.toLowerCase());
      return true;
    });
  return {
    key,
    name,
    subDepartments,
    members,
    createdBy: typeof r.createdBy === 'string' ? r.createdBy : null,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
    ...(previousNames.length > 0 ? { previousNames } : {}),
    ...(typeof r.updatedBy === 'string' ? { updatedBy: r.updatedBy } : {}),
    ...(typeof r.updatedAt === 'string' ? { updatedAt: r.updatedAt } : {}),
  };
}

/** Parses the stored JSON. Corrupt JSON reads as empty but is NEVER persisted
 *  over here — only an explicit save may overwrite. */
function parseRegistry(value: string | null): DepartmentRegistryEntry[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeEntry).filter((e): e is DepartmentRegistryEntry => e !== null);
  } catch {
    return [];
  }
}

/** Reads the registry. THROWS on a failed read (a transient DB error must not
 *  be mistaken for "no custom departments" -- a later save would then wipe the
 *  registry). An absent key is genuinely an empty registry. */
export async function getDepartmentRegistry(): Promise<DepartmentRegistryEntry[]> {
  return parseRegistry(await getAppSettingStrict(DEPARTMENTS_REGISTRY_SETTING_KEY));
}

/**
 * The registry plus its REVISION — `app_settings.updated_at` for the key (null
 * when the key does not exist yet). The Edit Department dialog carries the
 * revision it loaded back on save so {@link replaceDepartmentRegistryEntry}
 * can refuse a stale write. THROWS on a failed read, like getDepartmentRegistry.
 */
export async function getDepartmentRegistryWithRevision(): Promise<{
  registry: DepartmentRegistryEntry[];
  revision: string | null;
}> {
  const meta = await getAppSettingWithMetaStrict(DEPARTMENTS_REGISTRY_SETTING_KEY);
  if (!meta) return { registry: [], revision: null };
  return { registry: parseRegistry(meta.value), revision: meta.updatedAt };
}

/**
 * Replaces ONE entry (matched by key) with a compare-and-swap on the registry
 * revision: the write lands only if `app_settings.updated_at` still equals
 * `expectedRevision`. Two accountants editing departments at once therefore
 * cannot silently overwrite each other — the loser gets `conflict: true` and
 * reloads. `error` is reserved for a write that genuinely failed.
 */
export async function replaceDepartmentRegistryEntry(
  entry: DepartmentRegistryEntry,
  expectedRevision: string | null,
): Promise<{ ok: boolean; conflict: boolean; error: string | null; revision: string | null }> {
  let loaded: { registry: DepartmentRegistryEntry[]; revision: string | null };
  try {
    loaded = await getDepartmentRegistryWithRevision();
  } catch (e) {
    return {
      ok: false,
      conflict: false,
      error: e instanceof Error ? e.message : 'Could not read the department registry',
      revision: null,
    };
  }
  if ((loaded.revision ?? null) !== (expectedRevision ?? null)) {
    return { ok: false, conflict: true, error: null, revision: loaded.revision };
  }
  if (!loaded.registry.some((e) => e.key === entry.key)) {
    return { ok: false, conflict: false, error: `Department "${entry.key}" is not in the registry`, revision: loaded.revision };
  }
  const next = loaded.registry.filter((e) => e.key !== entry.key);
  next.push(entry);
  next.sort((a, b) => a.name.localeCompare(b.name));
  const res = await casUpdateAppSetting(DEPARTMENTS_REGISTRY_SETTING_KEY, JSON.stringify(next), loaded.revision);
  return { ok: res.ok, conflict: res.conflict, error: res.error, revision: res.updatedAt ?? loaded.revision };
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

/** Merges member records into an entry (matched by lower-cased work email --
 *  an incoming record replaces the stored one) and persists. Returns the
 *  updated entry. */
export async function mergeDepartmentMembers(
  key: string,
  incoming: DepartmentMemberRecord[],
): Promise<{ entry: DepartmentRegistryEntry | null; error: string | null }> {
  let registry: DepartmentRegistryEntry[];
  try {
    registry = await getDepartmentRegistry();
  } catch (e) {
    return { entry: null, error: e instanceof Error ? e.message : 'Could not read the department registry' };
  }
  const entry = registry.find((e) => e.key === key);
  if (!entry) return { entry: null, error: `Department "${key}" is not in the registry` };
  const byEmail = new Map(entry.members.map((m) => [m.workEmail, m] as const));
  for (const m of incoming) byEmail.set(m.workEmail, m);
  const next: DepartmentRegistryEntry = { ...entry, members: [...byEmail.values()] };
  const saved = await upsertDepartmentRegistryEntry(next);
  return { entry: saved.error ? null : next, error: saved.error };
}
