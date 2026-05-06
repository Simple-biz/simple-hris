import { createSupabaseServiceRoleClient } from './server';

export type AnnouncementScope = 'general' | 'department';

export interface AnnouncementRow {
  id: string;
  author_email: string;
  author_name: string | null;
  scope: AnnouncementScope;
  department: string | null;
  title: string;
  body: string;
  pinned: boolean;
  created_at: string;
}

function client() {
  return createSupabaseServiceRoleClient();
}

/* ───────── full-name lookup (master list) ─────────
 *
 * Stored `author_name` on existing posts is whatever NextAuth's JWT had at
 * post-time (often a Google-truncated first name). For the wall we want the
 * canonical roster name, so we override `author_name` at fetch time using
 * `active_employees`. Cached for 5 minutes — names rarely change and the wall
 * is realtime-refreshed.
 */
const NAME_MAP_TTL_MS = 5 * 60_000;
let nameMapCache: { ts: number; map: Map<string, string> } | null = null;

async function getEmailToFullNameMap(): Promise<Map<string, string>> {
  if (nameMapCache && Date.now() - nameMapCache.ts < NAME_MAP_TTL_MS) {
    return nameMapCache.map;
  }
  const sb = client();
  const map = new Map<string, string>();
  if (!sb) return map;

  // active_employees is a view over the master list; columns are quoted
  // PascalCase. We only need three for the lookup.
  const { data, error } = await sb
    .from('active_employees')
    .select('"Name", "Work Email", "Personal Email"');
  if (error || !data) return map;

  for (const row of data as Array<Record<string, unknown>>) {
    const name = String(row['Name'] ?? '').trim();
    if (!name) continue;
    const we = String(row['Work Email'] ?? '').trim().toLowerCase();
    const pe = String(row['Personal Email'] ?? '').trim().toLowerCase();
    if (we) map.set(we, name);
    if (pe && !map.has(pe)) map.set(pe, name);
  }

  nameMapCache = { ts: Date.now(), map };
  return map;
}

/** Force a refresh on the next call — call after roster changes. */
export function invalidateAnnouncementsNameCache(): void {
  nameMapCache = null;
}

/** Look up a single full name by email (uses the cached map). */
export async function lookupFullNameForEmail(email: string): Promise<string | null> {
  const map = await getEmailToFullNameMap();
  return map.get(email.trim().toLowerCase()) ?? null;
}

/**
 * Fetch announcements visible to a viewer.
 * - `departments` = list of departments to include (for employees/managers).
 *   Pass `[]` to fetch general-only.
 *   Pass `null` to fetch everything (admin / CEO).
 */
export async function listAnnouncements(opts: {
  departments: string[] | null;
  limit?: number;
}): Promise<AnnouncementRow[]> {
  const sb = client();
  if (!sb) return [];

  let q = sb
    .from('announcements')
    .select('*')
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 100);

  // null = no filter (admin / CEO sees everything)
  if (opts.departments !== null) {
    if (opts.departments.length === 0) {
      q = q.eq('scope', 'general');
    } else {
      // general OR matches one of their departments
      q = q.or(
        `scope.eq.general,department.in.(${opts.departments.map((d) => `"${d}"`).join(',')})`,
      );
    }
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as AnnouncementRow[];

  // Override `author_name` with the canonical roster name for each unique
  // author email. Falls through to the stored value when no master row matches.
  if (rows.length > 0) {
    const nameMap = await getEmailToFullNameMap();
    return rows.map((row) => {
      const fullName = nameMap.get(row.author_email.trim().toLowerCase());
      return fullName ? { ...row, author_name: fullName } : row;
    });
  }
  return rows;
}

export async function insertAnnouncement(row: {
  author_email: string;
  author_name: string | null;
  scope: AnnouncementScope;
  department: string | null;
  title: string;
  body: string;
  pinned?: boolean;
}): Promise<AnnouncementRow> {
  const sb = client();
  if (!sb) throw new Error('Supabase not configured');

  const { data, error } = await sb
    .from('announcements')
    .insert({
      author_email: row.author_email,
      author_name: row.author_name,
      scope: row.scope,
      department: row.department ?? null,
      title: row.title.trim(),
      body: row.body.trim(),
      pinned: row.pinned ?? false,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data as AnnouncementRow;
}

export async function deleteAnnouncement(id: string): Promise<void> {
  const sb = client();
  if (!sb) throw new Error('Supabase not configured');
  const { error } = await sb.from('announcements').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function togglePinAnnouncement(id: string, pinned: boolean): Promise<void> {
  const sb = client();
  if (!sb) throw new Error('Supabase not configured');
  const { error } = await sb.from('announcements').update({ pinned }).eq('id', id);
  if (error) throw new Error(error.message);
}
