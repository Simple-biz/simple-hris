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
  /**
   * Resolved at fetch time from the roster (manual upload, else Google SSO).
   * Not a real column. `undefined` on Realtime payloads -- the client falls
   * back to the photo endpoint there.
   */
  author_photo_url?: string | null;
}

function client() {
  return createSupabaseServiceRoleClient();
}

/* ───────── author lookup (master list) ─────────
 *
 * Stored `author_name` on existing posts is whatever NextAuth's JWT had at
 * post-time (often a Google-truncated first name), and posts carry no photo.
 * For the wall we want the canonical roster name + avatar, so we resolve both
 * at fetch time from `active_employees`. Cached for 5 minutes — the roster
 * rarely changes and the wall is realtime-refreshed.
 */
const AUTHOR_MAP_TTL_MS = 5 * 60_000;

interface AuthorMeta {
  name: string | null;
  photoUrl: string | null;
}

let authorMapCache: { ts: number; map: Map<string, AuthorMeta> } | null = null;

async function getEmailToAuthorMetaMap(): Promise<Map<string, AuthorMeta>> {
  if (authorMapCache && Date.now() - authorMapCache.ts < AUTHOR_MAP_TTL_MS) {
    return authorMapCache.map;
  }
  const sb = client();
  const map = new Map<string, AuthorMeta>();
  if (!sb) return map;

  // active_employees is a `SELECT *` view over the master list; columns are
  // quoted PascalCase. Manual upload wins over the Google SSO photo, matching
  // getProfilePhotoUrlForEmail().
  const { data, error } = await sb
    .from('active_employees')
    .select('"Name", "Work Email", "Personal Email", "Profile Photo URL", google_photo_url');
  if (error || !data) return map;

  for (const row of data as Array<Record<string, unknown>>) {
    const name = String(row['Name'] ?? '').trim() || null;
    const uploaded = String(row['Profile Photo URL'] ?? '').trim();
    const google = String(row['google_photo_url'] ?? '').trim();
    const meta: AuthorMeta = { name, photoUrl: uploaded || google || null };

    const we = String(row['Work Email'] ?? '').trim().toLowerCase();
    const pe = String(row['Personal Email'] ?? '').trim().toLowerCase();
    if (we) map.set(we, meta);
    if (pe && !map.has(pe)) map.set(pe, meta);
  }

  authorMapCache = { ts: Date.now(), map };
  return map;
}

/** Force a refresh on the next call — call after roster changes. */
export function invalidateAnnouncementsNameCache(): void {
  authorMapCache = null;
}

/** Look up a single full name by email (uses the cached map). */
export async function lookupFullNameForEmail(email: string): Promise<string | null> {
  const map = await getEmailToAuthorMetaMap();
  return map.get(email.trim().toLowerCase())?.name ?? null;
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

  // Resolve the canonical roster name + avatar for each author email. Name
  // falls through to the stored value when no master row matches; photo is null.
  if (rows.length > 0) {
    const metaMap = await getEmailToAuthorMetaMap();
    return rows.map((row) => {
      const meta = metaMap.get(row.author_email.trim().toLowerCase());
      return {
        ...row,
        author_name: meta?.name ?? row.author_name,
        author_photo_url: meta?.photoUrl ?? null,
      };
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
