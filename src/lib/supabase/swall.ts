import { createSupabaseServiceRoleClient } from './server';

export const SWALL_EMOJIS = ['👍', '❤️', '😂', '🔥', '😮', '👏'] as const;
export type SwallEmoji = (typeof SWALL_EMOJIS)[number];

export interface SwallPost {
  id: string;
  author_email: string;
  author_name: string | null;
  body: string;
  created_at: string;
  image_urls: string[];
  source_label: string | null;
}

export interface SwallReaction {
  id: string;
  post_id: string;
  user_email: string;
  emoji: string;
  created_at: string;
}

export interface SwallComment {
  id: string;
  post_id: string;
  author_email: string;
  author_name: string | null;
  body: string;
  created_at: string;
}

function client() {
  return createSupabaseServiceRoleClient();
}

export async function listSwallPosts(limit = 60): Promise<SwallPost[]> {
  const sb = client();
  if (!sb) return [];
  const { data, error } = await sb
    .from('swall_posts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as SwallPost[];
}

export async function listSwallReactionsForPosts(postIds: string[]): Promise<SwallReaction[]> {
  if (!postIds.length) return [];
  const sb = client();
  if (!sb) return [];
  const { data, error } = await sb
    .from('swall_reactions')
    .select('*')
    .in('post_id', postIds);
  if (error) throw new Error(error.message);
  return (data ?? []) as SwallReaction[];
}

export async function listSwallCommentCountsForPosts(
  postIds: string[],
): Promise<Record<string, number>> {
  if (!postIds.length) return {};
  const sb = client();
  if (!sb) return {};
  const { data, error } = await sb
    .from('swall_comments')
    .select('post_id')
    .in('post_id', postIds);
  if (error) throw new Error(error.message);
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    counts[row.post_id] = (counts[row.post_id] ?? 0) + 1;
  }
  return counts;
}

export async function listSwallComments(postId: string): Promise<SwallComment[]> {
  const sb = client();
  if (!sb) return [];
  const { data, error } = await sb
    .from('swall_comments')
    .select('*')
    .eq('post_id', postId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as SwallComment[];
}

export async function insertSwallPost(row: {
  author_email: string;
  author_name: string | null;
  body: string;
  image_urls?: string[];
  source_label?: string | null;
}): Promise<SwallPost> {
  const sb = client();
  if (!sb) throw new Error('Supabase not configured');
  const insertRow = {
    author_email: row.author_email,
    author_name: row.author_name,
    body: row.body,
    ...(row.image_urls !== undefined ? { image_urls: row.image_urls } : {}),
    ...(row.source_label !== undefined ? { source_label: row.source_label } : {}),
  };
  const { data, error } = await sb
    .from('swall_posts')
    .insert(insertRow)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as SwallPost;
}

export async function deleteSwallPost(id: string): Promise<void> {
  const sb = client();
  if (!sb) throw new Error('Supabase not configured');
  const { error } = await sb.from('swall_posts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function toggleSwallReaction(
  postId: string,
  userEmail: string,
  emoji: string,
): Promise<'added' | 'removed'> {
  const sb = client();
  if (!sb) throw new Error('Supabase not configured');
  const { data: existing } = await sb
    .from('swall_reactions')
    .select('id')
    .eq('post_id', postId)
    .eq('user_email', userEmail)
    .eq('emoji', emoji)
    .maybeSingle();
  if (existing) {
    await sb.from('swall_reactions').delete().eq('id', existing.id);
    return 'removed';
  }
  await sb.from('swall_reactions').insert({ post_id: postId, user_email: userEmail, emoji });
  return 'added';
}

export async function insertSwallComment(row: {
  post_id: string;
  author_email: string;
  author_name: string | null;
  body: string;
}): Promise<SwallComment> {
  const sb = client();
  if (!sb) throw new Error('Supabase not configured');
  const { data, error } = await sb
    .from('swall_comments')
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as SwallComment;
}

export async function deleteSwallComment(id: string): Promise<void> {
  const sb = client();
  if (!sb) throw new Error('Supabase not configured');
  const { error } = await sb.from('swall_comments').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
