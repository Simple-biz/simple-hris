import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import {
  listSwallPosts,
  listSwallReactionsForPosts,
  listSwallCommentCountsForPosts,
  insertSwallPost,
} from '@/lib/supabase/swall';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CAN_POST_ROLES = new Set([
  'admin', 'ceo', 'hr_coordinator', 'payroll_coordinator',
  'payroll_manager', 'finance', 'manager', 'orphanage_manager',
]);

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

// GET /api/swall/posts?viewer=email
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const viewerEmail = ((req.nextUrl.searchParams.get('viewer') ?? token.email ?? '') as string)
    .trim().toLowerCase();

  try {
    const posts = await listSwallPosts(60);
    const postIds = posts.map((p) => p.id);
    const [reactions, commentCounts] = await Promise.all([
      listSwallReactionsForPosts(postIds),
      listSwallCommentCountsForPosts(postIds),
    ]);

    // Aggregate reaction counts + viewer's own reactions per post
    const reactionMap: Record<string, { counts: Record<string, number>; mine: string[] }> = {};
    for (const r of reactions) {
      if (!reactionMap[r.post_id]) reactionMap[r.post_id] = { counts: {}, mine: [] };
      const entry = reactionMap[r.post_id]!;
      entry.counts[r.emoji] = (entry.counts[r.emoji] ?? 0) + 1;
      if (r.user_email.toLowerCase() === viewerEmail) entry.mine.push(r.emoji);
    }

    const enriched = posts.map((p) => ({
      ...p,
      reaction_counts: reactionMap[p.id]?.counts ?? {},
      my_reactions: reactionMap[p.id]?.mine ?? [],
      comment_count: commentCounts[p.id] ?? 0,
    }));

    return NextResponse.json({ posts: enriched });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// POST /api/swall/posts
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const email = ((token.email as string) ?? '').trim().toLowerCase();
  const name = (token.name as string | null) ?? null;
  const roles = await getRoles(email);

  if (!roles.some((r) => CAN_POST_ROLES.has(r))) {
    return NextResponse.json({ error: 'Not authorized to post to the S-Wall' }, { status: 403 });
  }

  try {
    const { body, image_urls, source_label } = (await req.json()) as {
      body?: string;
      image_urls?: string[];
      source_label?: string | null;
    };
    const trimmedBody = body?.trim() ?? '';
    const urls = Array.isArray(image_urls) ? image_urls.filter((u) => typeof u === 'string' && u.trim()) : [];
    if (!trimmedBody && urls.length === 0) {
      return NextResponse.json({ error: 'body or at least one image is required' }, { status: 400 });
    }
    const post = await insertSwallPost({
      author_email: email,
      author_name: name,
      body: trimmedBody,
      image_urls: urls,
      source_label: source_label ?? null,
    });
    return NextResponse.json({ post });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
