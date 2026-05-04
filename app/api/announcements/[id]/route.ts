import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { type NextRequest } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { deleteAnnouncement, togglePinAnnouncement } from '@/lib/supabase/announcements';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function getRoles(email: string): Promise<string[]> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return [];
  const { data } = await sb
    .from('employee_roles')
    .select('role')
    .ilike('work_email', email)
    .is('revoked_at', null);
  return (data ?? []).map((r: { role: string }) => r.role);
}

// DELETE /api/announcements/[id]
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const email = ((token.email as string) ?? '').trim().toLowerCase();
  const roles = await getRoles(email);
  const isElevated = roles.includes('admin') || roles.includes('ceo');

  // Fetch the announcement to check authorship
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { data: ann } = await sb
    .from('announcements')
    .select('author_email')
    .eq('id', params.id)
    .maybeSingle();

  if (!ann) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const isAuthor = ann.author_email?.toLowerCase() === email;
  if (!isElevated && !isAuthor) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    await deleteAnnouncement(params.id);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// PATCH /api/announcements/[id] — toggle pin
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const email = ((token.email as string) ?? '').trim().toLowerCase();
  const roles = await getRoles(email);

  if (!roles.includes('admin') && !roles.includes('ceo')) {
    return NextResponse.json({ error: 'Only admin/CEO can pin announcements' }, { status: 403 });
  }

  const { pinned } = (await req.json()) as { pinned?: boolean };
  if (typeof pinned !== 'boolean') {
    return NextResponse.json({ error: 'pinned (boolean) is required' }, { status: 400 });
  }

  try {
    await togglePinAnnouncement(params.id, pinned);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
