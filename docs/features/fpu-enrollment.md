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
| Employee self state + enroll | `app/api/fpu-enroll/route.ts` |
| HR surface | `src/components/hr/HrFpuEnrollments.tsx` (inside `HrMesa.tsx`) |
| Employee surface | `src/components/employee/EmployeeFpu.tsx` (inside `EmployeeMesa.tsx`, sub-tab `fpu`) |
| Shared bulk select | `src/components/mesa/bulk-selection.tsx` (lifted from `AccountingMesa.tsx`) |
| Live channel | `src/lib/mesa/fpu-live.ts` (topic + payload, tested) · `src/hooks/useFpuLive.ts` (subscribe + poll floor + focus refresh) |
| DDL | `references/sql/create/2026-09-16_fpu_classes.sql` · `references/sql/alter/2026-09-16_fpu_classes_name.sql` (the `name` column; folded into the CREATE too) |
| Migration script | `scripts/apply-fpu-classes-migration.mts` — applies both files, idempotent · `scripts/Apply FPU Classes migration.cmd` (double-click) |

## A class is (year, batch) with an inclusive window

`fpu_classes` holds one row per class: `year`, `batch` (unique together), `opens_on`,
`closes_on`, `class_starts_on`, optional `class_ends_on`, and a free-text `schedule_note`
the employee sees, plus an optional **`name`** (≤80 chars, Kane's follow-up the same day: *"set the Batch name"*). Two functions, one rule: `fpuClassCode()` is always `FPU 2026 · Batch 3`; `fpuClassLabel()` is the name when set, else the code. **Wherever a name shows, the code shows under it** — the (year, batch) pair stays the identity and a renamed cohort is still findable by its number. A blank name is stored as NULL (the CHECK refuses whitespace), never as an empty label. The batch number defaults to one past the highest already in that year (`nextFpuBatch`).

The window is **`opens_on ≤ today ≤ closes_on`**, compared as **Manila** calendar dates
(`manilaTodayIso`). Kane: *"if they miss it they miss it."* There is no late-enroll path; HR
edits the class's `closes_on` if it wants one. `fpuClassPhase()` is the one definition of
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

`fpu_enrollments.status`: `pending → approved | denied → completed`. `PATCH /api/hr/fpu-enrollments`
takes `{ ids, status, review_notes? }` for up to 200 rows and **touches only that table** —
Approve reserves a seat, Deny refuses it, `pending` resets a decision. A `completed` row is never
changed by this route (skipped and counted).

**Delete** (`DELETE /api/hr/fpu-enrollments`, `{ ids }`, 2026-09-17, Kane: *"lets add a delete entry"*)
removes pending / approved / denied entries — a mistaken sign-up, a duplicate, a test — after a
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

## The routes are gated; the old list route was not

`GET /api/hr/fpu-enrollments` was one of the four ungated routes in
`pre-release-security-readiness.md` (full name / email / department / shift to any caller). Every
HR route here is `requireFeatureAccess('hr', 'mesa', 'view' | 'edit')`; `fpu-enroll` is
`authorizeEmailAccess` (self or elevated), and identity, name and department are taken from the
**roster row**, never the body. All roster reads page (`selectAllPaged` / `getEmployees`).

Audit actions: `fpu.enroll` (employee), `fpu.class.created | updated | deleted`,
`fpu.enrollment.approved | denied | reset | completed | deleted`. Registry prefix `fpu.`.

## Deploy notes

- **First cut APPLIED 2026-09-16 by Kane** via `scripts/Apply FPU Classes migration.cmd`, verified. **The `name` column (same day, later) needs the `.cmd` run ONCE MORE — PENDING until Kane confirms.** The script applies both SQL files and is `IF NOT EXISTS` throughout, so re-running is a no-op for everything already there. Until the column exists the classes select fails with `42703` and both surfaces read `migrated: false`. For the record: double-click the `.cmd` (rehearsal, then type `APPLY`), or the `--apply` flag
  (dry-run by default; `--verify` afterwards). Creates `fpu_classes` and adds `class_id`,
  `status`, `start_date_used`, `reviewed_by/at`, `review_notes`, `completed_on` plus the unique
  index to `fpu_enrollments`. Needs the session-pooler `DATABASE_URL`.
- Before it landed every route reported `migrated: false`; the HR tab shows an amber line and the
  employee tab says enrollment is not open yet. Nothing 500s. The one legacy `fpu_enrollments`
  row (2026-05-14, `class_id NULL`) is shown nowhere.
- No env vars, no n8n.
