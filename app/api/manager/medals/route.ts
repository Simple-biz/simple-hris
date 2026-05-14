import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function sessionEmail(session: Awaited<ReturnType<typeof getServerSession>>): string | null {
  const user = (session as { user?: { email?: string | null } } | null)?.user;
  return user?.email?.trim().toLowerCase() ?? null;
}

/** GET /api/manager/medals?emails=a@b.com,c@d.com */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!sessionEmail(session)) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const emails = req.nextUrl.searchParams.get('emails')
    ?.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean) ?? [];

  if (emails.length === 0) return NextResponse.json([]);

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });

  const { data, error } = await supabase
    .from('employee_medals')
    .select('*')
    .in('employee_email', emails)
    .order('awarded_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

/** POST /api/manager/medals — award a medal */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const awardedBy = sessionEmail(session);
  if (!awardedBy) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const body = (await req.json()) as {
    employee_email?: string;
    employee_name?: string | null;
    medal_type?: string;
    note?: string | null;
    is_private?: boolean;
  };

  const { employee_email, employee_name, medal_type, note, is_private } = body;
  if (!employee_email || !medal_type) {
    return NextResponse.json({ error: 'employee_email and medal_type are required' }, { status: 400 });
  }

  const VALID_TYPES = new Set(['commend', 'flag']);
  if (!VALID_TYPES.has(medal_type)) {
    return NextResponse.json({ error: 'Invalid medal_type' }, { status: 400 });
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });

  const { data, error } = await supabase
    .from('employee_medals')
    .insert({
      employee_email: employee_email.trim().toLowerCase(),
      employee_name: employee_name ?? null,
      medal_type,
      note: note?.trim() || null,
      is_private: is_private !== false,
      awarded_by: awardedBy,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
