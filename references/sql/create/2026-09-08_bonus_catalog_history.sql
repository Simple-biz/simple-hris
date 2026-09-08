-- Bonus Library versioning + change history (2026-09-08).
--
-- Every bonus definition carries a version number and the date its current
-- version takes effect. Each saved version is snapshotted into
-- bonus_catalog_bonus_history (one row per version, UNIQUE per bonus), and every
-- assignment change (added / removed / exclusions / shared-team) lands in
-- bonus_catalog_assignment_history. Both are DISPLAY + AUDIT only: the KPI
-- Calculator keeps reading the live definition and bonus_catalog_applied keeps
-- its own apply-time snapshot (docs/features/bonus-catalog.md §7-8).
--
-- The app writes history rows from the save route (src/lib/supabase/
-- bonus-catalog-db.ts), mirroring syncRateHistory for Pay Structures — there is
-- deliberately no trigger, so a version is written only when a TRACKED field
-- changed (a star toggle writes nothing).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, NOT EXISTS
-- guarded backfill. Touches no existing row values: bonus_catalog_bonuses is not
-- UPDATEd (the touch trigger would bump updated_at on every bonus), so a NULL
-- effective_from is read as created_at::date by the app.

-- ── Version + effective date on the live definition ──────────────────────────
alter table public.bonus_catalog_bonuses
  add column if not exists version integer not null default 1;
alter table public.bonus_catalog_bonuses
  add column if not exists effective_from date;

-- ── One row per saved version of a bonus ──────────────────────────────────────
create table if not exists public.bonus_catalog_bonus_history (
  id              bigserial    primary key,
  bonus_id        text         not null references public.bonus_catalog_bonuses(id) on delete cascade,
  version         integer      not null,
  name            text         not null,
  description     text,
  kind            text         not null check (kind in ('flat','formula')),
  amount          numeric(14,2),
  formula         text,
  currency        text         not null default 'PHP',
  cadence         text         not null default 'weekly',
  -- Which tracked fields differ from the previous version ('{}' for v1).
  changed_fields  text[]       not null default '{}',
  effective_from  date         not null,
  -- 'created' | 'edited' | 'baseline' (backfilled by this migration).
  note            text,
  created_by      text,
  created_at      timestamptz  not null default now(),
  unique (bonus_id, version)
);

create index if not exists bonus_catalog_bonus_history_bonus_idx
  on public.bonus_catalog_bonus_history (bonus_id, version desc);

-- ── One row per assignment change ────────────────────────────────────────────
create table if not exists public.bonus_catalog_assignment_history (
  id               bigserial    primary key,
  bonus_id         text         not null references public.bonus_catalog_bonuses(id) on delete cascade,
  assignment_id    text         not null,
  event            text         not null check (event in ('added','removed','exclusions_changed','shared_team_changed')),
  scope            text         not null check (scope in ('department','employee')),
  department_key   text         not null,
  employee_email   text,
  employee_name    text,
  excluded_before  text[]       not null default '{}',
  excluded_after   text[]       not null default '{}',
  shared_team      boolean,
  effective_from   date         not null,
  -- 'baseline' for rows backfilled by this migration, NULL otherwise.
  note             text,
  created_by       text,
  created_at       timestamptz  not null default now()
);

create index if not exists bonus_catalog_assignment_history_bonus_idx
  on public.bonus_catalog_assignment_history (bonus_id, created_at desc);
create index if not exists bonus_catalog_assignment_history_assignment_idx
  on public.bonus_catalog_assignment_history (assignment_id);

-- ── Baseline backfill ────────────────────────────────────────────────────────
-- v1 for every existing bonus, effective the day it was created, so every card
-- has a history from day one. Re-runs are no-ops.
insert into public.bonus_catalog_bonus_history
  (bonus_id, version, name, description, kind, amount, formula, currency, cadence,
   changed_fields, effective_from, note, created_by, created_at)
select
  b.id, coalesce(b.version, 1), b.name, b.description, b.kind, b.amount, b.formula,
  coalesce(b.currency, 'PHP'), coalesce(b.cadence, 'weekly'),
  '{}'::text[], coalesce(b.effective_from, b.created_at::date), 'baseline',
  coalesce(b.created_by, 'migrated'), b.created_at
from public.bonus_catalog_bonuses b
where not exists (
  select 1 from public.bonus_catalog_bonus_history h where h.bonus_id = b.id
);

-- One 'added' event per existing assignment, dated when it was created.
insert into public.bonus_catalog_assignment_history
  (bonus_id, assignment_id, event, scope, department_key, employee_email, employee_name,
   excluded_before, excluded_after, shared_team, effective_from, note, created_by, created_at)
select
  a.bonus_id, a.id, 'added', a.scope, a.department_key, a.employee_email, a.employee_name,
  '{}'::text[], coalesce(a.excluded_emails, '{}'::text[]), a.shared_team,
  a.created_at::date, 'baseline', coalesce(a.created_by, 'migrated'), a.created_at
from public.bonus_catalog_assignments a
where not exists (
  select 1 from public.bonus_catalog_assignment_history h
  where h.assignment_id = a.id and h.event = 'added'
);
