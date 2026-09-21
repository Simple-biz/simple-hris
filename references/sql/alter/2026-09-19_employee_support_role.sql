-- Widen employee_roles.role to allow `employee_support` — the new role that
-- unlocks the Employee Support live-chat tabs at /tickets for Carla, Claire,
-- Ainsley, Grace and Alivia.
--
-- Kane, 2026-09-19 (Q3 of the live-chat brief): "a new employee_support role +
-- FeatureViewKey, hosted at /tickets as its own tabs. Not a feature key under
-- the tickets view." Plan:
-- docs/superpowers/plans/2026-09-19-employee-support-chat.md
--
-- The role grants the support tabs and NOTHING else. A holder must not reach
-- Overview / Board / Archived, by click or by typed URL — Carla signed "the
-- support team only sees support questions". That gating is
-- src/lib/rbac/view-tabs.ts's job; this file only makes the value storable.
--
--
-- ############################################################################
-- #  THE LIST BELOW IS RECONSTRUCTED FROM THE REPO, NOT MEASURED FROM THE DB #
-- ############################################################################
--
-- Kane has said "let us stay in local for now": .env.local holds only
-- .env.example placeholders, so NOTHING in this file was verified against the
-- live constraint. `expected` is what the repo's own migration history says the
-- live constraint should contain, assembled by reading every file that touches
-- `employee_roles_role_check` in git-add order:
--
--   2026-06-18  ab6d1505  seed/grant_manager_roles.sql:25-34
--                         viewer, hr_coordinator, payroll_coordinator,
--                         payroll_manager, finance, admin, manager
--   2026-06-18  ab6d1505  alter/employee_roles_widen_role_check_orphanage_manager.sql:8-18
--                         + orphanage_manager
--   2026-06-18  ab6d1505  create/announcements_and_ceo_role.sql:38-50
--                         + ceo
--   2026-06-18  26a5f6b5  migrate/2026-06-18_roles_dashboard_only.sql:26-36
--                         THE RESET. Adds accounting + contractor and demotes
--                         viewer / payroll_coordinator / payroll_manager /
--                         finance to "legacy (history only)" — they stay IN the
--                         constraint because old rows still carry them.
--   2026-06-26  0f2f293d  migrate/2026-06-26_qc_role_and_tables.sql:26-33   + qc
--   2026-07-15  7c7cb5c5  migrate/2026-07-15_tickets_kanban.sql:29-36       + tickets
--
-- Cross-checked against what the application actually inserts: VALID_ROLES in
-- app/api/employee-roles/route.ts:15-25 is the only writer, and every one of its
-- nine values (hr_coordinator, accounting, admin, manager, orphanage_manager,
-- contractor, ceo, qc, tickets) appears below. The four legacy values are in the
-- constraint and NOT in VALID_ROLES, which is correct: they are assignable by
-- nobody and still readable on revoked rows.
--
-- RE-VERIFY BEFORE --apply. One line, in the Supabase SQL editor:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'employee_roles_role_check';
--
--
-- WHY A PARTIAL LIST CANNOT SHIP FROM THIS FILE
-- ---------------------------------------------------------------------------
-- Restating a SUBSET of a CHECK list silently breaks every omitted value's
-- INSERT, and the breakage shows up weeks later as "assigning QC returns 500".
-- The usual defence is care. Care is not a defence, so this file does not rely
-- on it:
--
--   1. It READS the live constraint first and parses out the values it already
--      allows. That set is the floor.
--   2. The constraint it writes is  live ∪ expected ∪ added  — a union, never a
--      replacement. A value this file's `expected` list forgot is still in
--      `live`, so it survives. THE ONLY THING THIS FILE CAN DO IS WIDEN.
--   3. If the live constraint is ABSENT it raises instead of inventing one: with
--      no measurable floor, an ADD CONSTRAINT built from a stale list is exactly
--      the accident being prevented.
--   4. If the live constraint's SHAPE is not the `role = ANY (ARRAY[...])` that
--      an IN-list compiles to, or any parsed value is not a bare slug, it raises
--      rather than guessing — a mis-parse would silently drop values.
--   5. Drift is REPORTED, both ways: a value live-but-not-expected means this
--      header is out of date (it is kept anyway); a value expected-but-not-live
--      means an earlier widen never ran.
--
-- RE-RUNNABLE, AND UNABLE TO STRIP A VALUE ON A RE-RUN
-- ---------------------------------------------------------------------------
-- references/sql/create/2026-09-16_fpu_classes.sql's family taught this the hard
-- way: a migration that DROPs a CHECK and re-ADDs a hardcoded list will strip
-- whatever was added in between, every time it is re-run. This one computes the
-- new list from the live one BEFORE dropping anything, and when the computed
-- list already equals the live one it does not drop the constraint at all — the
-- second run is a NOTICE and nothing else.
--
-- No BEGIN/COMMIT: the apply script
-- (scripts/apply-employee-support-chat-migration.mts) owns the transaction, so a
-- failure anywhere in the migration rolls this back with everything else and the
-- constraint is never left dropped.

do $widen$
declare
  -- The FULL authoritative list as reconstructed above. NOT the source of truth
  -- on its own — see the union in step 2.
  expected constant text[] := array[
    -- assignable today (VALID_ROLES, app/api/employee-roles/route.ts:15-25)
    'admin',
    'ceo',
    'hr_coordinator',
    'accounting',
    'manager',
    'orphanage_manager',
    'contractor',
    'qc',
    'tickets',
    -- legacy: history only, not assignable in the app since 2026-06-18
    'finance',
    'payroll_coordinator',
    'payroll_manager',
    'viewer'
  ];

  -- What this migration is actually for.
  added constant text[] := array['employee_support'];

  def     text;
  live    text[];
  final   text[];
  drift   text[];
  bad     text;
begin
  if to_regclass('public.employee_roles') is null then
    raise exception 'public.employee_roles does not exist — nothing to widen.';
  end if;

  select pg_get_constraintdef(c.oid)
    into def
    from pg_constraint c
   where c.conrelid = 'public.employee_roles'::regclass
     and c.conname  = 'employee_roles_role_check';

  -- (3) No floor, no widen.
  if def is null then
    raise exception
      'employee_roles_role_check is MISSING. Refusing to create it from a reconstructed list — read the live constraint, correct the `expected` array in this file, and re-run. (%)',
      'references/sql/alter/2026-09-19_employee_support_role.sql';
  end if;

  -- (4) Shape guard. An IN-list compiles to `= ANY (ARRAY[...])`; anything else
  -- means somebody rewrote this constraint and the parse below would be wrong.
  if def !~ '= ANY \(ARRAY\[' then
    raise exception
      'employee_roles_role_check is not the expected `role = ANY (ARRAY[...])` shape. Live definition: %',
      def;
  end if;

  -- (1) The floor: every value the live constraint already allows.
  select array_agg(distinct m.parts[1])
    into live
    from regexp_matches(def, $re$'([^']*)'$re$, 'g') as m(parts);

  -- (4, continued) Every role is a bare slug. A value that is not one means the
  -- parse caught something that is not a role — an escaped quote, or an array
  -- literal rendered as one string — and dropping values on the strength of a
  -- bad parse is the accident this file exists to prevent.
  select v into bad from unnest(live) v where v !~ '^[a-z][a-z0-9_]*$' limit 1;
  if bad is not null then
    raise exception
      'Parsed % out of employee_roles_role_check, which is not a role slug. Definition: %',
      quote_literal(bad), def;
  end if;

  -- (5) Drift, reported both ways and never acted on by narrowing.
  select array_agg(v) into drift from unnest(live) v where not (v = any (expected));
  if drift is not null then
    raise notice
      'employee_roles_role_check allows % which this file did not expect. KEPT — update the header of references/sql/alter/2026-09-19_employee_support_role.sql.',
      drift;
  end if;

  select array_agg(v) into drift from unnest(expected) v where not (v = any (live));
  if drift is not null then
    raise notice
      'This file expected % which the live constraint does NOT allow — an earlier widen never ran. Adding them.',
      drift;
  end if;

  -- (2) The union. The only possible outcome is a wider constraint.
  select array_agg(v order by v)
    into final
    from (select distinct unnest(live || expected || added) as v) s;

  -- Re-runnability: nothing to change, so nothing is dropped.
  if final <@ live and live <@ final then
    raise notice
      'employee_roles_role_check already allows all % values including %. No change.',
      array_length(final, 1), added;
    return;
  end if;

  execute 'alter table public.employee_roles drop constraint employee_roles_role_check';
  execute format(
    'alter table public.employee_roles add constraint employee_roles_role_check check (role in (%s))',
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(final) v)
  );

  raise notice 'employee_roles_role_check now allows % values: %', array_length(final, 1), final;
end
$widen$;

-- VERIFY — `employee_support` must appear in the live definition:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'employee_roles_role_check';
