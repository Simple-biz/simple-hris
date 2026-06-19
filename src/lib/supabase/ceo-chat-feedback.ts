import 'server-only';

import { createSupabaseServiceRoleClient } from './server';

export type CeoChatRating = 'up' | 'down';

export type CeoChatFeedbackInput = {
  /** Client-stable id for the rated response (upsert key). */
  messageKey: string;
  rating: CeoChatRating;
  ratedBy: string;
  userMessage?: string | null;
  assistantMessage: string;
  comment?: string | null;
  /** Recent transcript [{role, content}] for later review. */
  context?: unknown;
  model?: string | null;
};

/**
 * Record (or update) a thumbs-up/down rating for one CEO-assistant response.
 * Upserts on `message_key` so re-rating the same reply overwrites rather than
 * duplicating. Backed by `public.ceo_chat_feedback` (see
 * references/sql/create/create_ceo_chat_feedback.sql).
 */
export async function upsertCeoChatFeedback(
  input: CeoChatFeedbackInput,
): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { error } = await supabase.from('ceo_chat_feedback').upsert(
    {
      message_key: input.messageKey,
      rating: input.rating,
      rated_by: input.ratedBy,
      user_message: input.userMessage ?? null,
      assistant_message: input.assistantMessage,
      comment: input.comment ?? null,
      context: input.context ?? null,
      model: input.model ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'message_key' },
  );

  return { error: error ? error.message : null };
}
