import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';
import { toggleSwallReaction, SWALL_EMOJIS } from '@/lib/supabase/swall';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/swall/reactions  { post_id, emoji }  → toggles (add/remove)
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const email = ((token.email as string) ?? '').trim().toLowerCase();

  try {
    const { post_id, emoji } = (await req.json()) as { post_id?: string; emoji?: string };
    if (!post_id) return NextResponse.json({ error: 'post_id required' }, { status: 400 });
    if (!emoji || !(SWALL_EMOJIS as readonly string[]).includes(emoji)) {
      return NextResponse.json({ error: 'invalid emoji' }, { status: 400 });
    }
    const result = await toggleSwallReaction(post_id, email, emoji);
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
