-- Time adjustments: a request FILED BY A MANAGER skips stage 1 (Kane, 2026-09-15:
-- "All Manager's just need one signature, and it comes from Accounting/Payroll only").
--
-- `stage1_waived_reason` is the persisted fact that lets `deriveAdjustmentStatus` send
-- such a row straight to `manager_approved` (= awaiting Accounting) with NO manager or
-- second-approver decision recorded. Without a column the waiver would have to be
-- re-derived from a roster lookup on every read, and `status` would stop being a pure
-- function of the row — the invariant every reader relies on.
--
-- Values: null (ordinary dual-approval row) | 'manager_filed'. CHECK-constrained so an
-- unknown reason is unrepresentable. `status` itself still has NO CHECK.
--
-- NO BEGIN/COMMIT here — the apply script owns the transaction (a COMMIT inside the
-- file would end it from within and make the "dry run" real; see
-- docs/features/gift-tracker-receipts.md, 2026-09-11).

alter table public.time_adjustment_requests
  add column if not exists stage1_waived_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'time_adjustment_requests_stage1_waived_reason_check'
  ) then
    alter table public.time_adjustment_requests
      add constraint time_adjustment_requests_stage1_waived_reason_check
      check (stage1_waived_reason is null or stage1_waived_reason in ('manager_filed'));
  end if;
end $$;

-- Backfill, OPEN rows only: a request filed by someone who holds an active
-- department_managers assignment is a manager's request and now belongs to Accounting.
-- Decided rows (approved / denied / manager_denied) are history and are left alone.
update public.time_adjustment_requests t
   set stage1_waived_reason = 'manager_filed',
       updated_at = now()
 where t.stage1_waived_reason is null
   and t.status in ('pending', 'awaiting_second_approval', 'manager_approved')
   and exists (
     select 1
       from public.department_managers d
      where d.revoked_at is null
        and lower(d.manager_email) = lower(t.work_email)
   );

-- A waived row derives to manager_approved regardless of stage-1 decisions, so the
-- stored status must agree or the "status is derived" invariant is broken on day one.
update public.time_adjustment_requests
   set status = 'manager_approved',
       updated_at = now()
 where stage1_waived_reason = 'manager_filed'
   and status in ('pending', 'awaiting_second_approval');

comment on column public.time_adjustment_requests.stage1_waived_reason is
  'Why stage 1 (manager + second approver) was skipped. ''manager_filed'' = the filer holds an '
  'active department_managers assignment, so the request goes straight to Accounting for ONE '
  'signature (Kane, 2026-09-15). Null = ordinary dual-approval row.';
