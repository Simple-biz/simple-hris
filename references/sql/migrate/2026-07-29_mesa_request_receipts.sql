-- ============================================================================
-- MESA disbursement receipts  — 2026-07-29
--
-- The MESA program rules already require it ("Receipts must be submitted within
-- 14 days. All receipts must be valid and include the merchant's name."), but
-- until now there was nowhere to put one: the receipt arrived over email or not
-- at all, so Accounting reviewing a disbursement had no evidence attached to the
-- request it was judging.
--
-- Employee → MESA → Request → Past requests now carries a Receipt column. A
-- member attaches up to THREE files (images or PDFs) per disbursement request;
-- Accounting → MESA → Requests shows the count on the row and the files
-- themselves in the review modal.
--
-- Run once. Idempotent — safe to re-run.
--   node scripts/apply-mesa-receipts.mjs
--
-- Run it BEFORE deploying: the Receipt column reads this table, and the upload
-- endpoint writes it.
-- ============================================================================

-- ── 1. Private storage bucket ───────────────────────────────────────────────
-- Server-only access via the service-role key; files are read through
-- short-lived signed URLs, never a public URL — a receipt is a medical/financial
-- document and must not be guessable. 5 MB per file matches the app's other
-- upload paths (time-adjustment evidence, S-Wall media), which keeps a single
-- request body inside the serverless body limit.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'mesa-receipts',
  'mesa-receipts',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 2. mesa_request_receipts — one row per attached file ─────────────────────
-- A child table rather than an array/JSONB column on mesa_requests, for two
-- reasons that both matter here:
--   * per-file metadata. `uploaded_at` is what proves the 14-day submission
--     rule was met; the original filename and size are what let Accounting say
--     "that's the pharmacy receipt" without opening all three.
--   * no read-modify-write. A JSONB blob replaced wholesale is exactly how the
--     payroll-notes Adjustment bridge lost a week of amounts; inserts can't
--     clobber a sibling.
--
-- `slot` (1..3) + the unique constraint below is the cap: not an advisory count
-- check in the API that a double-submit can race past, but a constraint the
-- database enforces. It also gives the files a stable display order.
create table if not exists public.mesa_request_receipts (
  id          uuid        primary key default gen_random_uuid(),
  request_id  uuid        not null references public.mesa_requests (id) on delete cascade,
  -- Denormalized from the parent so authorization and per-member lookups don't
  -- need the join. Written lowercased.
  work_email  text        not null,
  slot        smallint    not null check (slot between 1 and 3),
  file_path   text        not null unique,   -- object path in the private bucket
  file_name   text,                          -- original filename, as the member saw it
  file_size   integer,
  mime_type   text,
  uploaded_by text,                          -- session email that performed the upload
  uploaded_at timestamptz not null default now(),
  -- Three receipts per request, enforced in the DB.
  constraint mesa_request_receipts_slot_uniq unique (request_id, slot)
);

create index if not exists mesa_request_receipts_request_idx
  on public.mesa_request_receipts (request_id, slot);
create index if not exists mesa_request_receipts_email_idx
  on public.mesa_request_receipts (lower(work_email), uploaded_at desc);

comment on table public.mesa_request_receipts is
  'Receipt files (images/PDF) attached to a MESA disbursement request. Max 3 per request via the (request_id, slot) unique constraint. Objects live in the private mesa-receipts bucket.';
