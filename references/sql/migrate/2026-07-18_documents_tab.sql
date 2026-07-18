-- ============================================================================
-- Documents tab (Accounting) + Employee "Request Documents"  — 2026-07-18
--
-- Employees submit a PDF (their Pay Stubs export, a COE, an award/certificate)
-- from Employee Dashboard → Profile → Request Documents. The request lands in
-- the new Accounting → Documents tab. Approving stamps the Accounting Head's
-- saved signature into the PDF (an appended certification page carrying the
-- REQUESTED date, the SIGNED date and the request id, so the document can be
-- verified as real) and returns the signed copy to the employee.
--
-- Run once in the Supabase SQL editor. Idempotent.
--
-- After running:
--   * grant the new Accounting → "Documents" feature (view/edit) to the
--     Accounting Head (Carla) from Admin → Roles — the tab is default-deny
--     like every other accounting tab (admins always see it).
-- ============================================================================

-- ── 1. Private storage bucket for original + signed PDFs ────────────────────
-- Server-only access via the service-role key; objects are read through
-- short-lived signed URLs. 10 MB cap, PDFs only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('document-requests', 'document-requests', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 2. document_requests — one row per employee submission ──────────────────
create table if not exists public.document_requests (
  id               uuid primary key default gen_random_uuid(),
  employee_email   text not null,                  -- session email of the requester
  employee_name    text,
  document_type    text not null check (document_type in ('paystub','coe','award','other')),
  period_label     text,                           -- e.g. 'Last 6 months · 26 weeks' for paystub bundles
  note             text,                           -- employee's purpose / instructions
  file_path        text not null,                  -- ORIGINAL uploaded PDF (private bucket object path)
  file_name        text,
  file_size        integer,
  status           text not null default 'pending' check (status in ('pending','signed','rejected')),
  signed_file_path text,                           -- stamped signed copy (set on approval)
  signed_at        timestamptz,                    -- the SIGNED date burned into the PDF
  signed_by        text,                           -- approver email
  signed_by_name   text,
  signed_by_title  text,                           -- e.g. 'Accounting Head'
  decision_note    text,                           -- rejection reason (rejected only)
  requested_at     timestamptz not null default now(), -- the REQUESTED date burned into the PDF
  updated_at       timestamptz not null default now()
);

create index if not exists document_requests_email_idx
  on public.document_requests (lower(employee_email), requested_at desc);
create index if not exists document_requests_status_idx
  on public.document_requests (status, requested_at desc);

-- ── 3. document_signatures — one saved signature per signer ─────────────────
-- The Accounting Head draws their signature once in the Documents tab; it is
-- stored here (PNG data URL) and stamped onto approved documents. The `enabled`
-- switch is the revoke: while off (or no row), that signer cannot approve.
create table if not exists public.document_signatures (
  owner_email    text primary key,                 -- lowercased signer email
  owner_name     text,
  title          text,                             -- e.g. 'Accounting Head'
  image_data_url text not null check (char_length(image_data_url) <= 400000),
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── 4. Realtime for the accounting queue ────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.document_requests;
    exception when duplicate_object then
      null;
    end;
  end if;
end$$;

-- ── 5. Widen employee_notifications.type for the documents flow ─────────────
-- ADD CONSTRAINT re-validates existing rows, so the FULL allowed set is
-- restated (authoritative list from add_payroll_paid_notification_type.sql)
-- PLUS the three new documents.* types:
--   documents.requested → accounting (gated on the Documents feature grant)
--   documents.signed / documents.rejected → the requesting employee
ALTER TABLE public.employee_notifications
  DROP CONSTRAINT IF EXISTS employee_notifications_type_check;

ALTER TABLE public.employee_notifications
  ADD CONSTRAINT employee_notifications_type_check
  CHECK (type IN (
    'rate.change',
    'promotion',
    'dispute.approved',
    'dispute.denied',
    'dispute.revoked',
    'onboarding.submitted',
    'time_adjustment.approved',
    'time_adjustment.denied',
    'transfer.requested',
    'transfer.approved',
    'transfer.rejected',
    'transfer.release_requested',
    'transfer.released',
    'transfer.declined',
    'transfer.applied',
    'payroll.processing_started',
    'payroll.processing_stopped',
    'payroll.paid',
    'special_transfer.recorded',
    'qc.scores_submitted',
    'qc.scores_returned',
    'people.banking.self_updated',
    'bank_info.requested',
    'offboarding.requested',
    'offboarding.request_completed',
    'offboarding.request_dismissed',
    'offboarding.request_returned',
    'resignation.submitted',
    'resignation.approved',
    'resignation.rejected',
    'ticket.replied',
    'ticket.assigned',
    'documents.requested',
    'documents.signed',
    'documents.rejected'
  ));

-- ── 6. (Optional) grant the Documents tab to the Accounting Head ─────────────
-- Same effect as Admin → Roles → Accounting → Documents = Edit. Replace the
-- email before uncommenting. (The active-grant uniqueness is a partial
-- expression index, so this uses insert-if-absent instead of ON CONFLICT.)
-- insert into public.employee_feature_permissions (work_email, view_key, feature, access, granted_by)
-- select 'carla@simple.biz', 'accounting', 'documents', 'edit', 'migration 2026-07-18'
-- where not exists (
--   select 1 from public.employee_feature_permissions
--   where lower(work_email) = 'carla@simple.biz'
--     and view_key = 'accounting' and feature = 'documents' and revoked_at is null
-- );
