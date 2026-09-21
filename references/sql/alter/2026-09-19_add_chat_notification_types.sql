-- Widen employee_notifications.type to allow the two Employee Support LIVE CHAT
-- notifications:
--
--   support_chat.replied        an agent answered in the employee's live chat.
--   support_chat.became_ticket  nobody picked the chat up, so it became an ES-
--                               ticket (Kane's Q1). This is the message that
--                               carries the number, and it is the only thing
--                               standing between an unanswered chat and an
--                               employee who thinks they were ignored.
--
-- Kane, 2026-09-19 (Q1 and Q2 of the live-chat brief). Plan:
-- docs/superpowers/plans/2026-09-19-employee-support-chat.md — task 16.
--
-- Both map to ['employee'] in src/lib/notifications/notification-views.ts. An
-- unmapped type has no dashboard badge and is effectively invisible, so that
-- module and this file are changed together.
--
-- UNTIL THIS RUNS THE NOTIFICATIONS ARE DEAD: every support_chat.* insert is
-- rejected by this constraint. `kpi.scored` shipped exactly that way for three
-- days in August — 0 rows written — because its call site only console.warn'd
-- the failure. Route the failure through notify-failure-audit so a missed DDL is
-- VISIBLE in audit_log rather than silent.
--
--
-- ############################################################################
-- #  THE LIST BELOW IS RECONSTRUCTED FROM THE REPO, NOT MEASURED FROM THE DB #
-- ############################################################################
--
-- Kane has said "let us stay in local for now": .env.local holds only
-- .env.example placeholders, so NOTHING here was verified against the live
-- constraint. `expected` is the list from the most recent full restatement in
-- git order —
--
--   2026-09-10  alter/2026-09-10_add_kpi_published_notification_type.sql:46-92
--
-- — which is itself the head of a chain of seventeen files that have restated
-- this constraint since 2026-06-18 (`grep -rl employee_notifications_type_check
-- references/sql/`). Cross-checked against NOTIFICATION_TYPE_TO_VIEWS in
-- src/lib/notifications/notification-views.ts:15-99: every type the application
-- maps to a dashboard appears below.
--
-- RE-VERIFY BEFORE --apply. One line, in the Supabase SQL editor:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'employee_notifications_type_check';
--
--
-- THE TICKET SIDE'S WIDEN IS STILL OWED, AND THIS FILE DOES NOT BLOCK IT
-- ---------------------------------------------------------------------------
-- The v1 plan's task 3 still owes
-- references/sql/alter/2026-09-16_add_support_notification_types.sql for
-- `support.replied` / `support.answered`. It is NOT folded in here: it belongs
-- to the ticket side and to whoever ships those routes.
--
-- Written in the same shape as this file, the two are ORDER-INDEPENDENT and
-- neither can strip the other's values — each one unions its additions onto
-- whatever the live constraint already allows. That is the whole point of the
-- shape, and it is why the instruction "restate the FULL list" is satisfied here
-- by an `expected` array that is checked against reality rather than trusted
-- instead of it.
--
--
-- WHY A PARTIAL LIST CANNOT SHIP FROM THIS FILE
-- ---------------------------------------------------------------------------
-- Restating a SUBSET of a CHECK list silently breaks every omitted value's
-- INSERT — forty-four notification flows, in this case, each failing at the one
-- moment it was supposed to tell somebody something. The usual defence is care.
-- Care is not a defence, so this file does not rely on it:
--
--   1. It READS the live constraint first and parses out the values it already
--      allows. That set is the floor.
--   2. The constraint it writes is  live ∪ expected ∪ added  — a union, never a
--      replacement. A value this file's `expected` list forgot is still in
--      `live`, so it survives. THE ONLY THING THIS FILE CAN DO IS WIDEN.
--   3. If the live constraint is ABSENT it raises instead of inventing one.
--   4. If the live constraint's SHAPE is not the `type = ANY (ARRAY[...])` that
--      an IN-list compiles to, or any parsed value is not a bare `family.event`
--      slug, it raises rather than guessing — a mis-parse would drop values.
--   5. Drift is REPORTED, both ways: a value live-but-not-expected means this
--      header is out of date (it is kept anyway); a value expected-but-not-live
--      means an earlier widen never ran.
--
-- RE-RUNNABLE, AND UNABLE TO STRIP A VALUE ON A RE-RUN
-- ---------------------------------------------------------------------------
-- The new list is computed from the live one BEFORE anything is dropped, and
-- when the computed list already equals the live one the constraint is not
-- dropped at all — the second run is a NOTICE and nothing else.
--
-- ADD CONSTRAINT re-validates every existing row. Because this file can only
-- widen, that scan cannot fail on data it did not already accept.
--
-- No BEGIN/COMMIT: the apply script
-- (scripts/apply-employee-support-chat-migration.mts) owns the transaction.

do $widen$
declare
  -- The FULL authoritative list as reconstructed above. NOT the source of truth
  -- on its own — see the union in step 2.
  expected constant text[] := array[
    'rate.change',
    'promotion',
    'dispute.approved',
    'dispute.denied',
    'dispute.revoked',
    'onboarding.submitted',
    'time_adjustment.approved',
    'time_adjustment.denied',
    'transfer.requested',
    'transfer.approved',
    'transfer.rejected',
    'transfer.release_requested',
    'transfer.released',
    'transfer.declined',
    'transfer.applied',
    'payroll.processing_started',
    'payroll.processing_stopped',
    'payroll.paid',
    'payroll.available',
    'payroll.hours_gap',
    'special_transfer.recorded',
    'qc.scores_submitted',
    'qc.scores_returned',
    'people.banking.self_updated',
    'people.banking.overridden',
    'bank_info.requested',
    'offboarding.requested',
    'offboarding.request_completed',
    'offboarding.request_dismissed',
    'offboarding.request_returned',
    'resignation.submitted',
    'resignation.approved',
    'resignation.rejected',
    'ticket.replied',
    'ticket.assigned',
    'documents.requested',
    'documents.signed',
    'documents.rejected',
    'bank_preferred.decided',
    'pab.excluded',
    'pab.restored',
    'kpi.scored',
    'ticket.moved',
    'kpi.published'
  ];

  -- What this migration is actually for.
  added constant text[] := array[
    'support_chat.replied',
    'support_chat.became_ticket'
  ];

  def     text;
  live    text[];
  final   text[];
  drift   text[];
  bad     text;
begin
  if to_regclass('public.employee_notifications') is null then
    raise exception 'public.employee_notifications does not exist — nothing to widen.';
  end if;

  select pg_get_constraintdef(c.oid)
    into def
    from pg_constraint c
   where c.conrelid = 'public.employee_notifications'::regclass
     and c.conname  = 'employee_notifications_type_check';

  -- (3) No floor, no widen.
  if def is null then
    raise exception
      'employee_notifications_type_check is MISSING. Refusing to create it from a reconstructed list — read the live constraint, correct the `expected` array in this file, and re-run. (%)',
      'references/sql/alter/2026-09-19_add_chat_notification_types.sql';
  end if;

  -- (4) Shape guard. An IN-list compiles to `= ANY (ARRAY[...])`; anything else
  -- means somebody rewrote this constraint and the parse below would be wrong.
  if def !~ '= ANY \(ARRAY\[' then
    raise exception
      'employee_notifications_type_check is not the expected `type = ANY (ARRAY[...])` shape. Live definition: %',
      def;
  end if;

  -- (1) The floor: every value the live constraint already allows.
  select array_agg(distinct m.parts[1])
    into live
    from regexp_matches(def, $re$'([^']*)'$re$, 'g') as m(parts);

  -- (4, continued) Every type is a bare `family.event` slug. A value that is not
  -- one means the parse caught something that is not a notification type — an
  -- escaped quote, or an array literal rendered as one string — and dropping
  -- values on the strength of a bad parse is the accident this file prevents.
  select v into bad from unnest(live) v where v !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' limit 1;
  if bad is not null then
    raise exception
      'Parsed % out of employee_notifications_type_check, which is not a notification type. Definition: %',
      quote_literal(bad), def;
  end if;

  -- (5) Drift, reported both ways and never acted on by narrowing.
  select array_agg(v) into drift from unnest(live) v where not (v = any (expected));
  if drift is not null then
    raise notice
      'employee_notifications_type_check allows % which this file did not expect. KEPT — update the header of references/sql/alter/2026-09-19_add_chat_notification_types.sql.',
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
      'employee_notifications_type_check already allows all % values including %. No change.',
      array_length(final, 1), added;
    return;
  end if;

  execute 'alter table public.employee_notifications drop constraint employee_notifications_type_check';
  execute format(
    'alter table public.employee_notifications add constraint employee_notifications_type_check check (type in (%s))',
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(final) v)
  );

  raise notice 'employee_notifications_type_check now allows % values: %', array_length(final, 1), final;
end
$widen$;

-- VERIFY — both new types must appear in the live definition:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'employee_notifications_type_check';
