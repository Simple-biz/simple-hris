-- Orphanage Management System (OMS) saves — what OMS said, and what the HRIS made of it.
--
-- Payroll Wizard → Orphanage step → "Orphanage Management System" tab → Save.
-- One row per OMS row per save. A save is a SNAPSHOT: `save_id` groups the rows,
-- and the table is APPEND-ONLY — no UPDATE, no DELETE path exists in the app
-- (Kane, 2026-09-16: append-only snapshots, never a replace). The panel shows the
-- latest save for the week and diffs the current pull against it.
--
-- Each row carries BOTH the raw OMS values (oms_*) and the HRIS resolution at the
-- moment of saving (matched → employee key, reg/OT split, rates, amount; unmatched →
-- skip_reason), so a saved pull reads back without re-resolving.
--
-- THIS TABLE IS NOT MONEY. Nothing prices, dispatches or prints a paystub from it.
-- The paying carriers stay the additions blob and `orphanage_pay`
-- (docs/features/orphanage-pay-step.md § Two carriers). A Save is allowed in TEST
-- mode precisely because it touches neither.
--
-- Idempotent: safe to re-run. Apply with
--   node --import tsx scripts/apply-orphanage-oms-hours-migration.mts --apply

create table if not exists public.orphanage_oms_hours (
  id                 bigint generated always as identity primary key,
  save_id            uuid          not null,
  week_start         date          not null,                     -- the pay period's Sunday
  source_file        text,                                       -- the wizard's Hubstaff upload, when known
  mode               text          not null,                     -- the TEST/LIVE switch at save time
  saved_by           text          not null,
  saved_at           timestamptz   not null default now(),

  -- raw, as OMS returned it
  oms_email          text          not null,
  oms_pay_week       text,
  oms_hours_raw      text          not null,
  oms_hours          numeric(12,4),                              -- null when the raw value did not parse

  -- the HRIS resolution at save time
  matched            boolean       not null,
  employee_email     text,                                       -- the Additions row key (null when unmatched)
  employee_name      text,
  reg_hours          numeric(12,4),
  ot_hours           numeric(12,4),
  regular_rate_php   numeric(14,4),
  ot_rate_php        numeric(14,4),
  amount_php         numeric(14,2),
  skip_reason        text,                                       -- null when matched

  -- the pull's own facts, repeated per row so a save reads back whole
  approved_count     integer,
  latest_updated_at  timestamptz,
  truncated          boolean       not null default false,

  created_at         timestamptz   not null default now(),

  constraint orphanage_oms_hours_mode_check
    check (mode in ('test', 'live')),
  constraint orphanage_oms_hours_saved_by_present
    check (btrim(saved_by) <> ''),
  constraint orphanage_oms_hours_oms_email_present
    check (btrim(oms_email) <> ''),
  -- matched rows carry a key and an amount and no reason; unmatched rows carry a
  -- reason and no key. Nothing in between is representable.
  constraint orphanage_oms_hours_resolution_shape
    check (
      (matched and employee_email is not null and amount_php is not null and skip_reason is null)
      or (not matched and skip_reason is not null and employee_email is null and amount_php is null)
    )
);

comment on table public.orphanage_oms_hours is
  'OMS saves: what the Orphanage Management System said for a pay week and what the HRIS resolved it to at save time. APPEND-ONLY snapshots grouped by save_id. NOT MONEY — NEVER read by pricing, dispatch or paystubs; the paying carriers are the additions blob and orphanage_pay.';
comment on column public.orphanage_oms_hours.save_id is 'One Save click = one save_id across its rows.';
comment on column public.orphanage_oms_hours.mode is 'The TEST/LIVE switch at save time. A save in either mode writes only this table.';
comment on column public.orphanage_oms_hours.skip_reason is 'Why the HRIS did not resolve this OMS row (unmatched, duplicate, unpriceable). Null when matched.';

create index if not exists orphanage_oms_hours_week_saved_idx
  on public.orphanage_oms_hours (week_start, saved_at desc);
create index if not exists orphanage_oms_hours_save_id_idx
  on public.orphanage_oms_hours (save_id);
create index if not exists orphanage_oms_hours_oms_email_idx
  on public.orphanage_oms_hours (lower(oms_email));

-- Lower-case + trim the two email columns on write so per-person lookups agree.
create or replace function public.orphanage_oms_hours_normalize() returns trigger as $$
begin
  new.oms_email = lower(btrim(new.oms_email));
  if new.employee_email is not null then
    new.employee_email = lower(btrim(new.employee_email));
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_orphanage_oms_hours_normalize on public.orphanage_oms_hours;
create trigger trg_orphanage_oms_hours_normalize
  before insert or update on public.orphanage_oms_hours
  for each row execute function public.orphanage_oms_hours_normalize();

-- Rows name workers and hours, and NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the
-- client bundle. RLS on with NO policies: only the service-role server route reads
-- or writes.
alter table public.orphanage_oms_hours enable row level security;

-- Verification:
--   select save_id, week_start, mode, saved_by, saved_at, count(*) filter (where matched) as matched,
--          count(*) filter (where not matched) as skipped, sum(amount_php) as total_php
--     from public.orphanage_oms_hours group by 1,2,3,4,5 order by saved_at desc limit 20;
