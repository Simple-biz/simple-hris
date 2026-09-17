-- HR -> MESA -> FPU Classes: close enrollment EARLY, at any moment, without
-- rewriting the window HR planned.
-- ---------------------------------------------------------------------------
-- Kane, 2026-09-17: "lets add a button where we can close the enrollment period
-- at any time we want thisss would prohibit the Employees from enrolling to the
-- class."
--
-- Two columns rather than a rewrite of `closes_on`: the planned window is a
-- record ("we said enrollment runs to Sep 26") and an early close is a decision
-- someone made on a day ("we shut it on Sep 17"). Moving `closes_on` backwards
-- would destroy the first to express the second, and would read to the employee
-- as "closed Sep 16" on the 17th.
--
-- `enrollment_closed_on` NULL = the window governs. Non-null = CLOSED from that
-- day, whatever the dates say. Reopening clears both columns, so the class
-- returns to its planned window rather than to a second stored state.
--
-- Idempotent; also folded into references/sql/create/2026-09-16_fpu_classes.sql
-- so a fresh install gets it in one pass.

alter table public.fpu_classes
  add column if not exists enrollment_closed_on date,
  add column if not exists enrollment_closed_by text;

alter table public.fpu_classes
  drop constraint if exists fpu_classes_closed_pair;
alter table public.fpu_classes
  add constraint fpu_classes_closed_pair
    -- "Closed by nobody" is a half-written state: an early close always has an
    -- actor. Not closed means BOTH are null.
    check ((enrollment_closed_on is null) = (enrollment_closed_by is null));

comment on column public.fpu_classes.enrollment_closed_on IS
  'Manila date HR closed enrollment early. NULL = the opens_on..closes_on window governs. Non-null = closed regardless of the dates; reopening clears it.';
comment on column public.fpu_classes.enrollment_closed_by IS
  'Session email that closed enrollment early. Always set together with enrollment_closed_on.';
