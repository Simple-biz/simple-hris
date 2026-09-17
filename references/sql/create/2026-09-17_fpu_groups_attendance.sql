-- FPU class GROUPS, weekly SESSION ATTENDANCE, and the eligible/ineligible split
-- that opens MESA membership.
-- ---------------------------------------------------------------------------
-- Kane, 2026-09-17: "once the class is closed ... there would be a list of
-- eligible and ineligible people at the end and only then they can have their
-- Deduction of MESA through Payroll Wizard", and "if they miss even once they
-- will no longer be eligible for MESA".
--
-- Four objects: two new tables, plus columns on the two existing FPU tables.
-- Service-role only, like every other HR-facing table here: RLS on, no policies,
-- reached through gated routes and never from the browser.
--
-- SESSIONS ARE NOT STORED. They are derived weekly from class_starts_on ..
-- class_ends_on (src/lib/mesa/fpu-sessions.ts) and referenced by session_no.
-- A stored session row would be a second source of truth for a date the class
-- row already carries, and the repo's weekly grids are all derived per render
-- (src/lib/hubstaff/calendar-column-dedupe.ts). The cost is that a class with no
-- end date has no sessions at all, which is why the UI requires the end date
-- before groups can be made.

-- ---------------------------------------------------------------------------
-- 1. Groups. One row per group per class.

create table if not exists public.fpu_class_groups (
  id          uuid primary key default gen_random_uuid(),
  class_id    uuid        not null references public.fpu_classes(id) on delete restrict,
  -- 1..N within the class. The label is "Group 3"; the number IS the identity.
  group_no    smallint    not null,
  -- The leader is an ENROLLMENT, not a free-floating email: leadership is a seat
  -- in this class, so it dies with the seat. NULL = not appointed yet, which is
  -- the state every group is in the moment it is dealt.
  leader_enrollment_id uuid references public.fpu_enrollments(id) on delete set null,

  created_by  text,
  created_at  timestamptz not null default now(),
  updated_by  text,
  updated_at  timestamptz not null default now(),

  constraint fpu_class_groups_class_no_uniq unique (class_id, group_no),
  constraint fpu_class_groups_no_sane check (group_no between 1 and 200)
);

comment on table public.fpu_class_groups is
  'One FPU class group. Dealt ONCE per class from a seeded shuffle and then persisted; the randomizer never runs again for that class. leader_enrollment_id is the row-level capability behind marking attendance.';

-- ---------------------------------------------------------------------------
-- 2. Membership. One row per enrollment, for the life of the class.

create table if not exists public.fpu_group_members (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid        not null references public.fpu_class_groups(id) on delete cascade,
  -- The unique constraint is on the ENROLLMENT, not (group, enrollment): a person
  -- holds exactly one seat in one group per class, and moving them UPDATES this
  -- row rather than inserting a second one.
  enrollment_id uuid        not null references public.fpu_enrollments(id) on delete cascade,
  -- Denormalised for the reads that never need the enrollment row. Lower-cased by
  -- the trigger below so every lookup and index agrees without callers remembering.
  email         text        not null,

  -- A member row is NEVER deleted. Someone who leaves mid-class is stamped here,
  -- so attendance already recorded against them stays truthful and the group's
  -- history still explains itself (active-roster-cannot-say-who-left).
  left_on       date,
  left_reason   text,

  created_at    timestamptz not null default now(),

  constraint fpu_group_members_enrollment_uniq unique (enrollment_id),
  constraint fpu_group_members_email_present check (length(btrim(email)) > 0),
  constraint fpu_group_members_left_pair check ((left_on is null) = (left_reason is null))
);

create index if not exists fpu_group_members_group_idx on public.fpu_group_members (group_id);
create index if not exists fpu_group_members_email_idx on public.fpu_group_members (lower(email));

comment on table public.fpu_group_members is
  'Who is in which FPU group. One row per enrollment for the life of the class; a leaver is stamped left_on, never deleted.';

-- ---------------------------------------------------------------------------
-- 3. Attendance. One row per person per session, and ONLY when someone marked it.

create table if not exists public.fpu_session_attendance (
  id            uuid        primary key default gen_random_uuid(),
  -- Keyed on the ENROLLMENT, not the group: attendance follows the person, so
  -- moving them between groups never orphans or duplicates a mark.
  enrollment_id uuid        not null references public.fpu_enrollments(id) on delete cascade,
  class_id      uuid        not null references public.fpu_classes(id) on delete restrict,
  -- 1-based, against the weekly sessions derived from the class dates.
  session_no    smallint    not null,

  -- A row that EXISTS carries a deliberate answer. The ABSENCE of a row is its
  -- own third state ("unmarked") and is reported separately — the repo's standing
  -- rule that a missing value is UNAVAILABLE, never zero.
  present       boolean     not null,
  marked_by     text        not null,
  marked_at     timestamptz not null default now(),
  note          text,

  constraint fpu_session_attendance_uniq unique (enrollment_id, session_no),
  constraint fpu_session_attendance_no_sane check (session_no between 1 and 52),
  constraint fpu_session_attendance_marked_by_present check (length(btrim(marked_by)) > 0)
);

create index if not exists fpu_session_attendance_class_idx on public.fpu_session_attendance (class_id, session_no);

comment on table public.fpu_session_attendance is
  'One deliberate present/absent mark per person per FPU session. No row = UNMARKED, which is a distinct state and fails closed at class close.';

comment on column public.fpu_session_attendance.present is
  'TRUE = attended, FALSE = deliberately marked absent. Never defaulted: the absence of the ROW is how "nobody marked this" is stored.';

-- ---------------------------------------------------------------------------
-- 4. The class gains a CLOSE (distinct from closing enrollment).

alter table public.fpu_classes
  add column if not exists class_closed_on date,
  add column if not exists class_closed_by text;

alter table public.fpu_classes
  drop constraint if exists fpu_classes_class_closed_pair;
alter table public.fpu_classes
  add constraint fpu_classes_class_closed_pair
    check ((class_closed_on is null) = (class_closed_by is null));

comment on column public.fpu_classes.class_closed_on is
  'Manila date the CLASS was closed — its end date has arrived, the eligible/ineligible split was published and the eligible were enrolled in MESA. Distinct from enrollment_closed_on, which only stops people signing up.';

-- ---------------------------------------------------------------------------
-- 5. The enrollment gains a FAILED outcome and an HR override.

alter table public.fpu_enrollments
  -- Kane: a miss fails THIS class only; they may enroll in a later batch. So this
  -- is a terminal status that deliberately does NOT stamp mesa_fpu_completed_on —
  -- that stamp bars every future class forever and nothing in the app clears it.
  add column if not exists attendance_override        text,
  add column if not exists attendance_override_by     text,
  add column if not exists attendance_override_reason text,
  add column if not exists attendance_override_at     timestamptz;

alter table public.fpu_enrollments
  drop constraint if exists fpu_enrollments_status_check;
alter table public.fpu_enrollments
  add constraint fpu_enrollments_status_check
    check (status in ('pending', 'approved', 'denied', 'completed', 'failed'));

alter table public.fpu_enrollments
  drop constraint if exists fpu_enrollments_override_value;
alter table public.fpu_enrollments
  add constraint fpu_enrollments_override_value
    check (attendance_override is null or attendance_override in ('pass', 'fail'));

alter table public.fpu_enrollments
  drop constraint if exists fpu_enrollments_override_pair;
alter table public.fpu_enrollments
  -- An override is a DECISION and a decision has an author. "Overridden by
  -- nobody" is a half-written state, the same rule the early-close pair carries.
  add constraint fpu_enrollments_override_pair
    check ((attendance_override is null) = (attendance_override_by is null));

comment on column public.fpu_enrollments.attendance_override is
  'HR''s explicit ruling over the computed attendance verdict: pass (excused absence, make-up session) or fail. The verdict READS this and never recomputes over it, so a later leader edit cannot silently undo it.';

-- ---------------------------------------------------------------------------
-- 6. Normalisation + RLS.

create or replace function public.fpu_group_members_normalize()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;

drop trigger if exists fpu_group_members_normalize_trg on public.fpu_group_members;
create trigger fpu_group_members_normalize_trg
  before insert or update on public.fpu_group_members
  for each row execute function public.fpu_group_members_normalize();

drop trigger if exists fpu_class_groups_touch_trg on public.fpu_class_groups;
create trigger fpu_class_groups_touch_trg
  before update on public.fpu_class_groups
  for each row execute function public.fpu_classes_touch();

alter table public.fpu_class_groups      enable row level security;
alter table public.fpu_group_members     enable row level security;
alter table public.fpu_session_attendance enable row level security;
