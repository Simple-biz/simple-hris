-- Common-bonus exclusions: a department-scoped ("common") bonus assignment can
-- now exclude specific department members so they do NOT receive it. Empty array
-- = applies to everyone (the existing behaviour).
--
-- Idempotent: safe to re-run.

alter table public.bonus_catalog_assignments
  add column if not exists excluded_emails text[] not null default '{}';

-- Team-effort common bonuses: when true the bonus is entered ONCE for the whole
-- department and every (non-excluded) member receives the result.
alter table public.bonus_catalog_assignments
  add column if not exists shared_team boolean not null default false;

-- Preserve creator/created_at when an assignment row is UPDATED (exclusion edits
-- upsert the same id). Mirrors the bonus table's touch trigger.
create or replace function public.bonus_catalog_assignment_touch() returns trigger as $$
begin
  if (tg_op = 'UPDATE') then
    new.created_by = old.created_by;
    new.created_at = old.created_at;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists bonus_catalog_assignments_touch on public.bonus_catalog_assignments;
create trigger bonus_catalog_assignments_touch
  before update on public.bonus_catalog_assignments
  for each row execute function public.bonus_catalog_assignment_touch();

-- Verification:
-- select id, scope, department_key, excluded_emails
-- from public.bonus_catalog_assignments where scope = 'department';
