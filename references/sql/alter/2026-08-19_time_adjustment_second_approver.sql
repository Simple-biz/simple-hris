-- Time adjustments: dynamic second approver (dual approval).
-- Run after add_manager_approval_to_time_adjustments.sql.
--
-- Approval becomes TWO independent sign-offs that can land in either order:
--   * the department manager (existing manager_* columns)
--   * a second approver the manager names per request (the columns below)
--
-- `status` stays the single derived state and still has NO CHECK constraint, so
-- the new 'awaiting_second_approval' value needs no constraint change:
--   pending                    -- manager has not decided yet
--   awaiting_second_approval   -- manager approved; the named second approver has not
--   manager_approved           -- BOTH approved; Accounting can act
--   manager_denied             -- EITHER party denied (terminal, blocks the adjustment)
--   approved | denied          -- Accounting's final decision (unchanged)
--
-- manager_decision is backfilled from the existing status so pre-existing rows keep
-- deriving the same state: every row already at manager_approved was manager-approved,
-- and every row at manager_denied was manager-denied. Rows still pending stay null.

alter table public.time_adjustment_requests
  -- Who the manager named as the second approver, and who named them.
  add column if not exists second_approver_email       text,
  add column if not exists second_approver_assigned_by text,
  add column if not exists second_approver_assigned_at timestamptz,
  -- The second approver's own sign-off.
  add column if not exists second_decision       text,
  add column if not exists second_decided_by     text,
  add column if not exists second_decided_at     timestamptz,
  add column if not exists second_decision_note  text,
  -- The manager's sign-off as an explicit value. Previously it was implied by
  -- `status`, which no longer works: the second approver can decide first, so
  -- status alone can't say whether the manager has acted.
  add column if not exists manager_decision      text;

-- Only ever 'approved' or 'denied' (or null = has not decided). Unlike `status`,
-- these are written from exactly one code path each, so a CHECK is safe here and
-- makes an illegal decision value unrepresentable.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'time_adjustment_requests_second_decision_check'
  ) then
    alter table public.time_adjustment_requests
      add constraint time_adjustment_requests_second_decision_check
      check (second_decision is null or second_decision in ('approved', 'denied'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'time_adjustment_requests_manager_decision_check'
  ) then
    alter table public.time_adjustment_requests
      add constraint time_adjustment_requests_manager_decision_check
      check (manager_decision is null or manager_decision in ('approved', 'denied'));
  end if;
end $$;

-- Backfill manager_decision for rows decided before this migration, so the derived
-- status of a legacy row is unchanged. Rows whose manager_decision is already set
-- are left alone (idempotent re-run).
update public.time_adjustment_requests
   set manager_decision = 'approved'
 where manager_decision is null
   and status in ('manager_approved', 'approved', 'denied');

update public.time_adjustment_requests
   set manager_decision = 'denied'
 where manager_decision is null
   and status = 'manager_denied';

-- The second approver's queue is "rows naming me that I have not decided", which is
-- a lookup by email, not by status.
create index if not exists time_adjustment_requests_second_approver_idx
  on public.time_adjustment_requests (second_approver_email);

comment on column public.time_adjustment_requests.second_approver_email is
  'Second approver named by the manager for THIS request. Authorizes that person to '
  'decide this row even when the employee is outside their department — additive to '
  'the department check, never a replacement for it.';
comment on column public.time_adjustment_requests.manager_decision is
  'The manager''s sign-off (approved|denied|null). Explicit because the second approver '
  'may decide first, so `status` alone cannot say whether the manager has acted.';
