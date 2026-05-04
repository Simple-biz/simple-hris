-- Add image_urls and source_label to swall_posts
ALTER TABLE swall_posts
  ADD COLUMN IF NOT EXISTS image_urls text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source_label text;

-- Create swall-media storage bucket (run in Supabase SQL editor or dashboard)
-- You may need to create this bucket via the Supabase Storage UI instead
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('swall-media', 'swall-media', true, 5242880, ARRAY['image/jpeg','image/png','image/gif','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload to swall-media
-- (DROP first so re-running the script is safe)
DROP POLICY IF EXISTS "Authenticated can upload swall media" ON storage.objects;
CREATE POLICY "Authenticated can upload swall media"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'swall-media');

DROP POLICY IF EXISTS "Public can read swall media" ON storage.objects;
CREATE POLICY "Public can read swall media"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'swall-media');
