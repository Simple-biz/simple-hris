import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BUCKET = 'swall-media';
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 });
    if (!file.type.startsWith('image/')) return NextResponse.json({ error: 'Not an image' }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Max 5 MB per image' }, { status: 400 });

    const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z]/g, '') || 'jpg';
    const path = `posts/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const buf = await file.arrayBuffer();

    const { error } = await sb.storage.from(BUCKET).upload(path, buf, { contentType: file.type, upsert: false });
    if (error) throw new Error(error.message);

    const { data: { publicUrl } } = sb.storage.from(BUCKET).getPublicUrl(path);
    return NextResponse.json({ url: publicUrl });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
