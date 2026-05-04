import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { deleteSwallPost } from '@/lib/supabase/swall';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function getRoles(email: string): Promise<string[]> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return [];
  const { data } = await sb.from('employee_roles').select('role').ilike('work_email', email).is('revoked_at', null);
  return (data ?? []).map((r: { role: string }) => r.role);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const email = ((token.email as string) ?? '').trim().toLowerCase();
  const roles = await getRoles(email);
  const isElevated = roles.includes('admin') || roles.includes('ceo');

  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { data: post } = await sb.from('swall_posts').select('author_email').eq('id', id).maybeSingle();
  if (!post) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!isElevated && post.author_email?.toLowerCase() !== email) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    await deleteSwallPost(id);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
