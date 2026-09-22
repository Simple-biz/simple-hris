-- Widen employee_notifications.type to allow the Gift Tracker submission alert:
--
--   gift_shipping.submitted   somebody filled in or updated their tenure-gift
--                             delivery details — through the public
--                             /update-gift-address link, through the Employee
--                             dashboard card, or entered by staff. ONE type for
--                             all three channels: the recipients are the same
--                             people and the channel is a detail on the row, not
--                             a different piece of news.
--
-- Kane, 2026-09-22 (Q3/Q4 of the "Recently filled / updated" brief). Plan:
-- docs/superpowers/plans/2026-09-22-gift-recent-submissions.md — task 1.
--
-- Maps to ['hr'] in src/lib/notifications/notification-views.ts. An unmapped
-- type has no dashboard badge and is effectively invisible, so that module and
-- this file are changed together.
--
-- UNTIL THIS RUNS THE NOTIFICATION IS DEAD: every gift_shipping.submitted insert
-- is rejected by this constraint, and a CHECK rejection looks IDENTICAL to "no
-- submissions arrived". `kpi.scored` shipped exactly that way for three days and
-- `pab.excluded`/`pab.restored` for seventeen. The call site routes its failure
-- through src/lib/notifications/notify-failure-audit.ts, so a missed DDL shows up
-- as a `notification.insert_failed` row in audit_log rather than as silence.
--
--
-- ############################################################################
-- #  THE LIST BELOW IS RECONSTRUCTED FROM THE REPO, NOT MEASURED FROM THE DB #
-- ############################################################################
--
-- `expected` is the list from the most recent full restatement in git order —
--
--   2026-09-19  alter/2026-09-19_add_chat_notification_types.sql:95-145
--
-- — plus the two types that file added. Cross-checked against
-- NOTIFICATION_TYPE_TO_VIEWS in src/lib/notifications/notification-views.ts.
-- It is NOT the source of truth on its own; the union in step 2 is.
--
-- RE-VERIFY BEFORE --apply. One line, in the Supabase SQL editor:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'employee_notifications_type_check';
--
--
-- WHY A PARTIAL LIST CANNOT SHIP FROM THIS FILE
-- ---------------------------------------------------------------------------
-- Restating a SUBSET of a CHECK list silently breaks every omitted value's
-- INSERT, each failing at the one moment it was supposed to tell somebody
-- something. The usual defence is care. Care is not a defence, so this file does
-- not rely on it — it is the same shape as its predecessor:
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
--   5. Drift is REPORTED, both ways, and never acted on by narrowing.
--
-- Order-independent with any other widen written in this shape: neither can
-- strip the other's values.
--
-- No BEGIN/COMMIT: the apply script owns the transaction. A COMMIT inside the
-- file ends it from within, so the "dry run" would commit to production and the
-- script's ROLLBACK would have nothing to undo. That happened on 2026-09-11.

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
    'kpi.published',
    'support_chat.replied',
    'support_chat.became_ticket'
  ];

  -- What this migration is actually for.
  added constant text[] := array[
    'gift_shipping.submitted'
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
      'references/sql/alter/2026-09-22_add_gift_shipping_notification_type.sql';
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
  -- one means the parse caught something that is not a notification type, and
  -- dropping values on the strength of a bad parse is the accident this file
  -- prevents.
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
      'employee_notifications_type_check allows % which this file did not expect. KEPT — update the header of references/sql/alter/2026-09-22_add_gift_shipping_notification_type.sql.',
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

-- VERIFY — the new type must appear in the live definition:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'employee_notifications_type_check';
