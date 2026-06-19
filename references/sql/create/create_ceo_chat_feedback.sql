-- Migration: CEO assistant per-response feedback (thumbs up / down)
--
-- Stores a rating for each assistant reply in the CEO dashboard chat widget so
-- the team can review what worked vs. didn't and improve the prompt + tools.
-- One row per rated response, keyed by a client-generated `message_key`
-- (re-rating the same response upserts in place). Written only by the server
-- route POST /api/ceo/chat/feedback (service-role; gated to ceo/admin). No RLS —
-- same posture as the other server-only tables (e.g. disbursement_records).
--
-- Run in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.ceo_chat_feedback (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_key       text NOT NULL,
  rating            text NOT NULL CHECK (rating IN ('up', 'down')),
  rated_by          text NOT NULL,               -- session email of the rater
  user_message      text,                         -- the prompt that produced the reply
  assistant_message text NOT NULL,                -- the rated reply
  comment           text,                         -- optional free-text (esp. on a down vote)
  context           jsonb,                         -- recent transcript [{role,content}] for review
  model             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per rated response; re-rating upserts on this key.
CREATE UNIQUE INDEX IF NOT EXISTS ceo_chat_feedback_message_key_uniq
  ON public.ceo_chat_feedback (message_key);

CREATE INDEX IF NOT EXISTS ceo_chat_feedback_rating_idx
  ON public.ceo_chat_feedback (rating);
CREATE INDEX IF NOT EXISTS ceo_chat_feedback_created_idx
  ON public.ceo_chat_feedback (created_at DESC);

-- Keep updated_at fresh on upsert-update (the route also sets it as a backstop).
CREATE OR REPLACE FUNCTION public.ceo_chat_feedback_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ceo_chat_feedback_touch_updated_at ON public.ceo_chat_feedback;
CREATE TRIGGER ceo_chat_feedback_touch_updated_at
  BEFORE UPDATE ON public.ceo_chat_feedback
  FOR EACH ROW EXECUTE FUNCTION public.ceo_chat_feedback_touch();
