-- Leave filing: employees submit; department managers approve (app resolves manager by department).
-- Run in Supabase SQL editor. Adjust schema if you use a custom table prefix.

create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_email text not null,
  employee_name text,
  department text,
  start_date date not null,
  end_date date not null,
  leave_type text not null,
  reason text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  manager_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approver_email text,
  approver_note text
);

create index if not exists leave_requests_employee_email_idx on public.leave_requests (employee_email);
create index if not exists leave_requests_status_idx on public.leave_requests (status);
create index if not exists leave_requests_created_at_idx on public.leave_requests (created_at desc);

comment on table public.leave_requests is 'Employee leave requests; managers approve via HRIS.';

-- Optional RLS (service role bypasses). For anon, deny by default:
-- alter table public.leave_requests enable row level security;
