-- Time Adjustment Requests
-- Employee-initiated, evidence-backed requests asking Accounting to correct the
-- tracked hours for a given day (forgot to start Hubstaff, tracker crashed, worked
-- offline, etc). Distinct from pab_day_disputes:
--   * carries image evidence (image_paths -> private 'time-adjustment-evidence' bucket)
--   * requestable for ANY past day, even before Hubstaff is uploaded
--   * approved_hours is a SET-semantics override applied at pay-calc time; this table
--     NEVER mutates hubstaff_hours -- the hours are only substituted during calculation.
--
-- Run once against Supabase. Also create a PRIVATE storage bucket named
-- 'time-adjustment-evidence' (Dashboard -> Storage -> New bucket, public = off).

create table if not exists public.time_adjustment_requests (
  id              uuid primary key default gen_random_uuid(),
  work_email      text not null,
  adjust_date     date not null,                  -- the day being corrected
  reason          text not null,                  -- reason code (see TIME_ADJUSTMENT_REASONS)
  explanation     text,                           -- employee's paragraph
  requested_hours numeric,                        -- employee's claimed correct total (nullable)
  image_paths     text[] not null default '{}',   -- storage object paths (max 5, enforced in app)
  status          text not null default 'pending',-- pending | approved | denied
  approved_hours  numeric,                         -- accounting-set hours; SET-semantics override
  decided_by      text,
  decided_at      timestamptz,
  decision_note   text,
  period_label    text,                            -- payroll cycle stamp at creation (carry-over visibility)
  created_at      timestamptz not null default now(),
  created_by      text,
  updated_at      timestamptz not null default now()
);

-- One open/decided request per (employee, day). Re-requests reuse the row via upsert
-- semantics in the app layer; this guards against accidental duplicates.
create unique index if not exists time_adjustment_requests_email_date_key
  on public.time_adjustment_requests (work_email, adjust_date);

create index if not exists time_adjustment_requests_work_email_idx
  on public.time_adjustment_requests (work_email);
create index if not exists time_adjustment_requests_status_idx
  on public.time_adjustment_requests (status);
create index if not exists time_adjustment_requests_adjust_date_idx
  on public.time_adjustment_requests (adjust_date);
