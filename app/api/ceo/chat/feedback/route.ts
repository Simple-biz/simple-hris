import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { upsertCeoChatFeedback, type CeoChatRating } from '@/lib/supabase/ceo-chat-feedback';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Records a thumbs-up/down rating for a single CEO-assistant reply, so the team
 * can review what worked and improve the assistant. Same auth gate as the chat
 * route (ceo/admin). One row per rated response (upsert by message_key).
 */

function sessionRoles(session: unknown): string[] {
  const user = (session as { user?: { roles?: string[] } } | null)?.user;
  return Array.isArray(user?.roles) ? user!.roles! : [];
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string } | undefined)?.email;
  if (!email) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const roles = sessionRoles(session);
  if (!roles.includes('ceo') && !roles.includes('admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const rating = body.rating;
  if (rating !== 'up' && rating !== 'down') {
    return NextResponse.json({ error: 'rating must be "up" or "down"' }, { status: 400 });
  }
  const messageKey = typeof body.message_key === 'string' ? body.message_key.trim() : '';
  const assistantMessage = typeof body.assistant_message === 'string' ? body.assistant_message : '';
  if (!messageKey || !assistantMessage) {
    return NextResponse.json(
      { error: 'message_key and assistant_message are required' },
      { status: 400 },
    );
  }

  const { error } = await upsertCeoChatFeedback({
    messageKey,
    rating: rating as CeoChatRating,
    ratedBy: email,
    userMessage: typeof body.user_message === 'string' ? body.user_message.slice(0, 8000) : null,
    assistantMessage: assistantMessage.slice(0, 16000),
    comment: typeof body.comment === 'string' ? body.comment.slice(0, 2000) : null,
    context: Array.isArray(body.context) ? body.context.slice(-8) : null,
    model: 'claude-sonnet-4-6',
  });

  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
