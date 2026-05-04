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
  return (data ?? []) as AnnouncementRow[];
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
