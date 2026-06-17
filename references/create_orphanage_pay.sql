-- Orphanage pay — locked-in per-employee orphanage hours & pay, by pay period.
--
-- The Payroll Wizard's Orphanage step is a paste tool: it matches each pasted
-- "Pay week / Work email / Hours" row to an employee and values it at
-- hours × their rate, stacking on worked hours against the 40h/week regular cap
-- so the portion over 40 pays at the OT rate. "Lock in values" writes the result
-- into the per-employee Orphanage column (orphanageAmounts, persisted in the
-- app_settings `payroll.wizard.additions.<source_file>` blob) AND upserts a
-- first-class record here so orphanage pay is queryable / reportable / auditable
-- like the other payroll artifacts (bonus_catalog_applied, disbursement_records).
--
-- Period identity = the Hubstaff upload filename (`source_file`) — the same
-- per-week key the rest of the wizard scopes to. One row per
-- (source_file, employee_email); re-pasting a person overwrites their row
-- (latest lock-in wins). The table ACCUMULATES across pastes within a period —
-- a person not in the latest batch keeps their existing row.
--
-- Idempotent: safe to re-run.

create table if not exists public.orphanage_pay (
  source_file       text          not null,            -- Hubstaff upload filename = pay period
  employee_email    text          not null,            -- the wizard row's email (lower-cased on write)
  employee_name     text,
  pay_week          text,                              -- informational label pasted by the user
  hours             numeric(12,4) not null default 0,  -- total pasted orphanage hours
  reg_hours         numeric(12,4) not null default 0,  -- portion paid at the regular rate
  ot_hours          numeric(12,4) not null default 0,  -- portion that crossed into overtime (>40h/week)
  regular_rate_php  numeric(14,4),
  ot_rate_php       numeric(14,4),
  amount_php        numeric(14,2) not null default 0,  -- reg_hours*reg_rate + ot_hours*ot_rate
  locked_by         text,
  locked_at         timestamptz   not null default now(),
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  primary key (source_file, employee_email)
);

create index if not exists orphanage_pay_source_file_idx on public.orphanage_pay (source_file);
create index if not exists orphanage_pay_email_idx on public.orphanage_pay (lower(employee_email));

-- ── Touch trigger: bump updated_at; keep created_at immutable ─────────────────
create or replace function public.orphanage_pay_touch() returns trigger as $$
begin
  new.updated_at = now();
  if (tg_op = 'UPDATE') then
    new.created_at = old.created_at;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists orphanage_pay_touch on public.orphanage_pay;
create trigger orphanage_pay_touch
  before insert or update on public.orphanage_pay
  for each row execute function public.orphanage_pay_touch();

-- Lower-case the employee email on write so per-person lookups stay consistent
-- (mirrors bonus_catalog_applied). No-op if the shared helper isn't installed.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'normalize_email_column') then
    drop trigger if exists orphanage_pay_normalize_email on public.orphanage_pay;
    create trigger orphanage_pay_normalize_email
      before insert or update on public.orphanage_pay
      for each row execute function public.normalize_email_column('employee_email');
  end if;
end$$;

-- ── Expose to Realtime so locked-in orphanage pay updates live across users ───
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.orphanage_pay;
    exception when duplicate_object then null;
    end;
  end if;
end$$;

-- Verification:
-- select source_file, count(*), sum(amount_php), sum(ot_hours)
-- from public.orphanage_pay group by 1 order by 1 desc;
