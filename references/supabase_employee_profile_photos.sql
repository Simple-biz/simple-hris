-- Employee profile photos: Storage bucket + column on your master employees table.
-- Run in Supabase → SQL Editor. Replace global_master_list if your env uses another table.
--
-- Flow:
-- 1) Bucket stores one JPEG per employee (path: avatars/<safe_email>/avatar.jpg).
-- 2) "Profile Photo URL" on the master row stores the public URL (from storage.getPublicUrl).
-- 3) The Next.js app compresses images over 5 MB in the browser before upload; the bucket
--    also enforces a 5 MB max per object as a safety net.

-- ─── Storage bucket (public read so <img src="..."> works without auth) ─────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'employee-avatars',
  'employee-avatars',
  true,
  5242880, -- 5 MiB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Anyone can read avatar objects (URLs are unguessable enough for internal HR tools;
-- tighten if you need signed URLs only.)
DROP POLICY IF EXISTS "Public read employee avatars" ON storage.objects;
CREATE POLICY "Public read employee avatars"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'employee-avatars');

-- No INSERT/UPDATE/DELETE for anon/authenticated clients — uploads go through the
-- Next.js API route using the service_role key, which bypasses these policies.

-- ─── Master list column (stores public URL string) ─────────────────────────────
-- If your table name differs, change both identifiers below.
ALTER TABLE public.global_master_list
  ADD COLUMN IF NOT EXISTS "Profile Photo URL" text;

COMMENT ON COLUMN public.global_master_list."Profile Photo URL" IS
  'Public Supabase Storage URL for the employee profile photo (JPEG after client compression).';
