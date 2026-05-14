import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/employee/commendations — shared commendations for the logged-in employee only. */
export async function GET() {
  const session = await getServerSession(authOptions);
  const email = (session as { user?: { email?: string | null } } | null)
    ?.user?.email?.trim().toLowerCase();

  if (!email) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });

  // Resolve all known emails for this person (work + personal) so the query
  // matches regardless of which email the manager used when awarding.
  const { data: masterRows } = await supabase
    .from('global_master_list')
    .select('"Work Email", "Personal Email"')
    .or(`"Work Email".ilike.${email},"Personal Email".ilike.${email}`)
    .limit(1);

  const emails = new Set<string>([email]);
  if (masterRows && masterRows.length > 0) {
    const row = masterRows[0] as Record<string, string | null>;
    const we = row['Work Email']?.trim().toLowerCase();
    const pe = row['Personal Email']?.trim().toLowerCase();
    if (we) emails.add(we);
    if (pe) emails.add(pe);
  }

  const { data, error } = await supabase
    .from('employee_medals')
    .select('id, medal_type, note, awarded_by, awarded_at')
    .in('employee_email', [...emails])
    .eq('medal_type', 'commend')
    .eq('is_private', false)
    .order('awarded_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}
