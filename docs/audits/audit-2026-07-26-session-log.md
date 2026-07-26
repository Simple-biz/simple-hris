# Session Log — Claude Sessions Jul 23 (evening) – Jul 26, 2026

Reconstructed from Claude Code session transcripts. Covers the ~44 working
sessions between the previous audit's cutoff (Jul 23 evening ET) and Jul 26,
2026, grouped by day, newest first. Each entry lists what was asked, the
commit(s) it produced, and an effort size (assistant-turn count as a rough
proxy for depth).
Continues [audit-2026-07-23-session-log.md](./audit-2026-07-23-session-log.md).

---

## Big themes this stretch

1. **The Readiness dashboard matured into a real pre-flight check (Jul 23–25).**
   What started as a status list inside the Payroll Wizard's "Adjustments and
   Notes" FAB became an actionable dashboard: departments with no Payment
   Catalog bonus auto-read **Ready**; the No-Pay-Rate and Bank-Info lists got
   inline **Set rate** / **Set bank** fixers (Set bank offers **Wise** with the
   full wire field set); clicking a KPI department opens **its own** KPI
   calculator in a modal (HSL rows scoped to the single clicked sub-branch);
   every change made from Readiness is **audit-logged with a source** and reads
   back in Payment Catalog as "Set from Payroll Wizard by ⟨actor⟩"; each
   dimension shows a live **percent**; Bank Info gained department +
   "Paying this week" filters. The capstone was the **score recalibration**
   (`552aec6e`): 192 people missing bank info could no longer coexist with a
   94/100 score — missing bank **on this week's payroll** is now a hard blocker
   (bank pinned to 5/25, grade `blocked`), verified by running the *real*
   `getPayrollReadiness()` from the CLI (`scripts/verify-readiness.mts`).
   See [payroll-readiness.md](../features/payroll-readiness.md).
2. **Payment Catalog grew a Department creator — self-contained by design
   (Jul 24).** A new Payment Catalog **Department** tab creates departments
   in-app (sub-departments, ≥1 manager, a rate, staged creation animation).
   Mid-session Kane pivoted the design: **no writes to the Global Master List
   or the Google Sheet** — members live in an `app_settings` registry. In-app
   departments then had to surface everywhere: dashboards' department
   dropdowns, manager KPI surfaces + bonus assignments, catalog rate
   resolution, Readiness, and finally the **Payroll Wizard itself** so the new
   "Executive Assistants" department (cjm@, ellyt@, jamec@ hard-transferred in)
   actually gets paid. Commits `5359889 → 83d81c5` + the wizard wiring.
   See [payment-catalog-departments.md](../features/payment-catalog-departments.md).
3. **The Payroll Wizard now shows every department, and can exclude one per
   week (Jul 25).** "Why doesn't SMM Freelancer show in Additions?" unraveled
   into the wizard folding/hiding whole departments: `smm_freelancer` was
   normalized into `smm`, `hsl:*` people scattered, and unknown master-list
   departments had no tab at all. Now **every master-list department is
   visible** (derived slug tabs; `hsl:*` → the HSL tab — pay-affecting for ~35
   people; read-only roster card for members with no Hubstaff hours). A new
   step-1 **Configuration** tab adds per-department **Pay this week** and
   **Overtime** switches — pay exclusions are scoped to the single pay week
   (`payroll.wizard.dept_pay_paused.<sourceFile>`), and excluded departments
   show an explicit "Excluded" status in Readiness.
   See [payroll-wizard-configuration-tab.md](../features/payroll-wizard-configuration-tab.md).
4. **Bank-data trilogy: Wise everywhere, a 27-person Wise seed, and the
   clobber discovery (Jul 25).** Wise was un-retired on employee-facing
   processor pickers and now collects/shows the **same wire fields as Wires**
   in People → Banking, the employee payout form, and the Readiness Set-bank
   dialog. 27 PH Global Freelancers were seeded onto Wise from the
   spreadsheet (`seed-ph-freelancers-wise.mjs`, person-first matching). Then a
   requested audit of the No-Bank list found **34 of 145 people shouldn't be
   on it — 28 of them had complete external-link submissions from Jul 21–22
   that the Jul-22 PD-Data `preferred_processor` overwrite clobbered**
   (restorable from `bank_update_history.changes`). Restoration is an **open
   decision** — see deploy notes.
5. **Transfers: unstuck, then redesigned (Jul 24).** "Apply now" transfers
   that should have applied long ago were failing on missing source-dept rows
   and unique-constraint collisions; `planDepartmentApply` now reconciles **by
   target department** (move/delete/cancel), with `scripts/clear-stuck-transfers.mts`
   for the backlog. The Manager Transfers tab was then fully redesigned via
   `impeccable` (KPI cards + activity/pipeline charts, requests-left/charts-right,
   compact paginated rows, Done-tab status chips), and Accounting → Transfers
   got 4 click-to-filter KPI cards, a search bar, and CSV/XLSX/PDF export
   (`src/lib/transfers/transfers-export.ts`).
6. **Automation + data hygiene.** A weekly **Hubstaff auto-sync** now runs the
   wizard's sync for the just-completed Sun–Sat week via n8n → 
   `/api/cron/sync-hubstaff-week` (Bearer `CRON_SECRET`; midnight ET,
   DST-aware — deliberately **not** a vercel.json cron). Deleting a Hubstaff
   week now **cascades**: its MESA deposits and `payroll.available`
   notifications are reversed (plus a one-off purge of an orphaned Jul-25
   deposit), and DATE columns render timezone-safe via `parseDateOnlyLocal`.
   A stray Hubstaff identity (randalh@hogansmith.com) was removed everywhere
   and permanently blocked at ingest (`HUBSTAFF_INGEST_BLOCKED_EMAILS`).
   The SP plan (36 epics, 230 SP) was pushed to the Monday.com board, with a
   live-sync button in Admin → Design & Specifications.

---

## Deployment prerequisites / open items at the end of this window

Everything below the line is **committed on `main` locally** (Kane's
`a327a26 "Improvements"` sweep on Jul 25 hoovered up the day's WIP —
orphanage-PAB coverage, auto-sync, wizard dept visibility, seed/audit scripts).
Kane pushes on his end.

| Step | Why |
| --- | --- |
| Import `references/n8n/hubstaff-weekly-auto-sync.workflow.json` into n8n, fill the domain + `CRON_SECRET`, **activate** | The weekly Hubstaff auto-sync has no scheduler until the n8n workflow is live; `vercel.json` intentionally omits it. |
| **Decide + run the No-Bank restoration** | 28 complete Jul-21/22 external-link bank submissions were clobbered by the Jul-22 PD-Data `preferred_processor` overwrite; old values are recoverable from `bank_update_history.changes` (audit: `scripts/audit-nobank-external-link.mjs`). One of the 34 flagged (Chris Lawang) was a misread — a SELF-row shadow, not a clobber. |
| Watch the PH-freelancer seed edge cases | 15 of the 42 spreadsheet emails weren't in the master list (not seeded); joshs' prior `x1153`-style tag → Wise flip is worth a spot check on the next cycle. |
| Carry-forward from the Jul-22 window (if not yet run in Supabase) | `2026-07-22_employee_notifications_add_bank_preferred_type.sql`, `2026-07-22_employee_notifications_add_bank_override_type.sql`, `2026-07-22_hsl_case_managers_dept.sql` (+ Hogan Payplan Sync + role grant). DDL still has no path from this environment. |
| Confirm Vercel Production built past `a327a26` | The Jul-22 pipeline stall precedent: confirm Production is building from `main` before diagnosing any "not on the live site" report. |

**Removal reminder:** the orphanage-PAB auto-coverage rule is explicitly
**temporary** ("this is just temporary but soon this will change") — see the
removal checklist in
[orphanage-pab-coverage.md](../features/orphanage-pab-coverage.md).

---

## Jul 26, 2026

### Documentation refresh *(this session)*
`5e63706b` · **docs**
- "Look through the last 15 Claude sessions and update our Documentation and
  Features." Produced this audit + new feature docs (payroll-readiness,
  payment-catalog-departments, payroll-wizard-configuration-tab,
  hubstaff-weekly-auto-sync) + updates to the transfers/MESA/bank-preferred/
  CSV-imports/wizard docs and the docs index.

## Jul 25, 2026

### Readiness score recalibration — "192 missing bank but 94/100?"
`552aec6e` · ~291 turns · **major**
- Kane challenged the score's honesty. Recalibrated: missing bank info for
  people **on this week's payroll** is a hard blocker — bank dimension pinned
  to 5/25, headline grade `blocked`; exceptions capped; percentages surfaced.
- Verified by executing the **real** `getPayrollReadiness()` from the CLI
  (`scripts/verify-readiness.mts` + `scripts/server-only-stub.ts` +
  `tsconfig.readiness-verify.json`) — every number on the dashboard screenshot
  reproduced exactly (192 missing of 1,091 eligible; 126 on this week's run).

### PH Global Freelancers → Wise seed, then the No-Bank clobber audit
`8ec588f0` · ~169 turns · **major**
- Seeded **27** Global-Master-List people from `PH Global Freelancers .xlsx`
  with `wise_email` + last-4 tag + `bank_preferred='wise'`
  (`scripts/seed-ph-freelancers-wise.mjs`, person-first matching to dodge
  stale-id rows; 15 sheet emails had no master row and were skipped).
- Follow-up audit of the No-Bank list (`scripts/audit-nobank-external-link.mjs`):
  **34 of 145 listed people had in fact set their bank** — 28 proven complete
  Jul-21/22 external-link submissions broken by the Jul-22 PD-Data
  `preferred_processor` overwrite. Restoration path identified
  (`bank_update_history.changes`) but **not executed** — Kane's call.

### Orphanage PAB auto-coverage (temporary rule)
`b4fa82ac` · ~495 turns · **major**
- Employees excused for an orphanage visit whose Orphanage-step hours cover
  ≥7h (worked + orphanage) are auto-forgiven for short PAB weekdays — in the
  hours' file week **and the week before** (hours land one run after the
  visit). Shared `src/lib/payroll/orphanage-pab-coverage.ts` feeds all 6
  eligibility surfaces; 12 tests.
- The Karl Gonzales chase: his ✗ persisted because the week's frozen
  `pabStatusSnapshot` predated the rule — coverage now **upgrades** frozen
  verdicts. Feature doc: [orphanage-pab-coverage.md](../features/orphanage-pab-coverage.md).

### Wizard shows every master-list department
`c5e903c1` · ~174 turns · **major**
- "Why doesn't SMM Freelancer show in Additions?" Two causes: the normalizer
  folded `SMM Freelancer` into `smm` ("Social Media"), and no-Hubstaff-hours
  members had no surface. Now: `smm_freelancer` is its own tab, `hsl:*`
  members roll into the HSL tab (pay-affecting, ~35 people), unknown
  master-list departments get derived-slug tabs, and a read-only roster card
  lists members without hours. 284 tests green.

### Wise collects real wire details everywhere
`d53c984a` · ~140 turns · **medium**
- People → Banking's Payment Method now treats **Wise like Wires** — full
  bank/wire field set (bank, account holder/number, SWIFT, address) in the
  editor, the reveal, and the employee payout form — since Wise payouts land
  in the payee's bank account.

### Payroll Wizard HSL table UX
`b5ecfbc5` · ~223 turns · **medium**
- Pinned, always-visible horizontal + vertical scrollbars for the HSL table,
  text size matched to Additions, and the **KPI Bonus column hidden by
  default** behind a Show/Hide dropdown in the toolbar.

### Configuration tab hardening — sticky toggles, week-scoped
`4651f55c` · ~250 turns · **medium**
- The new step-1 Configuration tab's switches "reverted on refresh": a label
  double-fire toggled each switch twice per click (`6378bde`); exclusions are
  now saved **per pay week**, keyed by that week's Hubstaff file
  (`payroll.wizard.dept_pay_paused.<sourceFile>`, `bcbe853`); Readiness shows
  excluded departments as "Excluded" (`845d724`). Tab itself landed the same
  morning (`adc07ec`).

### Hubstaff weekly auto-sync
`9fddb763` · ~74 turns · **medium**
- Plan: auto-run the wizard's Hubstaff sync at 12AM ET when the Sun–Sat
  period closes. Built shared `runHubstaffWeeklySync()`
  (`src/lib/hubstaff/run-weekly-sync.ts`), `/api/cron/sync-hubstaff-week`
  (Bearer `CRON_SECRET`), and the n8n Schedule-Trigger workflow JSON —
  scheduling deliberately in n8n, not vercel.json.

### MESA week-delete cascade + date-only TZ fix
`527aefc6` · ~129 turns · **medium**
- An orphaned Jul-25 MESA deposit survived a deleted CSV week: purged
  (`scripts/cleanup-orphaned-mesa-week.mjs`, backup kept), and deleting a
  Hubstaff week now also reverses its MESA deposits + `payroll.available`
  notifications (`ae84df0`). The "deposit shown one day early" half was a
  UTC-shift on DATE columns — fixed via `parseDateOnlyLocal`
  (`src/lib/date-only.ts`, `0761c96`); other DATE surfaces may still shift.

### Smaller Jul 25 sessions
- **Readiness per-dimension percents** — `60c0f907` · ~44 · KPI/rate/bank stat
  tiles each return a live 0–100% (`1c9c20c`).
- **Set-bank offers Wise** — `5e6be1ce` · ~110 · Wise option with wire fields
  in the Readiness Set-bank dialog (`ba80ac6`); processor picker wrapped in
  `SmoothSelect` (`ce43654`).
- **Randal Hayes, forever** — `f52ead5c` · ~85 · his raw `hubstaff_hours` rows
  (3 uploads) purged and the email added to `HUBSTAFF_INGEST_BLOCKED_EMAILS`
  so CSV/API ingest drops him permanently (`4de0913`).
- **Readiness Bank-Info filters** — `91c4b3b0` · ~40 (department dropdown) and
  `112d276b` · ~32 ("Paying this week (N)" chip).
- **Time Adjustments week-gated** — `89db6b70` · ~44 · Additions only shows
  adjustment requests belonging to the wizard's current pay week.
- **GML defaults to table view** — `f6e55efe` · ~14 · cards one click away.
- **Processing-start sound** — `b2853ee2` · ~157 · "I don't hear the sound":
  verified in a real browser that `play()` fires `/sounds/match-accept.mp3`
  on Start-Processing confirm — code correct (environment/autoplay, not a bug).
- **Stale build error** — `068b26a4` · ~14 · "LockToggleConfirmDialog defined
  multiple times" was a stale Turbopack artifact; the component had been
  extracted to `src/components/payroll/LockToggleConfirmDialog.tsx`; tsc clean.

## Jul 24, 2026

### Payment Catalog — Department tab *(largest session; spans into Jul 25)*
`529da5fe` · ~490 turns · **major**
- "Create a Department" wizard in a new Payment Catalog **Department** tab
  (sub-departments, ≥1 manager, rate, streamed staged-creation animation, via
  `impeccable`). Mid-session pivot: **"This will no longer depend on the
  Global Master List"** — members live in an `app_settings` registry, no
  GML/Sheet writes.
- Hard-transferred cjm@, ellyt@, jamec@ into the new "Executive Assistants"
  department; made Readiness honor catalog flat rates; threaded in-app
  departments into **every** dashboard's department dropdowns.
  Commits `5359889`, `ec4482f`, `896f865`, `cbdd962`, `83d81c5`.

### Payroll Wizard pays catalog-created departments
`abcf9239` · ~172 turns · **medium**
- The wizard's Additions now includes departments created in the Payment
  Catalog ("where is the executive assistants department?") so their people
  actually get paid. Ran partly as an autonomous loop while Kane was away;
  the loop shut itself down when the work was review-ready.

### Transfers — unstuck, then redesigned (4 sessions)
- **"Apply now" backlog** — `e11d1e9b` · ~179 · **major** · overdue transfers
  failed on missing source-dept rows + the work-email/dept unique constraint;
  `planDepartmentApply` now reconciles by **target** dept (move / delete-dupe /
  cancel), a `notFound` short-circuit that blocked graceful auto-cancel was
  fixed (the Glenda case), and `scripts/clear-stuck-transfers.mts` (dry-run
  default) clears the backlog.
- **Manager Transfers redesign** — `67bbca7a` · ~212 · **major** · impeccable
  full-screen redesign: 3 stacked KPI cards + activity/pipeline charts,
  requests list left / KPIs+charts right, compact rows, pagination 15.
  Precursor: `6317d6ea` · ~29 · the first 3 KPI cards (`56664fd`).
- **Release Requests / Done tab** — `1ff33ad2` · ~158 · **medium** ·
  already-completed releases no longer prompt Release/Decline; Done tab
  redesigned (status icon chips — Applied/Released/Declined), pagination 10.
- **Accounting Transfers** — `9d2f5455` · ~47 · **medium** · 4 click-to-filter
  KPI cards, search bar, CSV/XLSX/PDF export via new
  `src/lib/transfers/transfers-export.ts` (landscape PDF); a 3-reviewer
  workflow verified zero findings.

### Readiness — audit-log source + exceptions out of the score
- `3d77a857` · ~141 · **medium** · every Readiness change is audit-logged with
  a source; a rate set from Readiness reads in Payment Catalog as
  **"Set from Payroll Wizard by ⟨actor⟩"**.
- `b15ad423` · ~38 · **minor** · onboarding-exception people were leaking into
  the score's other dimensions (`started_this_week` ⇒ `promoted` status);
  exceptions now excluded upstream in `payroll-readiness.ts`.

### Monday.com board sync + live-sync button
`313e2ff7` · ~178 + `a475ff0e` · ~73 · **medium**
- Pushed the HRIS SP plan to the "Ai & Automation Ops" Monday board —
  **36 epics, 230 SP** (Q2 131 / Q3 99), grouped by quarter from git-commit
  dates. Admin → Design & Specifications now carries the plan as code
  (`src/lib/monday/hris-plan.ts`) plus a button that re-syncs the board from
  the app on demand.

### People / Profile fixes
- **Wires reveal "empty"** — `415d5b0e` · ~100 · **medium** · people who
  self-submitted wires showed nothing on reveal; data was intact — a
  display-routing mismatch triggered by one of the Jul-22 bulk scripts
  (verified against the DB; nothing deleted).
- **Name-parts bug** — `1dc40f68` · ~90 · **medium** · a two-word First name
  no longer migrates its second word into Middle on save
  (`src/lib/name/name-parts.ts` + tests; CallTools-username dependency
  updated).
- **Neon profile modal** — `7845ed89` · ~137 + `aad8ed96` · ~58 · **medium** ·
  kaner@'s profile modal got a tech-neon treatment; the "stuck at the bottom"
  bug was `.neon-profile-modal { position: relative }` silently overriding the
  dialog's `position: fixed` centering.
- **Identity/Contact restyle** — `10c4b815` · ~72 · **minor** · People View
  modal profile table restructured; several compression iterations.

### Smaller Jul 24 sessions
- **Accounting "HR" tab: built, then removed** — `b77977bb` · ~86 built a
  dedicated HR tab surfacing the missing-bank-info Notify worklist;
  `2f843458` · ~37 removed it hours later ("we dont need this!").
- **Simple Texting KPI vanishing member** — `593ae3f4` · ~69 · fresh array
  literals per render reset the calculator; memoized (`PayrollWizardNotesFab`).
- **PD queue Department column** — `3b3c369a` · ~56 · Department moved out of
  the name cell into its own filterable column on every queue tab.
- **Employee My Hours uncapped** — `92cdb4b4` · ~17 · the "This week" card no
  longer caps Hubstaff hours at 40+5 — overtime shows in full.
- **Randal Hayes, round 1** — `b894cca8` · ~39 · removed the unknown
  `randalh@hogansmith.com` (one pending `disbursement_records` row); he
  returned with the next upload, which led to the Jul-25 ingest blocklist.

## Jul 23, 2026 (evening)

### Readiness fixers arc
`fbbf1287` · ~251 turns · **major** + `c1e16c2c` · ~47 · **minor**
- Departments with no Payment Catalog bonus auto-read **Ready** (`27cac2f`,
  refined by `565d7b0` — the legacy built-in-formula guard dropped since the
  KPI calculator is catalog-driven); inline **Set rate** modal (incl. HSL
  sub-branches) and **Set bank** (Wise treated like wires, `29ab015`);
  clicking a KPI department opens its calculator in place (`42de731`), and an
  HSL row opens **only that sub-department's** calculator (`7b5f36c`).
- Adjacent commit the same hour: `fc4d3ff` — Payroll-Notes adjustments reach
  Validation/Dispatch reliably (pull on steps 7/8, lock-gated) + the board no
  longer clobbers in-flight typing.

---

*Transcript stragglers:* two Jul-16 MESA continuation files (`f6c3a1e1`,
`5fa5f613`) were touched in this window but only errored with "prompt too
long" — no work performed.
