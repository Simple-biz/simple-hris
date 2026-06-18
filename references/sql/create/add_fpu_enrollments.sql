-- Financial Peace University enrollment submissions from the employee app.
-- Each row is one signup; an employee may re-submit for a later cohort.
create table if not exists public.fpu_enrollments (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  full_name text not null,
  department text not null,
  shift_schedule_est text not null,
  created_at timestamptz not null default now()
);

create index if not exists fpu_enrollments_email_idx on public.fpu_enrollments (email);
create index if not exists fpu_enrollments_created_idx on public.fpu_enrollments (created_at desc);
