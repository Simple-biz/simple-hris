-- HR -> MESA -> FPU: Financial Peace University CLASSES with an enrollment window,
-- and the enrollment rows that hang off them.
-- ---------------------------------------------------------------------------
-- Kane, 2026-09-16: "Every year there are like 3 sessions of FPU Classes ...
-- create like an enrollment period where the User can set a period where people
-- can enroll and if they miss it they miss it ... unique identifiers per class
-- like batch 1 - 3 FPU class of year 2026."
--
-- A class is identified by (year, batch) and labelled "FPU 2026 - Batch 1".
-- Its enrollment window is opens_on..closes_on INCLUSIVE, compared as Manila
-- calendar dates. Eligibility (3 months of service) is measured against
-- class_starts_on, so the verdict is fixed for the whole window.
--
-- fpu_enrollments already existed (references/sql/create/add_fpu_enrollments.sql)
-- as a free-standing sign-up log with ONE prod row (a 2026-05-14 test). It gains
-- the class link and a review state. Legacy rows keep class_id NULL and are
-- shown nowhere.
--
-- Service-role only, like every other HR-facing table: the app reaches it
-- through gated routes, never from the browser.

create table if not exists public.fpu_classes (
  id              uuid primary key default gen_random_uuid(),
  year            integer     not null,
  batch           smallint    not null,
  -- Enrollment window, inclusive both ends. "If they miss it they miss it."
  opens_on        date        not null,
  closes_on       date        not null,
  -- The tenure cutoff AND the day the class meets first.
  class_starts_on date        not null,
  -- NULL = not announced yet. Default completion date for Mark completed.
  class_ends_on   date,
  -- Free text shown to the employee, e.g. "Thursdays 5:00 PM EST / Fridays 5:00 AM PHT".
  schedule_note   text,
  -- Optional cohort name HR gives the class (2026-09-16 follow-up). The label is
  -- the name when set, else "FPU <year> - Batch <batch>"; the code always shows.
  name            text,
  -- Early close (2026-09-17 follow-up): NULL = the window governs; a date means
  -- CLOSED from that day whatever opens_on/closes_on say. Reopening clears both.
  enrollment_closed_on date,
  enrollment_closed_by text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_by      text,
  updated_at      timestamptz not null default now(),

  constraint fpu_classes_year_batch_uniq unique (year, batch),
  constraint fpu_classes_year_sane   check (year between 2000 and 2100),
  constraint fpu_classes_batch_sane  check (batch between 1 and 12),
  constraint fpu_classes_window_ordered check (closes_on >= opens_on),
  constraint fpu_classes_class_ordered  check (class_ends_on is null or class_ends_on >= class_starts_on),
  constraint fpu_classes_name_len       check (name is null or (length(btrim(name)) between 1 and 80)),
  constraint fpu_classes_closed_pair
    check ((enrollment_closed_on is null) = (enrollment_closed_by is null))
);

comment on table public.fpu_classes is
  'FPU classes: one row per (year, batch) with an inclusive enrollment window. Eligibility is measured at class_starts_on. HR -> MESA -> FPU.';

create or replace function public.fpu_classes_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists fpu_classes_touch_trg on public.fpu_classes;
create trigger fpu_classes_touch_trg
  before update on public.fpu_classes
  for each row execute function public.fpu_classes_touch();

alter table public.fpu_classes enable row level security;

-- ---------------------------------------------------------------------------
-- fpu_enrollments: link each sign-up to a class and give it a review state.

alter table public.fpu_enrollments
  add column if not exists class_id        uuid references public.fpu_classes(id) on delete restrict,
  add column if not exists status          text not null default 'pending',
  -- The roster Start Date the eligibility verdict was computed from, as parsed
  -- at submission. Kept so a later roster edit cannot silently change what HR
  -- is looking at.
  add column if not exists start_date_used date,
  add column if not exists reviewed_by     text,
  add column if not exists reviewed_at     timestamptz,
  add column if not exists review_notes    text,
  -- Stamped by Mark completed; the same value goes to
  -- employee_hourly_rates.mesa_fpu_completed_on and to mesa_member_since.
  add column if not exists completed_on    date;

alter table public.fpu_enrollments
  drop constraint if exists fpu_enrollments_status_check;
alter table public.fpu_enrollments
  add constraint fpu_enrollments_status_check
    check (status in ('pending', 'approved', 'denied', 'completed'));

-- One enrollment per person per class. Case-insensitive on the email.
create unique index if not exists fpu_enrollments_class_email_uniq
  on public.fpu_enrollments (class_id, lower(email))
  where class_id is not null;

create index if not exists fpu_enrollments_class_status_idx
  on public.fpu_enrollments (class_id, status);

comment on column public.fpu_enrollments.status is
  'pending (submitted) -> approved (a seat in the class) | denied -> completed (FPU date stamped, MESA enrolled)';

alter table public.fpu_enrollments enable row level security;
