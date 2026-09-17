# FPU classes & enrollment — the pipeline into MESA

HR creates a **Financial Peace University class** — `FPU 2026 · Batch 1` — with an enrollment
window. Eligible employees enroll from **Employee → MESA → FPU Class** while the window is open.
HR approves seats in bulk on **HR → MESA → FPU Classes**, and when the class is over marks the
attendees **completed**, which stamps their FPU date and opens their MESA membership. Shipped
2026-09-16 (session `7b4c4597`); replaces the free-standing FPU sign-up form, which had been
**mounted nowhere** since the MESA sub-tabs were cut to About / Request / History.

## Key files

| Piece | File |
| --- | --- |
| Class + enrollment rules (pure, browser-safe) | `src/lib/mesa/fpu-class.ts` (+ test) |
| Eligibility verdict (pure) | `src/lib/mesa/fpu-eligibility.ts` (+ test) |
| Server reads, table names, migrated check | `src/lib/mesa/fpu-server.ts` |
| Classes CRUD | `app/api/hr/fpu-classes/route.ts` |
| Enrollments list + bulk decision | `app/api/hr/fpu-enrollments/route.ts` |
| Mark completed | `app/api/hr/fpu-enrollments/complete/route.ts` |
| Close / reopen enrollment | `app/api/hr/fpu-classes/close/route.ts` |
| Employee self state + enroll | `app/api/fpu-enroll/route.ts` |
| HR surface | `src/components/hr/HrFpuEnrollments.tsx` (inside `HrMesa.tsx`) |
| Employee surface | `src/components/employee/EmployeeFpu.tsx` (inside `EmployeeMesa.tsx`, sub-tab `fpu`) |
| Shared bulk select | `src/components/mesa/bulk-selection.tsx` (lifted from `AccountingMesa.tsx`) |
| Live channel | `src/lib/mesa/fpu-live.ts` (topic + payload, tested) · `src/hooks/useFpuLive.ts` (subscribe + poll floor + focus refresh) |
| DDL | `references/sql/create/2026-09-16_fpu_classes.sql` · `references/sql/alter/2026-09-16_fpu_classes_name.sql` (the `name` column) · `references/sql/alter/2026-09-17_fpu_classes_closed_early.sql` (early close) — both folded into the CREATE too |
| Migration script | `scripts/apply-fpu-classes-migration.mts` — applies the CREATE plus BOTH ALTERs · `scripts/Apply FPU Classes migration.cmd` (double-click) |

## A class is (year, batch) with an inclusive window

`fpu_classes` holds one row per class: `year`, `batch` (unique together), `opens_on`,
`closes_on`, `class_starts_on`, optional `class_ends_on`, and a free-text `schedule_note`
the employee sees, plus an optional **`name`** (≤80 chars, Kane's follow-up the same day: *"set the Batch name"*). Two functions, one rule: `fpuClassCode()` is always `FPU 2026 · Batch 3`; `fpuClassLabel()` is the name when set, else the code. **Wherever a name shows, the code shows under it** — the (year, batch) pair stays the identity and a renamed cohort is still findable by its number. A blank name is stored as NULL (the CHECK refuses whitespace), never as an empty label. The batch number defaults to one past the highest already in that year (`nextFpuBatch`).

The window is **`opens_on ≤ today ≤ closes_on`**, compared as **Manila** calendar dates
(`manilaTodayIso`). Kane: *"if they miss it they miss it."* There is no late-enroll path; HR
edits the class's `closes_on` if it wants one.

**Close enrollment** (2026-09-17, Kane: *"a button where we can close the enrollment period at any
time we want — this would prohibit the Employees from enrolling"*) shuts a class mid-window from
the selected class's header. It stamps `enrollment_closed_on` (today in Manila) and
`enrollment_closed_by`, and **that alone decides the phase** — `fpuClassPhase` returns `closed`
before it looks at a single date, so no day inside the window reopens it. The planned `closes_on`
is deliberately **not** rewritten: the window records what HR announced, an early close records a
decision someone made on a day, and moving the first to express the second would both destroy the
record and tell the employee "closed Sep 16" on the 17th. **Reopen enrollment** clears both columns
and the class returns to its planned window. The two columns are constrained to move together
(`fpu_classes_closed_pair`) — "closed by nobody" is a half-written state. Audited as
`fpu.class.enrollment_closed` / `…_reopened`, which record the untouched window alongside.

Both directions go through **one confirm-then-progress dialog** (`EnrollmentGateDialog`, 2026-09-17).
Its progress bar advances on the two things that actually happen — the write lands, then every open
board is brought back in line — and only completes when both are done. It is deliberately **not** a
timer: a bar that fills on a schedule would be a lie told to someone about to stop their colleagues
enrolling. A failure keeps the dialog open with the server's reason and a Try again.

**Closing hides nobody.** The enrollment table is the same table before and after; once closed it
is simply final — the complete list of people who applied to that class — and HR goes on approving
seats and marking the class completed from it. The header says so: *"Enrollment closed Sep 17 by
kaner · 12 people applied — this list is final."* `fpuClassPhase()` is the one definition of
upcoming / open / closed, and `pickCurrentFpuClass()` is the one rule for which class the
employee page shows: the open one (closing soonest if two overlap), else the nearest upcoming,
else the most recently closed.

## Eligibility is ONE server-side verdict, measured at class start

`fpuVerdict()` in `src/lib/mesa/fpu-eligibility.ts` is the only definition, and
`POST /api/fpu-enroll` **re-derives it from its own reads** — the roster, the rate row and the
existing enrollments. The client's copy is a painting; a request that disagrees with the
server's verdict is answered **409** with the same sentence the employee saw.

In order, a person is refused when:

1. no class exists;
2. they already have an enrollment in **this** class, **whatever its status — a DENIED entry that
   HR has not deleted still blocks** (Kane, 2026-09-17: *"when an entry is denied and deleted the
   Employee can apply again but if its not deleted then he cant apply yet"*). The employee reads
   "Your enrollment in this class was denied. HR can remove the entry if you may apply again";
   the moment HR deletes the row the card repaints (live) and Enroll returns. One per person per
   class — the `(class_id, lower(email))` unique index is the backstop;
3. they already completed FPU (`mesa_fpu_completed_on` set) or are already a MESA member;
4. they are **not on the active Global Master List** (`active_employees` — Kane: *"Promoted to
   Global Master List and Active"*);
5. their roster **Start Date is missing or unparseable** — this **fails closed**. The old form
   failed open ("don't punish people with bad records"); Kane took the recommendation to flip it
   on 2026-09-16. The sentence tells them to ask HR to fix the date;
6. **tenure**: `start_date + 3 calendar months > class_starts_on`. Kane ruled the cutoff is the
   **class start date**, not the day they click, so the verdict is the same on every day of the
   window. Three calendar months, month-end clamped (Nov 30 + 3 = Feb 28). *"Even if they miss
   1 day thats already unqualified"* — Jul 8 start qualifies for an Oct 8 class; Jul 9 does not;
7. the window has not opened / has closed.

Tenure is deliberately checked **before** the window: "you qualify from Dec 16" is more useful
to someone who would not qualify anyway than "enrollment is closed".

`start_date_used` on the enrollment row freezes the parsed start date the verdict used, so a
later roster edit cannot silently change what HR is looking at. HR's table recomputes the
cutoff from it and flags a row amber if the class start date was moved after the enrollment.

## Approve is a seat. Mark completed is the money event.

`fpu_enrollments.status`: `pending → approved | denied → completed | failed`. `failed` is written only by Close class, for someone who missed a session; it is terminal for THIS class and deliberately stamps NO `mesa_fpu_completed_on`, so a later batch stays open to them — see [fpu-groups-attendance.md](fpu-groups-attendance.md). `PATCH /api/hr/fpu-enrollments`
takes `{ ids, status, review_notes? }` for up to 200 rows and **touches only that table** —
Approve reserves a seat, Deny refuses it, `pending` resets a decision. A `completed` row is never
changed by this route (skipped and counted).

**Delete** (`DELETE /api/hr/fpu-enrollments`, `{ ids }`, 2026-09-17, Kane: *"lets add a delete entry"*)
removes any entry that is not `completed` — pending, approved, denied **and `failed`** — after a
confirm that lists the names. The person can enroll again while the window is open. A
**`completed` entry is refused** (skipped and counted, the toast says why): it is the record that
the FPU date was stamped and the membership opened, and deleting it would reverse neither. Every
deleted row is written whole into the `fpu.enrollment.deleted` audit event.

**Mark completed** (`POST /api/hr/fpu-enrollments/complete`, `{ ids, completed_on }`) is what the
old HR opt-in approval used to be. For each **approved** row it:

1. stamps `employee_hourly_rates.mesa_fpu_completed_on = completed_on` on **every** rate row
   keyed by the work email (the flag is denormalised per upload; a partial stamp drifts back);
2. marks the enrollment `completed` with `completed_on`;
3. decides whether the person may be opted in to MESA, and returns them under **`toEnroll`**
   only if they are **not** `mesa_member` and hold **no open `mesa_accounts` row under any
   alias** (`mesaEmailAliasesFor`). Those who are go under `alreadyMembers` and are **never
   sent to the toggle route** — it resolves the open account by the email it is handed and, for
   a drifted member, **mints a second account that hides their balance**
   (`memory/mesa-alias-members-never-flagged`).

The client then calls **`POST /api/toggle-mesa-member`** per `toEnroll` row with
`{ workEmail, mesaMember: true, name, since: completed_on }` — the same client-side sequence
the old HR opt-in approval used, and the same single choke point that opens accounts. `since`
is the completion date, so the ₱100 / ₱400 begin with the first pay week whose **Friday** is on or
after it (`mesaContributesForWeek`). The toggle route's own guards still apply: a date on or
before a previous stint's `closed_on` is refused (400) and the toast names the person. A member
whose rate rows carry no `Work Email` match is reported under `noRateRow` — the FPU date had
nowhere to land and HR has to chase it.

**What happens after the class.** Once enrollment is closed, the seated enrollees are divided into groups, a leader marks weekly attendance, and closing the CLASS publishes the eligible/ineligible split and opens MESA for the eligible — [fpu-groups-attendance.md](fpu-groups-attendance.md). The bulk **Mark completed** action still exists and carries an attendance gate, but a NARROWER one: it only bites once somebody has marked at least one cell in that class (`classHasMarks`, `complete/route.ts:115`). A class where nothing was ever marked is completed wholesale — unlike **Close class**, where an unmarked seat fails closed. Blocked rows come back under `missedSessions`, which the HR table does not yet render. Whether the two should be brought to parity is an open ruling.

**What this retired.** The HR **Opt-in Requests** sub-tab is gone and the employee Request form
**no longer offers Opt-in** (`REQUEST_TYPE_TABS` excludes it). `POST /api/mesa-requests` still
accepts `opt_in` — the derived "Opt-in" history line and the type union are unchanged — but
nothing in the UI files one. Accounting's **Non Members → Opt In** bridge is untouched.

## Both views are live — by Broadcast, never `postgres_changes`

Kane, 2026-09-17: *"make sure this is live polling please real time Supabase."* Every route that
writes — class create / edit / delete, the bulk decision, Mark completed, the employee's Enroll —
fires `broadcastFromServer(FPU_LIVE_TOPIC, 'changed', { kind, classId, emails, ts })` after the
write (fire-and-forget, never awaited on the request path). `useFpuLive` subscribes both surfaces:
HR reloads classes + the selected class's rows; the employee card reloads only when the payload
names their email or names none. Reloads are **quiet** — no spinner over painted rows, so a
half-made checkbox selection is never yanked — and HR skips a repaint while a decision is in
flight (`busy`).

Why not `postgres_changes` on the two tables: the browser is `anon` and both tables have RLS on
with zero policies, so a row event can never be delivered (`memory/supabase-realtime-anon-rls-dead`).
Do not "fix" a stale view by adding the tables to the publication. The topic is its own
(`fpu-classes-sync`, pinned by `fpu-live.test.ts` against the dispatch / paid / start-processing
topics) because realtime-js keeps one channel per topic per client.

**Floor:** a 15-second poll while the tab is visible plus a refresh on tab focus, so a dropped
socket degrades to "seconds late", never to stale. The HR toolbar shows the honest state — **Live**
(subscribed) / **Connecting** / **Polling** (channel errored, poll carrying it).

**The tab is cached** (2026-09-17). Classes, per-class enrollments and the groups panel all sit
in the shared HR tab store (`src/lib/hr/tab-cache.ts`), so switching sub-tabs repaints from memory
instead of hitting the database. A warm entry PAINTS and anything past the 30-second window
revalidates silently behind it; `migrated` is never cached because it decides rather than paints.
Every write path already calls the refresh, which re-stamps the entry. Full rules:
[hr-dashboard-cache.md](hr-dashboard-cache.md).

**Skeletons cover the COLD paint only** (2026-09-17). The class strip, the enrollment table and
the whole card each have one, sized to the real thing so nothing reflows on reveal. They render at
exactly two moments: the first load of the tab, and switching to a class whose rows have not been
fetched yet — where the alternative is a blank rectangle or, worse, "No enrollments yet" printed
over a class that has plenty. **A poll, a broadcast or a save never brings one back**: `classesLoaded`
never returns to false and `rowsLoadedFor` only resets when the selected class changes.

**There is no Refresh button** (removed 2026-09-17, Kane: *"this is live polling already"*). The
pill IS the freshness answer; a manual reload beside it only invites the question of whether the
view can be trusted without one. `refreshAll` stays for the surface's own writes, which reload
immediately rather than waiting for their broadcast to come back around.

## The routes are gated; the old list route was not

`GET /api/hr/fpu-enrollments` was one of the four ungated routes in
`pre-release-security-readiness.md` (full name / email / department / shift to any caller). Every
HR route here is `requireFeatureAccess('hr', 'mesa', 'view' | 'edit')`; `fpu-enroll` is
`authorizeEmailAccess` (self or elevated), and identity, name and department are taken from the
**roster row**, never the body. All roster reads page (`selectAllPaged` / `getEmployees`).

Audit actions: `fpu.enroll` (employee), `fpu.class.created | updated | deleted | enrollment_closed | enrollment_reopened`,
`fpu.enrollment.approved | denied | reset | completed | deleted`. Registry prefix `fpu.`.

## Deploy notes

- **APPLIED AND VERIFIED.** First cut 2026-09-16, the `name` column and the early-close pair 2026-09-17, each confirmed with the script's read-only `--verify`. Nothing is pending. The first real class, `FPU 2026 · Batch 1`, was created 2026-09-17 07:06 UTC and took its first enrollment three minutes later.
- The script applies **three** SQL files (the CREATE plus the `name` and `closed_early` ALTERs). It is idempotent, and since 2026-09-17 that includes `fpu_enrollments_status_check`: the CREATE re-adds that constraint unconditionally, so it now lists all FIVE statuses including `failed`. Before that fix, running this `.cmd` AFTER the Groups one would have stripped `failed` and broken Close class.
- **This surface also needs the FPU Groups migration** (`scripts/Apply FPU Groups migration.cmd`, see [fpu-groups-attendance.md](fpu-groups-attendance.md)). `FPU_CLASS_SELECT` names `class_closed_on` / `class_closed_by` and `FPU_ENROLLMENT_SELECT` names the four `attendance_override*` columns, so without it EVERY read here fails `42703` and both the HR tab and the employee card read `migrated: false` — not just the groups panel. It is applied; this is why a column added to either select list takes the whole tab down until its own migration runs.
  (dry-run by default; `--verify` afterwards). Creates `fpu_classes` and adds `class_id`,
  `status`, `start_date_used`, `reviewed_by/at`, `review_notes`, `completed_on` plus the unique
  index to `fpu_enrollments`. Needs the session-pooler `DATABASE_URL`.
- Before it landed every route reported `migrated: false`; the HR tab shows an amber line and the
  employee tab says enrollment is not open yet. Nothing 500s. The one legacy `fpu_enrollments`
  row (2026-05-14, `class_id NULL`) is shown nowhere.
- No env vars, no n8n.
