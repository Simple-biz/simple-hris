-- Department transfer requests. A manager asks HR to move an employee from one
-- department to another; HR approves or rejects. On approval the app updates the
-- employee's Department on their global_master_list row (see
-- src/lib/supabase/department-transfer-requests.ts applyDepartmentTransfer).
--
-- NOTE: global_master_list is also refreshed from the Google Sheet via the manual
-- "Sync from Google Sheet" buttons, where (Personal Email, Department) is the row
-- identity key. An approved transfer changes Department in Supabase immediately,
-- but the next sheet sync will reflect the OLD department unless HR also updates
-- the sheet. The HR approval UI surfaces this reminder.
create table if not exists public.department_transfer_requests (
  id                      uuid         primary key default gen_random_uuid(),
  employee_email          text         not null,            -- best identifying email (personal preferred)
  employee_name           text,
  employee_work_email     text,
  employee_personal_email text,
  from_department         text         not null,
  to_department           text         not null,
  reason                  text,
  status                  text         not null default 'pending'
                            check (status in ('pending','approved','rejected','cancelled')),
  requested_by            text         not null,            -- manager email
  approver_email          text,
  approver_note           text,
  decided_at              timestamptz,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

create index if not exists department_transfer_requests_status_idx
  on public.department_transfer_requests (status, created_at desc);

create index if not exists department_transfer_requests_requested_by_idx
  on public.department_transfer_requests (lower(requested_by));

create index if not exists department_transfer_requests_from_dept_idx
  on public.department_transfer_requests (lower(from_department));
