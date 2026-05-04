import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';
import { listSwallComments, insertSwallComment } from '@/lib/supabase/swall';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/swall/comments?post_id=
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const postId = req.nextUrl.searchParams.get('post_id');
  if (!postId) return NextResponse.json({ error: 'post_id required' }, { status: 400 });

  try {
    const comments = await listSwallComments(postId);
    return NextResponse.json({ comments });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// POST /api/swall/comments  { post_id, body }
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const email = ((token.email as string) ?? '').trim().toLowerCase();
  const name = (token.name as string | null) ?? null;

  try {
    const { post_id, body } = (await req.json()) as { post_id?: string; body?: string };
    if (!post_id) return NextResponse.json({ error: 'post_id required' }, { status: 400 });
    if (!body?.trim()) return NextResponse.json({ error: 'body required' }, { status: 400 });

    const comment = await insertSwallComment({
      post_id,
      author_email: email,
      author_name: name,
      body: body.trim(),
    });
    return NextResponse.json({ comment });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
