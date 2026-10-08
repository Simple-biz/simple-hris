# New Hire Checklist ← hiring-database sync — new hires arrive on their own

HR → New Hire Checklist now **polls the hiring database** (a separate Supabase project,
`HRIS_HIRES_SUPABASE_URL`), saves every hire it reads into the HRIS's **own copy**
(`hr_new_hire_source_rows`), and places each new hire on the checklist week it belongs to,
tagged **Synced**, with a **Received** timestamp. The manual **New Hire** modal stays. Hires the
sync will not place on its own (a past week, a locked week, no interview date) wait in a
**Not placed** list, and HR adds each with one click. Built 2026-10-08, session `1e5dbda7`
(Kane: *"we will now be polling data that is available from that Database now I want this in
Real Time … a new column for us where we can know the timestamp … saved in our own database as
well … we will still have the Manual Option but find a way that we can prioritize the Polling of
data"*). The source is **`public.hires` in simple-recruitment-portal** (Kane's screenshot, same
day). The migration was **APPLIED 2026-10-08** and the first real sync ran that evening from a local
`next dev` (§ Deploy notes). **Production cannot pull yet:** the code is not pushed and the
`HRIS_HIRES_*` env is not in Vercel.

The checklist's own rules (atomic per-row writes, the lock, the Lead Gen-only orientation
email) are in [new-hire-checklist.md](./new-hire-checklist.md); this doc adds one way for a row
to arrive and changes none of them.

## Key files

| Piece | File |
| --- | --- |
| Env config, identifier-checked, table has NO default | `src/lib/hr/hires-source-config.ts` (+ `.test.ts`) |
| Every decision, pure (US Eastern interview date · week · place/link/hold · merge) | `src/lib/hr/hires-source-map.ts` (+ `.test.ts`) |
| Source read (paged, 20k cap, `truncated`) | `src/lib/hr/hires-source-read.ts` |
| Our copy + checklist reads | `src/lib/supabase/hr-new-hire-source-db.ts` |
| One sync pass · manual placement | `src/lib/hr/hires-source-sync.ts` |
| Route | `app/api/hr/new-hire-checklist/source-sync/route.ts`: `GET` status (elevated) · `POST {action:'sync'}` · `POST {action:'place', source_key, period_start}` (feature edit) |
| Client poll | `src/components/hr/use-hires-source-sync.ts` |
| Strip (status · Sync now · Not placed) | `src/components/hr/HiresSyncStrip.tsx` |
| Received column, Synced/Manual tag, wiring | `src/components/hr/HrNewHireChecklist.tsx` |
| Synced insert (origin, source_key, received_at; 23505 → `conflict`) | `src/lib/supabase/hr-new-hire-checklist.ts` `insertHrNewHireChecklistRow` |
| DDL · apply script | `references/sql/create/2026-10-08_hr_new_hire_source_rows.sql` · `scripts/apply-hr-new-hire-source-sync-migration.mts` |

## "Real time" is a poll plus a Broadcast — not postgres_changes

The open checklist tab runs a sync **on mount, every 30 s while the page is visible, at once
when a hidden page comes back past 30 s, and on Sync now**. It is single-flight (a tick during a
sync is dropped) and the client stops waiting after 45 s. A pass that placed or changed hires
names the weeks it touched, and the server **Broadcasts `changed` on `hr-nhc-room:<week>`**
(the same room `useChecklistRoom` already listens on), so every other open grid refetches in about
a second. The tab that ran the sync refetches from the response directly.

- **Never "subscribe to their table".** `postgres_changes` does not reach the anon browser in
  this project ([[supabase-realtime-anon-rls-dead]]), and the source is another project whose
  publication and RLS we do not control.
- **Nothing syncs while nobody has the tab open.** The first open catches up. A Vercel cron was
  not added because every cron in `vercel.json` is a once-a-day schedule, and a sub-daily schedule
  fails a deploy on the Hobby plan. Which plan this project is on was not checked. If it allows
  per-minute crons, a cron route calling `runHiresSourceSync()` is the whole change.
- **A session without edit rights never syncs.** Its POST gets 403, after which it only reads
  `GET` on the same timer (status and the held list). The room broadcast still refreshes its grid.
- **The OMS tab's "nothing polls" rule is NOT this surface's rule.** Kane ruled that for OMS
  ([orphanage-oms-pull.md](./orphanage-oms-pull.md)); here he asked for real time.
- **Local dev writes PRODUCTION.** `.env.local` is the production database, so a `next dev`
  with this tab open runs real syncs once `HRIS_HIRES_TABLE` is set ([[dispatch-auto-threshold-under-15]]).

## Our own copy — `hr_new_hire_source_rows`

One row per source hire, keyed by the source's id (`source_key`, from `HRIS_HIRES_COL_ID`,
default `id`). **`first_pulled_at` is the timestamp Kane asked for**: when the HRIS first received
the hire. It is never rewritten.

| Rule | Why |
| --- | --- |
| Only the ten mapped columns (+ id, optional created/updated stamps) are read and stored. **Never `select *`.** | The source may hold more about an applicant than the checklist needs. Least PII. |
| An unchanged source row costs **no write** (`content_hash`). A 30 s poll that finds nothing new writes nothing and is not audited. | Five HR tabs polling must not churn the database or bury the audit log. |
| A source row with **no id** is counted (`skippedNoId`, shown on the strip) and skipped, never keyed on a guess. | Without a key it cannot be de-duplicated, so every poll would list it again. |
| **Nothing is ever deleted** from the copy. A hire that disappears at the source stays here. | It is the HRIS's record of what it received. |
| RLS on, **no policies**; read and written only through the service-role route. | Rows name job applicants; the anon key ships in the bundle. |
| `placement` only moves forward: `pending` → `placed` / `linked` / `held`, and `held` → placed/linked. | See the next section. |

## Where a hire goes — place, link or hold (`decidePlacement`)

Checked in this order, all pinned in `hires-source-map.test.ts`:

1. **No usable interview date → HOLD `no_interview_date`.** There is no week. An unparseable
   cell is kept as written (the checklist column is free text).
2. **Already listed → LINK.** The same personal email (case-insensitive) on any checklist week
   from **4 weeks before the target week** onward (prefer the target week, then the latest). With
   no email: the exact name, in the target week only. This runs **before** any week check, so a
   hire HR typed into a past or locked week counts as "on the checklist", not "held". A duplicate
   listing means two orientation emails; a false link costs HR one click. So ties lean to linking.
   An email on the source never links by name alone.
3. **Target week before this week → HOLD `past_week`.** The sync never fills history on its own.
   This is what keeps the first sync from pouring the source's whole back catalogue into old weeks.
4. **Target week locked → HOLD `week_locked`.** Its orientation emails may already be out
   (new-hire-checklist.md § Lock-in). Re-checked every pass, so a reopened week receives it.
5. Otherwise **PLACE**, as an ordinary checklist row with `origin='synced'`, appended at the end
   of the week.

**The target week is the week AFTER the interview week.** This was measured on 2026-10-08 over
every live row: 1,640 of the 1,747 rows that carry an interview date (94%) sit exactly one week after
it, and 753 of 790 since August.

**The interview date is the US EASTERN calendar date** of the portal's timestamp
(`INTERVIEW_TIME_ZONE = 'America/New_York'`, DST-aware). It is stored as `YYYY-MM-DD`, the format HR
types. Measured 2026-10-08 on the 23 portal hires HR had also typed by hand: HR's date equals the
New York date on **20 of 23** and the Manila date on only **11**. The other 3 are HR typing a
different day entirely. The portal's interviews sit at 13:00–18:30Z, 9 AM to 2:30 PM in New York.
**Never read them in Manila.** The first cut (built 2026-10-08 from Kane's two sample rows, `07:30Z`
and `02:00Z`) did, and that put every interview after 16:00Z on the next day, and a Saturday-afternoon
interview a whole week late. Kane: *"put the interview date properly please"*, the same day.
Switching zones back needs a fresh measurement against HR's own dates.

**"This week" is the Manila Sunday** (`currentManilaSunday`), deliberately not the interview zone:
it matches the grid's own **Start Week** badge, which is the HR browser's local Sunday
(`HrNewHireChecklist.tsx` `sundayIso(new Date())`), and HR works from Manila.

**Placed is final.** HR deleting a synced row does not bring it back: the FK is
`ON DELETE SET NULL`, `placed_at` stays, and only `pending`/`held` hires are ever decided.
There is no "restore" path. To re-list someone, use the New Hire modal.

**Concurrency.** Two tabs syncing at the same moment both try to insert the hire. The unique
index `hr_new_hire_checklist_source_key_uidx` lets one win, and the other's `23505` comes back as
`conflict` and adopts the winner's row. Within one pass, a placed hire joins the index straight
away, so a second source row for the same person links instead of adding.

## Who wins a cell — "prioritize polling" without reverting HR (`mergeSourceIntoRow`)

The sync **writes only this week and later, never a locked week** (`isWritableWeek`). Within
those weeks:

- A **blank** cell takes the source's value. This includes a hire HR typed in and the sync then
  linked: the polled data fills what HR left empty.
- A cell the **sync wrote and HR has not touched since** (it still equals `applied_values[f]`)
  follows the source when the source changes.
- A cell **HR typed or changed** is never overwritten again. HR's correction to a department is
  what keeps a Lead Gen orientation email from going to the wrong person.
- **The sync never blanks a cell.** A value removed at the source stays on the checklist.

Every sync write goes through `updateHrNewHireChecklistRow`, so it appends to the cell's history
as **`hires-sync`** and advances `updated_at`. An HR editor with that row's modal open gets the
normal 409 ("Someone else just changed this hire") and re-applies on top. A link to a hire in a
**past** week is recorded but writes nothing.

Values are snapped the way the New Hire modal snaps them: department to an existing department's
casing on the checklist, country to its onboarding name (Bulk Invite routes on it), and source to
a known source's spelling. Anything unrecognised is kept as written. The snap is an exact,
case-insensitive match, the same as the modal's, never fuzzy. **Measured 2026-10-08: the checklist
spells that team "AI/API Team" (14 rows), so a source value of "AI/API" (Kane's example rows)
does NOT snap and lands as "AI/API".** HR fixes it with the bulk Dept apply, or the source uses the
checklist's spelling. Neither spelling is Lead Gen, so the orientation email withholds those hires
either way.

## The strip, the Received column, and the manual way in

- **Strip** (above the grid, checklist tab): a live dot and "checked 2:14:05 PM · N hires in the
  hiring database". Amber for *not set up* (names the missing variables) or *migration not applied*
  (names the script). Rose for a source read error. Red if the read was truncated at 20,000.
  Then **Sync now**, and **Not placed (N)**.
- **Not placed** lists the held hires (name, email, department, interview, why) with **Add to
  this week**, the week on screen. The route refuses a locked week (409), a hire no longer held
  (409), and **a hire whose email is already on the checklist** from 4 weeks before that week
  onward (409, naming the week). HR may type someone in after the sync held them, and "Add" must
  not list them twice. The row is attributed to the HR person (`created_by`, `placed_by`) and
  audited `hr.new_hire_checklist.source_placed`.
- **Received column** (after Country): a **Synced** tag + `received_at` (when the HRIS first got
  the hire), or a **Manual** tag + `created_at`. It is not one of `COLUMNS`, so the edit modal,
  search, filters and the Excel export are unchanged. **The export does not carry it** (out of scope
  on 2026-10-08).
- **Audit:** `hr.new_hire_checklist.source_synced`, one row per pass that placed, linked or updated
  something (counts, weeks, the first 20 errors), with the session that ran the pass as the actor.
  Both actions fall under the existing `hr.` family in `src/lib/audit/registry.ts`.

## What looks like a bug and is not

- **Hires interviewed weeks ago sit in "Not placed" after the first sync.** That is rule 3, by
  design. They are there to be placed by hand, or ignored.
- **A synced row's `created_by` is `hires-sync`**, not a person. A held hire HR places carries the
  HR person.
- **A source change after the week locked never reaches the row.** A locked week is frozen. The
  change is in our copy. Reopening the week does not replay it (a known gap: the merge runs only in
  the pass that sees the change).
- **The route answers 503/502 with a JSON `status`** for *not configured*, *not applied* and
  *source error*. The strip renders those; they are not crashes.

## Deploy notes

**Migration — APPLIED 2026-10-08 (Kane: *"run the migration for me"*).** The dry run passed
(23 object checks, 21 controls, rolled back), then `--apply`, then `--verify`: all passed. Measured
after: `hr_new_hire_source_rows` exists, and all 1,847 checklist rows read `origin = 'manual'`.
DATABASE_URL = the SESSION POOLER on 5432 ([[migration-apply-needs-database-url]]):

```
node --import tsx scripts/apply-hr-new-hire-source-sync-migration.mts           # rehearse + roll back
node --import tsx scripts/apply-hr-new-hire-source-sync-migration.mts --apply   # commit
node --import tsx scripts/apply-hr-new-hire-source-sync-migration.mts --verify  # re-check only
```

It creates `hr_new_hire_source_rows` and adds `origin` (default `'manual'`), `source_key` and
`received_at` to `hr_new_hire_checklist`. It changes no existing row. On a database without it,
the strip says "not applied yet" with that command, and the grid works as before.

**Env, server-only (`.env.example` carries the block).**

| Variable | Required | Default | State 2026-10-08 |
| --- | --- | --- | --- |
| `HRIS_HIRES_SUPABASE_URL` | yes | — | set in `.env.local` (simple-recruitment-portal, `mkfyjy…`) |
| `HRIS_HIRES_SUPABASE_KEY` | yes | — | set in `.env.local`; an **anon** key. The table's RLS lets it SELECT (measured: 34 rows) |
| `HRIS_HIRES_TABLE` | yes | **none** | `hires`, set in `.env.local` 2026-10-08 |
| `HRIS_HIRES_COL_ID` | no | `id` | `id` (uuid); left unset |
| `HRIS_HIRES_COL_NAME` … `_COUNTRY` (10) | no | Kane's names: `name`, `personalEmail`, `location`, `phoneNumber`, `dateOfInterview`, `hiringSource`, `referredBy`, `hiredBy`, `department`, `country` | set in `.env.local`; all 10 measured present |
| `HRIS_HIRES_COL_CREATED_AT` / `_UPDATED_AT` | no | unset (not read) | `created_at` / `updated_at`, set in `.env.local` (both measured present) |

Every identifier is regex-checked and refused **by variable name**, never echoed. **PENDING (Kane):
all of these in Vercel production too.**

**The table name (resolved the same day).** Morning probes of `hires` and 14 other names answered
`PGRST205` (no such table). Kane then sent a screenshot of `public.hires`, and the re-probe read it.
It was created or exposed in between. If a probe says "no such table" again, re-check before
concluding it's the wrong name.

**PENDING (Kane):** the push, and every `HRIS_HIRES_*` variable above in **Vercel production**. Until
both are done, production cannot pull. A signed-in click-through of the strip and the Received column
is also owed.

**The first real sync (measured 2026-10-08 18:23:59Z, actor `kaner@simple.biz`, from a local
`next dev` on production data, the minute the migration landed):** 34 pulled, all "Lead
Generation". **23 linked** to hires HR had already typed in (weeks 09-20, 09-27, 10-04, 10-11), with
0 cells changed. **10 held `no_interview_date`**: `dateOfInterview` is blank at the source.
**1 held `week_locked`**: its week, 10-04, is locked, and it is on no other week. **0 placed.**
One `hr.new_hire_checklist.source_synced` audit row. All 24 dated source rows arrive as **timestamps**
(`interview_at` is set on every one), so the time-zone conversion is on the live path, not just a test.
**That sync ran the first cut, which read them in Manila.** Our copy therefore held Manila dates (only
11 of 24 equal the New York date, measured 18:41Z). The checklist was untouched: nothing placed, and
the linked rows keep HR's own dates. The corrected code changes each affected row's hash, so the next
sync rewrites those copy rows and re-decides the held hires. No data script.
