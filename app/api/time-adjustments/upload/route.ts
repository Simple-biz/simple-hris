import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { uploadTimeAdjustmentImage } from '@/lib/supabase/time-adjustments';
import { normEmail } from '@/lib/email/norm-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sessionEmail = normEmail((token.email as string) ?? '') ?? '';

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 });
    if (!file.type.startsWith('image/')) return NextResponse.json({ error: 'Not an image' }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Max 5 MB per image' }, { status: 400 });

    // requestKey groups images for one in-progress request; idx orders them.
    const requestKey = (form.get('request_key') as string | null)?.replace(/[^a-zA-Z0-9_-]/g, '') || 'draft';
    const idxRaw = parseInt((form.get('idx') as string | null) ?? '0', 10);
    const idx = Number.isFinite(idxRaw) ? idxRaw : 0;

    const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const buf = await file.arrayBuffer();

    const { path, error } = await uploadTimeAdjustmentImage(
      requestKey,
      sessionEmail || 'unknown',
      buf,
      file.type,
      idx,
      ext,
    );
    if (error || !path) throw new Error(error ?? 'Upload failed');

    return NextResponse.json({ path });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
