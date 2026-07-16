import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { deniedResponse, requireElevatedSession } from '@/lib/auth/authorize-email';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { lookupFullNameForEmail } from '@/lib/supabase/announcements';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLE = 'mesa_notes';
const SELECT_COLS = 'id, member_email, body, author_email, author_name, created_at';
const MAX_LEN = 2000;

export interface MesaNoteRow {
  id: string;
  member_email: string;
  body: string;
  author_email: string;
  author_name: string | null;
  created_at: string;
}

// GET /api/mesa-notes?email=xxx
// Internal note log for one member. requireElevatedSession only — no
// self-view branch. These are staff annotating a member's MESA file, not
// something the member ever sees about themselves.
export async function GET(request: Request) {
  try {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const email = new URL(request.url).searchParams.get('email')?.trim().toLowerCase();
    if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const { data, error } = await supabase
      .from(TABLE)
      .select(SELECT_COLS)
      .ilike('member_email', email)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ notes: (data ?? []) as MesaNoteRow[] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST /api/mesa-notes
// Add a note. requireFeatureEditAnyView('mesa') — the same mutation gate as
// approve/deny/revoke/delete on mesa_requests (admits Accounting or HR).
export async function POST(request: Request) {
  try {
    const authz = await requireFeatureEditAnyView('mesa');
    if (!authz.ok) return deniedResponse(authz);

    const payload = (await request.json()) as { member_email?: string; body?: string };
    const member_email = (payload.member_email ?? '').trim().toLowerCase();
    const body = (payload.body ?? '').trim();
    if (!member_email) return NextResponse.json({ error: 'member_email is required' }, { status: 400 });
    if (!body) return NextResponse.json({ error: 'Note cannot be empty' }, { status: 400 });
    if (body.length > MAX_LEN) {
      return NextResponse.json({ error: `Note is too long (max ${MAX_LEN} characters)` }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    // Author is always server-resolved from the session — never trust a
    // client-supplied author (matches reviewed_by on mesa_requests).
    const authorName = await lookupFullNameForEmail(authz.sessionEmail);
    const { data, error } = await supabase
      .from(TABLE)
      .insert({ member_email, body, author_email: authz.sessionEmail, author_name: authorName })
      .select(SELECT_COLS)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'mesa.note.added',
      resource: TABLE,
      resource_id: (data as MesaNoteRow | null)?.id ?? null,
      details: { member_email, preview: body.slice(0, 140) },
    });

    return NextResponse.json({ note: data as MesaNoteRow });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
