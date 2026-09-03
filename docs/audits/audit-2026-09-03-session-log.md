# Session Log — the 20 most recent Claude sessions (Sep 3, 2026)

Continues [audit-2026-08-26-session-log.md](./audit-2026-08-26-session-log.md). Times are ET.

**The chain broke for five working days and this log says so rather than papering over it.**
The Aug 26 log closed at Aug 26. Nothing was written for **Aug 27 – Sep 1**, in which **76 commits
landed** — the wizard PAB step rebuild, the HSL/Additions merge, the bank-preferred 1:1 rule, the
People → Offboarded search tab, Generate COE, and more. Those days are recorded here at
**commit level only** (§ The five-day gap) — grouped into deliverables from `git log`, not from
their transcripts. Session-level narrative resumes at **Sep 1 evening** and runs to now.

Window: **113 commits**, `fdcea807` (Aug 27 07:08) → `cc31fe46` (Sep 3 15:35).
Narrated in full: **Sep 1 19:23 → Sep 3 15:53**, 20 transcripts, 37 commits.

| # | Session | When (ET) | Shipped |
|---|---|---|---|
| 1 | `54f9be83` | **Sep 3** 15:51 → *in flight* | this log |
| 2 | `f915cc29` | Sep 3 15:25 → 15:51 | `cc31fe46` — **apply was still running at hand-off** |
| 3 | `1a8c9a77` | Sep 3 13:30 → 15:22 | `7e15aed8` · `67858c44` |
| 4 | `5a2f134a` | Sep 3 13:33 → 15:20 | `5062ccc1` · `44aa16f7` · `3a658873` |
| 5 | `ac23ad6c` | Sep 3 13:54 → 14:03 | `5982d3e6` |
| 6 | `8dfe9543` | Sep 3 12:11 → 12:53 | `d406e7c9` — **script not run** |
| 7 | `2fc55a85` | Sep 3 10:59 → 11:02 | `30230f09` |
| 8 | `3e4c6a06` | Sep 3 09:43 → 10:08 | `c8e5f658` · `4265bdfd` · `b1c0dcf3` · `fb26990b` · `6f4ac980` |
| 9 | `a0cfce5e` | Sep 3 09:17 → 10:01 | `1b840fc6` · `a93ac194` |
| 10 | `cc12306c` | Sep 2 16:00 → Sep 3 12:18 | `57ca6638` · `5a18b40c` · `34934480` · `cd8f4365` · `2b54e2fb` · `1a049e76` · `5cc1a5eb` · `f9acc1a5` |
| 11 | `d71bedc4` | Sep 2 15:41 → Sep 3 13:04 | `60ea3aeb` · `64f012b6` · `1128ebce` · `407207a3` · `1f5b3ce4` |
| 12 | `d6070184` | Sep 2 13:44 → 15:07 | **swept into `f36a97ce` "Push"** |
| 13 | `3dab3af5` | Sep 2 13:11 → 14:00 | **swept into `f36a97ce` "Push"** |
| 14 | `4f0ac61c` | Sep 2 11:22 → 13:20 | `62c8312e` · `840f0f77` · `b97637e3` · `0ce0fa64` |
| 15 | `b0be9d89` | Sep 2 10:50 → 11:20 | — **brief posted, nothing committed** |
| 16 | `eca4fe7b` | Sep 2 10:55 → 11:00 | — **hard stop on two doc contradictions** |
| 17 | `30aeefd5` | Sep 2 10:44 → 10:47 | — measurement only, **decision owed** |
| 18 | `d8e408c6` | Sep 2 09:28 → 09:50 | `8a6261b7` |
| 19 | `c529d5d2` | Sep 1 19:23 → Sep 2 09:33 | `0703c748` |
| 20 | `a2cedd5f` | Sep 1 18:27 → 18:41 | `28bea8ac` |

---

## What this pass found

1. **A commit called `Push` is carrying two full UI deliverables.** `f36a97ce` (Sep 2 15:15) is 358
   files and 106,512 insertions. Most of it is an `impeccable` plugin upgrade — but inside it,
   unlabelled, sit **the KPI Calculator branch-list/shared-header work** (session `d6070184`:
   1,553 lines of `ManagerApp.tsx`, three new chip components, the payroll-lock ring, alphabetical
   branch ordering) and **the Manager Overview viewport-lock redesign** (session `3dab3af5`).
   Both sessions closed saying *"Nothing committed"* — correctly, at the time. They were swept up
   by a third session's catch-all. Neither is findable from `git log`, and **the Manager Overview
   redesign has no feature doc and no INDEX row at all.**

2. **Two sessions ended holding a decision, and neither decision has been made.** The orientation
   no-show → Offboarded ask (`eca4fe7b`) hard-stopped on two doc contradictions with a live
   measurement attached; the Labor Day orientation collision (`30aeefd5`) has a **Fri Sep 4 ~20:15 UTC
   deadline** because that is when Lock-in fires the invite. Both are in § Open items.

3. **The duplicate-paid-row fix shipped; the cleanup did not.** `d406e7c9` closes the hole
   (server 409 guard + stale-load fence) and is pushed. The 82 pre-existing echo rows are still in
   production — `scripts/dedupe-payment-dispatches.mjs --apply` was blocked by the permission
   classifier mid-session and has never been run.

4. **The MESA close-out session posted a full hardening brief and committed nothing.** `b0be9d89`
   read all 253 lines of `mesa.md` plus all 13 `mesa-*` memories, enumerated four failure classes
   and named a real documentation defect on a money doc — `accounting-mesa-export.md` says a closed
   account's history is *"retained"* and never says the balance is **released as an obligation**.
   `git log` since Sep 1 shows **no commit touching any MESA doc or `verify-mesa-backfill.mjs`.**
   The brief is in the transcript and nowhere else.

5. **Monday pass 23 is recorded as STAGED, and the apply was mid-flight when the session handed off.**
   `cc31fe46`'s message says *"STAGED, NOT APPLIED — 14 rows / 56 SP"*. Sixteen minutes later the
   same session had the ~250-call apply running in the background and had not yet verified it. The
   commit is therefore **not evidence of the board's current state either way** — re-read the board
   before the next pass, and do not trust the message.

6. **Eight commits are unpushed**, `1f5b3ce4` → `cc31fe46` — everything from the close-out fix
   forward, including both new Payment Catalog tabs.

---

## Thu Sep 3

### Payment Catalog → Departments gets Edit Department · `7e15aed8` · `67858c44`
> *"Accounting - Payment Catalog - Departments - Lets add an edit department where we can edit and
> add Sub Departments and change stuff in there the way we would like creating a department"*
> 13:30 → 15:22 · `1a8c9a77` · routed to **`blueprint`**

Shipped as the mirror of Create a Department. **Renaming keeps the department KEY** and records the
old label in `previousNames` as an alias, so nothing that resolves by name loses its rows — the
rename is a relabel, never a transfer, and a hard confirm dialog says so before it runs. Sub-department
restructure, people moves, and a **CAS guard returning 409** on a concurrent edit. A second pass
(`67858c44`) put the Edit affordance on the master-list department cards too, **managers only, HSL
excluded** — HSL's sub-department identity is governed elsewhere and must not be editable here.

Doc: [payment-catalog-departments.md](../features/payment-catalog-departments.md) · memory `edit-department-dialog`.

### Payment Catalog → Pay Processors, the send-from registry · `5062ccc1` · `44aa16f7` · `3a658873`
> *"Payment Catalog - Lets add a new tab called 'Pay Processors' … classify them if they are one to
> one like Kolan and Higlobe and Another bank that is compatible with another bank like multi peer"*
> 13:33 → 15:20 · `5a2f134a` · routed to **`blueprint`**

A new tab that is **the source of truth for send-from processors** — the registry Payment Dispatch
will read from when the two are wired together. One-to-one processors (Kolan, Higlobe) versus
any-bank processors (Wise) are classified explicitly; the 1:1 set mirrors `WALLET_RAILS`, and
**drift between the registry and the rails renders as a chip, never a refusal**. Kane's answer to
Q5 retired WePay in the same pass. `44aa16f7` fixed the dialog edges — the primitive's own `p-4`
was being overridden, so the footer bled past the card; `3a658873` waives a `broken-image` detector
hit on `pay-processors.ts`, which is doc comments with no JSX.

Doc: [payment-catalog-pay-processors.md](../features/payment-catalog-pay-processors.md) · memory `payment-catalog-pay-processors-tab`. **PD integration is next, not done.**

### The Lock-in button greys out once the cycle is sent · `5982d3e6`
> *"Payroll Wizard - Dispatch - When we have locked in the Values and sent to payment dispatch
> already please make sure that this button is greyed out"*
> 13:54 → 14:03 · `ac23ad6c` · routed to **`hardening`**

**This was a tightening, not cosmetics.** Before it, clicking Lock on an already-locked cycle
silently re-staged, and the queue upsert **overwrites amounts on rows already marked paid**. Every
governing doc names *unlock → change → lock again* as the only sanctioned re-stage path, so
disabling the button while locked makes the UI and the docs agree. The button is also disabled while
the 30-second lock poll is still loading, and the click handler re-checks both conditions as a second
guard. Disabled state and label come from one pure helper, `dispatch-button-state.ts`, with **ten
unit tests over the precedence order**.

Doc: [paystub-dispatch.md](../features/paystub-dispatch.md) · memory `wizard-dispatch-button-locked-disabled`.

### Duplicate paid rows in Payment Dispatch · `d406e7c9` — *cleanup still owed*
> *"There are duplicate entries in the paid side under the Payment Dispatch can you check what the
> problem was?"* … *"Cob still has two entries do I need to refresh?"*
> 12:11 → 12:53 · `8dfe9543` · routed to **`systematic-debugging`**, then **`hardening`**

Root cause found before any fix: **no server-side uniqueness per (person, cycle)**, and a client
that could POST from a stale load. Closed with a **409 guard on the server**, a stale-load fence,
and `scripts/dedupe-payment-dispatches.mjs`.

**The database is still dirty.** 82 echo rows across 81 groups remain, Cob's included, because the
`--apply` run was blocked by the permission classifier and never re-run. `alonzos@` may be a **real**
double payment rather than an echo and is excluded from the automatic sweep.

Doc: [payment-dispatch.md](../features/payment-dispatch.md) · memory `dispatch-duplicate-paid-rows`.

### Employee Profile and Pay Stubs load in one wave · `1b840fc6` · `a93ac194`
> *"Employee - Profile - How do we optimize the performance on this where we can speed up the
> fetching of data?"* … *"It takes like a long time to load though especially the paystubs"*
> 09:17 → 10:01 · `a0cfce5e` · routed to **`hardening`**

Pay Stubs now serve from the **recovered snapshots** rather than recomputing, and the Profile's
fetches collapse into a single wave instead of a waterfall. `a93ac194` is a file-scoped
`gray-on-color` waiver for two EmployeeProfile buttons whose rose ground exists **only on hover**,
where the text turns rose with it — there is no gray-on-color state a user ever sees. Reverting that
one commit puts the rule back.

Docs: [employee-dashboard-cache.md](../features/employee-dashboard-cache.md) · [paystub-dispatch.md](../features/paystub-dispatch.md).

### My Hours calendar restyled on the MESA stat cards · `c8e5f658` · `4265bdfd` · `b1c0dcf3` · `fb26990b` · `6f4ac980`
> *"Employee - My Hours - Calendar UI lets upgrade this please that it will look like Small KPI Cards
> from MESA under accounting"* → *"a bit smaller"* → *"Flatten this, put this at the right side of
> the Week Selector"* → *"Lets not make the calendar gradient"*
> 09:43 → 10:08 · `3e4c6a06` · routed to **`impeccable`**

Five commits of live iteration, each one Kane's correction: tiles sized down, month range and PAB
period flattened beside the pill instead of stacked, gradient fills replaced with flat tone fills,
and weekend tiles retinted to **warm text on the orange ground** rather than neutral ink on a colored
ground. **No feature doc covers the Employee My Hours calendar** — see § Open items.

### Favicon · `30230f09`
> *"use the Employee - Chatbubble as our Favicon for the HRIS"* · 10:59 → 11:02 · `2fc55a85`

The Employee Penny chat-bubble heart is now the app favicon.

---

## Wed Sep 2 → Thu Sep 3 (long-running)

### Orphanage interns — a new payee class, end to end · `57ca6638` +7
> *"Create an Implementation plan on this and a TLDR at the bottom … Interns earn 200 PHP per hour …
> capped at a maximum of 5 hours"* → *"Start the build!"*
> Sep 2 16:00 → Sep 3 12:18 · `cc12306c` · **`writing-plans`** → **`executing-plans`** → **`impeccable`**

The largest deliverable in the window. Interns (`@pathway.ph`) are **a payee class, not employees**:
own tables (`orphanage_interns`, dated `orphanage_intern_rates`, `orphanage_intern_hours`,
`orphanage_intern_pay`), never `global_master_list`, never `hubstaff_hours`, never
`payment_dispatches`, no paystub, no Employee Dashboard. `isInternEmail` guards **both doors** — the
payroll row builder drops them with a disclosed count, and the intern CSV upload refuses non-interns.

Pricing lives only in `intern-week-pay.ts` (daily cap → weekly cap consumed chronologically → the
rate in force on each day). **No OT leg exists in the type**, and a paid day with no rate **refuses
the week rather than paying ₱0**. PAB is ₱1,000 when every Sun–Sat week of Simple's PAB period has
≥ 5 paid hours. No Tech Bonus.

Then five commits of dialog work Kane drove directly — *"The Modal please make sure everything fits"*,
*"the full name required is there and the button is not sized well"*, *"The buttons are at the edge"*,
*"switching from Profiles to Pay Week lets transition that smoothly"* — landing the intern dialog as
**three tabs (Profile · Pay · Bank)** so no pane scrolls, validating only after the user acts,
and (`5cc1a5eb`) splitting the intern name into parts composed exactly like Simple hires.
`f9acc1a5` fixes the migration to add those name-part columns to an **already-created** interns table.

Doc: [orphanage-interns.md](../features/orphanage-interns.md) · memory `orphanage-interns`.
**Migration `2026-09-02_orphanage_interns.sql` is still pending Kane's `--apply`.**

### The paid toast, and what it exposed about Realtime · `60ea3aeb` · `64f012b6` · `1128ebce` · `407207a3` · `1f5b3ce4`
> *"there should be a toast at the lower left where we can see a person getting paid and how much we
> sent out … like lenny@simple.biz paid kaner@simple.biz $2,700"*
> Sep 2 15:41 → Sep 3 13:04 · `d71bedc4` · **`blueprint`** → **`hardening`**

Shipped as a lower-left card on **every dashboard** for anyone holding Accounting → Payment Dispatch
**VIEW** (not Edit) — mounted once at the root layout, with the server issuing the 200/403 verdict
rather than the client guessing.

Two follow-ups came straight from Kane using it. *"I did not see the toast live … she is on live
while I am on localhost"* → `64f012b6` made it poll the server so it no longer depends on the payer
being on the same build. *"the toast arrives first rather than clearing the table … check Supabase"*
→ the investigation found **`postgres_changes` never reaches an anon client here at all** — Payment
Dispatch has zero RLS policies and `app_settings` is admins-only, so Realtime was silently dead.
`407207a3` has the **server broadcast after the INSERT**, and the remotely-paid row is hidden at the
render boundary with `pending` left untouched.

`1f5b3ce4` closes the tail: **Stop Processing could file a just-paid person as unpaid**. It now agrees
with the screen and is backstopped by the server's own paid rows. The Export CSV was checked in the
same session and already matched the table.

Docs: [dispatch-paid-toast.md](../features/dispatch-paid-toast.md) · [payment-dispatch.md](../features/payment-dispatch.md) · [cycle-closeout.md](../features/cycle-closeout.md) · memories `dispatch-paid-toast`, `supabase-realtime-anon-rls-dead`.

---

## Wed Sep 2

### Manager Time Adjustments becomes a review workspace · `62c8312e` · `840f0f77` · `b97637e3` · `0ce0fa64`
> *"Manager - Time Adjustment - Fix the Polling Issue please"* → *"Improve the UI on this please …
> add proper caching best practices also summon Impeccable"* → *"lets open a modal with the
> information"*
> 11:22 → 13:20 · `4f0ac61c` · **`hardening`** → **`impeccable`**

The flicker was **not polling** — it was a **fetch-per-render loop**: a cached-state setter that
bailed out on equal values, so the effect re-fired forever. Fixed by ref-ing the callback and a
60-second poll. Then the surface was rebuilt as its own file plus a pure lib, themed on MESA in blue,
with the request detail as a **two-column modal that fits without scrolling** instead of a right-side
pop-in.

Doc: [time-adjustment-requests.md](../features/time-adjustment-requests.md) · memories `manager-time-adjustments-render-loop`, `manager-time-adjustments-workspace`.

### KPI Calculator branch list, shared headers, and the lock ring · *swept into `f36a97ce`*
> *"Manager - KPI Calculator - HSL Branches - Make this grid please"* → *"Add caching so I dont have
> to see that loading"* → *"Make sure they use the same headers please!"* → *"Do you understand that
> the headers should be the same?"* → *"Document that stupidity please"*
> 13:44 → 15:07 · `d6070184` · **`impeccable`**

Kane asked for the same header **three times**. The lesson is now a standing rule: **"the same" means
diff what RENDERS — never claim parity from class names** (memory `same-means-rendered-not-classnames`).

What landed: both KPI calculators share one header and a two-up row; a shared `StatusChip`
(Ready = green, Locked = black, **amber is warning only**); the "payroll is being processed" state
survives a tab switch; the HSL ↔ Departments switch animates in **both** directions; the sidebar's
KPI Calculator item wears a **rose→amber lock ring** while `payroll.dispatch_locked` is on, reusing
the existing masked-conic engine so no second `@property` is registered — and the ring **stops
travelling but stays lit** under reduced motion. Both branch lists now sort **alphabetically at the
source**, so the grid, the overlay rail, the filter dropdown and first load all agree.

Doc: [hsl-kpi-calculator-2026-07.md](../features/hsl-kpi-calculator-2026-07.md) (+349 lines).

### Manager Overview fits in one viewport · *swept into `f36a97ce`* · **undocumented**
> *"Manager - Overview - Please redesign this and make it look like this please but use our color
> theme"* → *"Make this fit in 1 view port please"*
> 13:11 → 14:00 · `3dab3af5` · **`impeccable`**

The root clips at `lg` and up with both panels scrolling internally, so the greeting, the four stats
and both panel headers stay put. Two explanatory paragraphs were cut — ~90px of permanent height
spent explaining what the rows already show — and the "+N more waiting" count is pinned below the
scroll area. **Verified 0px page scroll at 1440×900, 1366×768 and 1280×720**, three full rows even at
720px. **Mobile still scrolls, deliberately**: the viewport-lock is gated behind `lg:` because
stacking two nested scroll panes on a touch device is a trap.

**This has no feature doc and no INDEX row.** See § Open items.

### Monday board pass 22 · `8a6261b7`
> *"All withheld SP lets push it check git commits yesterday and claude sessions also we have pending
> task where we need to transfer backlogs from sprint 27 to 28"*
> 09:28 → 09:50 · `d8e408c6`

The staged pass 21 landed: **20 rows, VERIFY PASS, 28 SP still owed**.

### MESA close-out — brief posted, nothing shipped
> *"Have closed MESA things already for that refactor?"* → *"Settle everything till this closes"*
> 10:50 → 11:20 · `b0be9d89` · **`hardening`**

Read `mesa.md` in full plus all 13 `mesa-*` memories, cited ten rules, and enumerated four failure
classes — a frozen CSV expecting deposits for weeks it cannot know about (50 false discrepancies),
a CSV member with no rate row **skipped instead of failed** (the `if (rate)` blind spot), post-cutover
weeks verified by nothing, and an obligation raised and never paid. It also named a documentation
defect on a money doc: `accounting-mesa-export.md` says a closed account's history is *"retained"*
and never says the balance is **released as an obligation**.

**No commit followed.** All of it is open.

### HR Offboarding × orientation no-shows — hard stop
> *"HR - Offboarding - Offboarded - All those that did not attend Orientation should be seen in
> offboarded separate them from the HRIS and GOOGLE Sheet"*
> 10:55 → 11:00 · `eca4fe7b` · **`hardening`** — stopped, no code

Measured live first: **40 people** carry `orientation_attended_at IS NULL` with `status='no_show'`,
`no_show_at` and `deletion_processed_at` all set (37 Lead Gen / 3 AI-API, Jul 6 → Aug 31). The
no-show route **tears the account down but writes nothing to `offboarded_sheet`**, and **26 of the 40
are invisible on the Offboarded tab today**. The ask is well-founded — and it contradicts two
documented rules. Both either/ors are in § Open items.

### Labor Day × orientation invite — decision owed by Fri Sep 4
> *"There will be labor day on monday next week how are we on the Orientation Schedule for the NHCL"*
> 10:44 → 10:47 · `30aeefd5` — read-only, no code

`ORIENT_OFFSET_DAYS = 1` is **global and not configurable**, so next week's checklist week
(`2026-09-06`) resolves its orientation to **Mon Sep 7 10:00 EST** — which `us_holidays_list` in
`app_settings` **already has enabled as Labor Day**. The HRIS forgives PAB on that date while the
New Hire Checklist is about to email 31 Lead Gen hires telling them to attend on it. Nothing reads
the other; grep finds no holiday awareness anywhere near the orientation path. Full options in
§ Open items.

---

## Mon–Tue Sep 1 evening

### Payroll Wizard Reports replay carries the full saved split · `0703c748`
> *"Payroll Wizard - Reports please make sure this is all tightened up!"*
> Sep 1 19:23 → Sep 2 09:33 · `c529d5d2` · **`hardening`**

A replayed export now carries the **FULL saved split**, so every row reconciles against the paid
final rather than a recomputed approximation. The same session ran the Claude Code doctor and applied
the config choices recorded in memory `doctor-config-choices` (auto mode default, all plugins kept).

Doc: [payroll-wizard-week-replay.md](../features/payroll-wizard-week-replay.md).

### Orphanage step deletes wipe both carriers · `28bea8ac`
> *"Payroll Wizard - Orphanage Step - Can we make sure that when we delete data in here it will
> delete all the data so I can put the data back in nice and fresh?"*
> Sep 1 18:27 → 18:41 · `a2cedd5f` · **`hardening`**

A **Remove all** button, record-only row deletes, and a **snapshot-or-refuse** audit — a delete that
cannot snapshot first is refused rather than performed. Deletes now clear **both** carriers, and
"all" must be explicit.

Doc: [orphanage-pay-step.md](../features/orphanage-pay-step.md) · memory `orphanage-step-delete-all`.

---

## The five-day gap — Aug 27 to Sep 1, commit level only

76 commits, no session narrative. Grouped into deliverables so nothing is invisible; the transcripts
still exist if any of these needs reconstructing properly.

**Thu Aug 27** — 4
1. Monday: the withheld SP lands, 9 owed rows / 33 SP, ledger to zero — `fdcea807`; the auditor declares itself, 2 rows / 8 SP, VERIFY PASS — `bf9fa5c2`
2. Manager second approver = the request's own team, seat **derived not granted** — `a9901284`
3. **PAB Sun–Sat sweep — the week-model cutover had reached only 4 of 9 call sites** — `a73948a1`

**Fri Aug 28** — 23
4. **Wizard step 6 (PAB) rebuilt** — forgive the month via **disputes, not a grant blob** (`4c52f55c`); *"nobody is ineligible"* was printing over **1,557 ineligible people** (`3363e590`); Employee column showed emails not names (`8f85e3be`); Failed days beside the Forgive buttons (`119129b6`); calendar modal goes wide, verdict to a right rail (`1641f91b`); department + status filters (`8b3d7de1`) reading from the **Payment Catalog, not raw keys** (`2def4f07`), portalled (`7843a508`); Employee ID column (`5fdff012`); KPI strip replaces the banner (`ad8c5839`); eligible count with checkable arithmetic (`ac94b91a`); PAB covers active GML people **with hours** (`d3486661`) — a leaver with no hours had been ranked the worst attendance in the company (`d6036145`)
5. **HSL + Additions become ONE step**, HSL keeps its own TAB, rail renumbered 1–8 — `9a42f5f2` `bb4b2311` `1b262488` `a84146cb`; the Departments/HSL switch glides — `4b8f7177`
6. **HR Offboarded is ONE tab, origin STORED not guessed**, backfill insert-only — `a366c067` `cd681cf8`
7. Documents: signature can be **TYPED**, and the pointer lands on the ink — `3fb27b1d`
8. Dispatch: Kolan's plated card takes the dark lockup — `c229a2b8`
9. Monday: the undeclared fortnight, 10 rows / 45 SP, VERIFY 220/220 — `4dc683c6`; a phase-1 budget death queues nothing — `6ae82ac5`

**Sat Aug 29** — 4
10. Start Processing is a synthesized Lamborghini V12 — `e3613f41`
11. Team Rankings is Kane's alone, admins included — `50c05777`
12. Monday: the withheld 4 SP lands — `898830c9`
13. Wizard missing-CSV dialog stops claiming an auto-sync — `cc10258a`

**Mon Aug 31** — 7
14. **THE 1:1 RULE — the receiving bank drives the send-from rail** — `b8b1f3fc`; gate the RECEIVING side so the coupling stays one-way — `debac13d`; the pickers judge the **EFFECTIVE** rail, not tier 1 — `ce4f2302`
15. **The double-pay guard was red because the TEST was wrong** — `47ed47ef`
16. Two Start Processing candidates on the bench, V12 untouched — `449f8d62`
17. Docs: the last 10 sessions left **three undocumented surfaces and a red guard** — `3bac1ff6` (adds `hsl-catalog-migration.md`, `pay-structure-no-department.md`, `salaried-pay-basis.md` + a 536-line audit script)

**Tue Sep 1** — 24
18. Wizard: Preview Emails wears the wizard chrome and shows the **WORK** email — `541b6dfb`
19. **PAB step**: the payout week owns the tab, Ignore is the other verdict — `7428e866` `e8e8c6ae`; decided rows leave the list, paused depts skip it, HSL fails as weeks — `a2b428db`; Done tab of receipts + realtime decisions across open wizards — `377834e5`; the tab switch slides — `7ca5ceaf`; a no-hours day/band is **amber, never grey** — `7cd45fa2` `3b21a7ce`; confirm in the app's dialog, not `window.confirm` — `bc731dd6`
20. Wizard rail: **PAB moves BEFORE Additions** — 4 PAB, 5 Additions, 6 Contractors — `1f7a631d`
21. Readiness: No Pay Rate rows can be **Ignored for one week** — `225481a2`
22. Issues: Bank Preferred requests become **ROWS in the table**, not a card above it — `5f638846`; default filter All, KPI cards always count ALL — `fba536de`; decided requests are no longer immutable, Edit + Delete — `9b2efb88`
23. **People → Offboarded search tab** (search · pay · bank) — `5a7c066b` `2c0f7666`; console treatment, Employee ID column, typing-only debounce — `d1dc97d4`; the readout speaks the query term — `dc1b6260`
24. Sound: Start Processing plays `truckstart.mp3` in both Wizard and Dispatch — `9306ee19` `978500d7` `7424aa7a`
25. Documents: **Generate COE from the Signing Queue** — accounting issues and signs on the employee's behalf — `6d16bd70` `604abd10`
26. Termination docs: live search console on Step 1, smoothed scan line — `90812026` `bf43c86a`
27. **HSL KPI branches become a list** opening a Windowed/Half/Full overlay, SSD rebuilt — `276e6d7f` `db69b335`; paint caching across the tab-switch unmount, scoring held until week+catalog+FX are live — `9ddf772f` `c502457c`; manager shell paint cached across unmount and reload — `ad869220`
28. Orphanage step: **CAS the additions blob**, Restore-from-record on the red panel — `27328af3`; `2547b719` "ORPHANAGE UI"
29. Payroll Notes: shared edit rights — any wizard editor deletes/applies any row; **page the board past 1000** — `e62f30e8`
30. Monday pass 21 staged, not applied — `9d9ce8b6`

---

## Open items

| # | Item | State |
|---|---|---|
| 1 | **82 duplicate paid rows in production** (81 groups) | `scripts/dedupe-payment-dispatches.mjs --apply` **never run** — blocked by the permission classifier. `d406e7c9` stops new ones and is pushed; deploy first, then run. `alonzos@` may be a **real** double payment and is excluded. |
| 2 | **Labor Day orientation collision** | Invite fires on Lock-in, **Fri Sep 4 ~20:15 UTC**. Options: (1) keep Mon Sep 7, no change; (2) move that week to Tue Sep 8 — needs a **per-week override** on the period row read by both the webhook and `formatOrientationLabel`, a `blueprint` build; (3) hold the lock and send late. Separately: the lock dialog should cross-check `us_holidays_list` and warn — a `hardening` change. **Kane's call.** |
| 3 | **Orientation no-shows → Offboarded, conflict 1** | 26 of 40 no-shows are invisible on the tab. (a) doc stands → insert them into `offboarded_sheet` + widen the CHECK to a third origin, but that makes **`cathypa@` (Temporary Pause, actively paid) and `chiezelr@` assert a departure**; (b) doc is stale → derive no-shows LIVE as a third origin, no money-surface reach, and rewrite `offboarding-automation.md:335` + INDEX 27. **Session recommended (b).** |
| 4 | **Orientation no-shows → Offboarded, conflict 2** | *"All those who did not attend"* is 40 staged hires under the doc, or ~407 if the 367 listed-but-never-staged are included — which would render as departures people who were never onboarded. **Kane's call.** |
| 5 | **MESA close-out** | Full brief exists in `b0be9d89`, **zero commits**. `accounting-mesa-export.md` still says a closed account's history is *"retained"* without saying the balance is **released as an obligation** — an omission on a money doc. `mesa.md` still silent on obligations, the shortfall ruling and the disbursement guard. |
| 6 | **Monday pass 23** | `cc31fe46` says STAGED/NOT APPLIED; the ~250-call apply was **still running** at hand-off and was never verified. **Re-read the board before pass 24.** |
| 7 | **Orphanage interns migration** | `2026-09-02_orphanage_interns.sql` pending Kane's `--apply`; `f9acc1a5` handles the already-created-table case. |
| 8 | **Pay Processors → Payment Dispatch** | The registry ships; the PD integration that consumes it does not. |
| 9 | **Two undocumented surfaces** | **Manager Overview redesign** — no feature doc, no INDEX row, and its commit is called `Push`. **Employee My Hours calendar** — five commits of design work, no doc. |
| 10 | **8 unpushed commits** | `1f5b3ce4` → `cc31fe46`, including both new Payment Catalog tabs. |
| 11 | **2 pre-existing test failures** | Reported by three separate sessions, both in Manager files: a raw department cell in `ManagerApp.tsx` and an unformatted hours interpolation in the Overview gallery. Suite otherwise 2,098 passing. |

---

## Conventions this window confirmed

- **`Push` as a commit message costs the work its provenance.** Two deliverables in `f36a97ce` are
  unfindable from `git log`. Neither session did anything wrong; the sweep did.
- **"The same" means diff what renders.** Class-name parity is not parity — memory
  `same-means-rendered-not-classnames`, earned by being asked three times.
- **Measure before proposing.** `eca4fe7b`, `30aeefd5` and `b0be9d89` each opened with a read-only
  production measurement, and in all three cases the measurement is what defined the question.
- **A hard stop is a result.** Three sessions closed with no code and are more valuable for it than
  a guess would have been.
