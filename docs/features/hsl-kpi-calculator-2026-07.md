# HSL KPI Calculator — dept changes + external members + Managers Weekly

A batch of changes to the manager-facing **HSL KPI Calculator**
(`src/components/manager/HslBonusCalculator.tsx`, driven by
`src/lib/hsl-bonus/schema.ts`): three new per-unit departments, a new bespoke
"Managers Weekly" department, an "Add external member" flow on every department,
and the removal of five stale departments.

Built 2026-07-17. All HSL bonus rules remain hardcoded in `schema.ts` — the
single source of truth the calculator, PayrollWizard HSL step, Bonus History,
and employee KPI results all read.

## Department changes (`HSL_DEPTS` in `src/lib/hsl-bonus/schema.ts`)

| Dept key | Name | Cadence | Rules |
| --- | --- | --- | --- |
| `callback_team` *(new)* | Callback Team | weekly | Medicare Sign Ups × ₱250 |
| `simple_texting` *(new)* | Simple Texting | weekly | Transferred Calls × ₱50 · Sign Ups × ₱250 |
| `medical_records` *(new)* | Medical Records | weekly | Patient Portal Log Ins × ₱250 · RFC × ₱250 **⚠ CONTRADICTED BY CODE — [schema.ts:178](../../src/lib/hsl-bonus/schema.ts#L178) has `portal_login rate: 100`, not 250. The code produced every stored value, so this cell is the likely typo — but if ₱250 is right this is a live underpayment, not a doc defect. UNRESOLVED, Kane's call; see `hsl-catalog-migration.md` §1.2.** |
| `hsl_managers` *(new)* | Managers Weekly | weekly | bespoke per-manager checklist (see below) |
| `attestation` *(new 2026-07-21; rules extended 2026-08-24)* | Attestation | weekly | Attested Cases tiered (25→₱50 · 35→₱75 · 50+→₱100 per case; thresholds corrected 2026-07-27 to match the sheet formula — Filing Specialist still uses 30/40/50) **+ Referral Leads ×₱250 · SSA.Gov ×₱250** (see §Attestation additive terms) |
| `case_managers` *(new 2026-07-22)* | Case Managers | weekly | Reviews ×₱250 · RFC ×₱250 · PPL ×₱100 · DME ×₱250 · Task ×₱250 · Referral Leads ×₱250 |
| `post_hearing_prep` *(renamed)* | Pre-Hearing / Post-Hearing Prep | weekly | unchanged (Portal Login ₱100 · 5-Star ₱250, ₱3,500/wk cap) |
| `case_manager` *(removed 2026-07-17; superseded by `case_managers`)* | — | — | was 6 per-unit KPI rules, ~50 members |
| `case_mgr_no_kpi` *(removed)* | — | — | was an empty roster-only placeholder |
| `chelzy_asst` *(removed)* | — | — | was a flat $10/mo |
| `vicky_asst_tl` *(removed)* | — | — | was a flat ₱2,500/mo (already 0 members) |
| `case_mgmt_asst_tl` *(removed)* | — | — | was roster-only, 6 members |

Notes:
- **Medical Records vs SSD Medical Records.** The existing `ssd_medical_records`
  (team-accuracy split: 90 % → ₱250 / 95 % → ₱350 per record) is untouched. The
  new `medical_records` is a plain per-unit dept and lives alongside it.
- **SSD Medical Records RFC pool (added 2026-08-03).** `ssd_medical_records`
  gained a second rule, `team_pool` (`TeamPoolRule`/`calcTeamPoolShare` in
  `schema.ts`): the team's RFC count × ₱250 is pooled and split evenly across
  the sub-team's headcount — no accuracy tiering, unlike the existing
  `team_split` rule it sits alongside. Both shares are summed per employee in
  `recomputeSsdEntries`. e.g. Orange team logs 13 RFCs across 10 agents →
  13 × ₱250 ÷ 10 = ₱325/agent, added on top of their accuracy-split share.
- **Callback Team vs the sheet.** The pay-plan sheet attaches "Medicare Signups ×250"
  to the Care/Healthcare team, and `care_team` in `schema.ts` is still modeled as
  the older "Church Attendees × ₱50". That drift was left as-is by request — the
  new `callback_team` dept was created as named. Revisit if Medicare signups
  should instead reconcile `care_team`.

## Attestation additive terms *(2026-08-24)*

The manager sheet formula for `attestation` gained two additive terms:

```
=IF(Cases>=50,Cases*100,IF(Cases>=35,Cases*75,IF(Cases>=25,Cases*50,0)))
  + (Referral Leads * 250) + (SSA.Gov * 250)
```

The tiered half was already correct (2026-07-27, commit `1a58c16`) and its bands
are **byte-identical** after this change. The delta is two `per_unit` rules:
`referral_leads` → ₱250 and `ssa_gov` ("SSA.Gov") → ₱250. Mixed
`tiered` + `per_unit` in one dept is not new — `filing_specialist` has shipped
that shape since the start, and `KpiTable` renders one column per rule generically.

**The tier lands on the case count ALONE.** Referral leads and SSA.Gov never push
a scorer into a higher band, and they pay in full when cases fall below 25 and the
tiered term is ₱0. The dept has no `monthlyMax`, so nothing truncates them.

**Not retroactive — this is the part that matters on a money path.**
`hsl_bonus_entries.calculated_bonus` is frozen at save and the wizard dispatches
the stored value, so no past week reprices on its own. And a *recompute* of any
historical row returns the same number too, because rows saved before 2026-08-24
carry only `attested_cases` in `kpi_data` and `calcBonus` reads an absent key as
`0`. Measured, not assumed: `scripts/verify-attestation-tiers.mts` scanned all
**174** saved Attestation rows in the live DB after the change and found **zero**
divergence. Only weeks scored from 2026-08-24 on can carry the new terms.

Because `attestation` is `cadence: 'weekly'`, it sits inside the wizard's
unconditional `hslKpiAmounts` auto-pay pass (see *Dispatch wiring*) — the new
terms reach the emailed paystub with no toggle. **Accounting must not also key
them into the Adjustment column**; that double-pays.

Schema-only change: no SQL, no column, no roster or grant work (`kpi_data` is
free-form JSON and the dept already exists). Pinned by `schema.test.ts` — a full
0..120-case sweep crossed with lead/SSA counts against the sheet expression, plus
explicit tests that the extras cannot lift the tier and that key-absent rows
recompute unchanged. `scripts/verify-attestation-tiers.mts` sweeps the whole
formula now, not just the tiered half.

**OPEN (unchanged):** `filing_specialist` still uses the old 30/40/50 "Attested
Cases" bands and did **not** receive these two terms. Different dept, different
pay — Kane has never confirmed the correction applies there.

## Managers Weekly (`hsl_managers`)

The one dept whose scoring differs **per person**. Each manager has a hardcoded
checklist of incentive components (`HSL_MANAGERS` in `schema.ts`), each a fixed
peso amount earned when ticked; the row total sums the ticked components
(`calcManagerBonus`). Amounts come from `docs/reference/managers-logic.md`.

- **Cohort is hardcoded** — the dept seeds its lineup from `HSL_MANAGERS`, so it
  needs **no `hsl_team_members` roster rows**. (Gyd, Eula, Andre, Vee, Ems, Star,
  Jazz, Mariel, Dan, Julie, Jay.)
- **Cumulative tiers as independent checkboxes.** Hitting a higher tier means the
  scorer ticks every lower tier too, and they SUM — matching the sheet's
  `=SUM(...)` totals (e.g. Andre "< 2 Days" ⇒ <3 + <2.5 + <2 ⇒ ₱7,500).
- **Attendance (₱5,000) and Tech Allowance (₱1,850) are deliberately excluded** —
  they are already paid by the PAB + Technology bonus engine; modeling them here
  would double-pay.
- **Monthly components** (Gyd's ₱25,000; Ems/Star/Jazz "Monthly Performance
  Bonus") carry `cadence: 'monthly'` and show a "monthly" badge — the scorer ticks
  them only in the final payroll week of the month.
- Rendered by `HslManagersTable`; scored via `recomputeManagerEntries` /
  `calcManagerBonus`.

## Add external member (all HSL depts)

Every dept now has an **Add member** button (always available, even for an empty
dept). It opens `HslAddMemberModal`, which searches the Global Master List via
`/api/manager/transfer-candidates` (the same endpoint the transfer picker uses,
so a plain manager needs no extra permission), then a confirm step.

- Purely client-side add: an off-roster `EntryRow` is appended to the dept's
  entries and flows to payroll through the normal autosave → Mark Ready path. No
  employee / roster / permission record is created — the saved `hsl_bonus_entries`
  row is the single source of truth (the POST route does no roster validation).
- External members are tagged with an **"ext"** badge (email not in the dept's
  roster) and can be removed. Removing one that was already persisted also DELETEs
  its saved row (`DELETE /api/hsl-bonus/entries?dept&period_start&email`).
- Works for every dept type: per-unit (`KpiTable`), team-split
  (`SsdEmployeeTable` — assign a sub-team to give them a share), and Managers
  (`HslManagersTable` — an external here has no incentives configured and scores
  ₱0).

## Data entry & motion (operator-focused redesign)

Same-day pass to make scoring fast and give immediate feedback, staying within the
product register (calm, familiar, motion conveys state):

- **Stepper inputs** (`StepperInput`) for per-unit counts: type a value or nudge
  with −/＋. Focus selects the field so typing replaces; the native spinners are
  hidden for larger touch targets; values never drop below 0. The −/＋ buttons are
  `tabIndex={-1}` so Tab still flows field-to-field for keyboard entry.
- **Animated totals** (`AnimatedPeso`): every live figure (row bonus, subtotal,
  dept total, grand total, SSD per-member share) gives a brief "counted" pop when
  it changes, so the operator sees their entry land. CSS-only (`kpi-value-pop` in
  `src/index.css`), self-disables under `prefers-reduced-motion`.
- **Managers checklist** rows are full-width tappable toggles; a met incentive
  highlights purple with a soft confirm sweep (`kpi-row-confirm`) and shows its
  amount. A footer note explains tier-stacking and the monthly rule.
- **Draft-only editing:** inputs are editable only while the period is `draft`.
  Once `ready`/`locked` the dept is read-only (with a "Mark as Unready to edit"
  hint), so an edit or an added member can't silently fail to reach Accounting.

## Autosave *(2026-08-17 — replaces the Save button)*

Kane: "Instead of Saving Manually every field entered should just be
automatically saved." **There is no Save button on either calculator any more**
(`HslBonusCalculator` and `DeptBonusCalculator` in manager mode); entries persist
~1s after the manager stops typing. The footer reports `Saving…` → `Saved HH:MM`,
or `Not saved — retries on your next edit`.

**Submission is untouched and stays manual.** Autosave replaced the Save click
only — Mark Ready (HSL) and Lock → Submit to Payroll (departments) are still
deliberate acts, because the `hsl_bonus_period_status` row is what actually tells
Accounting a week is done. Scored entries with no `ready`/`locked` row have gone
unnoticed before, to the tune of ₱846,475 (memory
`hsl-bonus-weeks-never-submitted`).

Every refusal the Save button carried now lives in ONE pure, tested place —
`kpiAutosaveGate` in `src/lib/manager/kpi-autosave.ts`
(`src/lib/manager/kpi-autosave.test.ts`). Autosave never fires:

| Refusal | Why it exists |
|---|---|
| before the dept has loaded | nothing trustworthy to write yet |
| before the Hubstaff payroll week resolves | `(department, period_start)` is the row's only address and the seed week is a local-clock guess — writing early strands rows no reader asks for |
| into a `ready`/`locked` week, or a dept whose values are locked for submit | draft-only editing, above |
| while payroll is processing | the server answers 423 (`processing-guard.ts`) |
| while a write is in flight | no double-write |
| **on load-seeded state** | a fresh draft week arrives with dept-common bonuses pre-ticked and QC first-pass values copied in, flagged dirty on purpose. Persisting that automatically would mean merely OPENING the calculator writes `bonus_catalog_applied` rows attributed to whoever opened it. `DeptState.seeded` records "nobody typed this"; every mutator clears it in the same state update that sets `dirty`, so the two cannot disagree. |
| re-sending a state that just failed | a failure leaves the dept dirty, so a naive debounce would retry forever. The hold lifts on the manager's next edit. |

Three things follow from autosave and must not be undone:

1. **A failed write leaves `dirty` set**, which is what keeps the Mark Ready /
   Lock gates honest. Those gates did not move into the button's `disabled`
   attribute — `markReady` and `lockValues` write any pending edit FIRST and
   refuse to change status if that write fails. `dirty` no longer disables the
   button (blocking during the 1s debounce just looks broken).
2. **`dirty` clearing after each write is a net WIN for concurrent scorers.**
   Every load path and `refreshAll` skip a dept while `dirty || saving`, so under
   the old Save button a manager's local view stopped refreshing for their whole
   editing session. Autosave shrinks that stale window to seconds.
3. **A pending write is flushed on tab-hide, `pagehide`, and unmount.**
   `ManagerApp` unmounts the calculator when the manager leaves the tab, so the
   debounce would otherwise die with the last keystroke. The flush closure is
   held in a ref, because an empty-dep effect would capture `weekResolved` from
   the first render — when it is still `false` — and refuse to save.
   *Residual bound:* closing the browser tab within ~1s of the last keystroke can
   still lose that keystroke.

**The two write contracts are NOT symmetrical**, which is why the seeded guard
matters most on the department side:

- `POST /api/hsl-bonus/entries` is an **upsert** on
  `(department, period_start, employee_email)` and rejects an empty array;
  removing a member is a separate keyed `DELETE`. Autosave can only ever add or
  update here.
- `bonus_catalog_applied` (`saveDeptPeriodApplied`) is a **replace-set**: it
  upserts the payload then deletes every row for that dept-week that is not in
  the keep-set — **unfiltered when the keep-set is empty**. So a manager who
  unticks the last bonus in a department autosaves an empty set and clears the
  dept-week. That is the same thing the Save button did with nothing ticked, and
  the 1s debounce means an untick→retick never fires the empty write in between.
  Worth knowing before "optimising" the debounce away.

**Out of scope, deliberately:** the **QC officer** variant (`variant="qc"`) keeps
its explicit Save + "Lock & send to manager" — different role, different table
(`qc_kpi_submissions`), different route, and its delete is officer-scoped.

**Also affected, by being the same component:** the KPI Calculator modal
Accounting opens from Payroll Readiness (`PayrollWizardNotesFab.tsx`) autosaves
identically, and closing that dialog now flushes pending edits instead of
dropping them.

### SSD sub-team inputs are still NOT saved

`ssd_medical_records` scores from team-level accuracy %, record count and RFC
count that live in component state and are deliberately not persisted (only the
per-employee share they derive is). Kane confirmed 2026-08-17 that this stands —
autosave covers every field that HAS a persistence home, and these three keep
their in-memory behaviour plus the amber re-enter warning.

That made an existing latent bug reachable without a click, so it is now closed:
after a reload those fields are blank while the saved shares are not, and any
recompute would have written **₱0 to every member of the team**.
`recomputeSsdEntries` now refuses to overwrite a non-zero share when the
sub-team it belongs to has no inputs on screen (`subTeamInputsBlank`). A typed
`0` counts as entered, so a genuine zero score still saves.

## Deploy / migration

Run **`references/sql/migrate/2026-07-17_hsl_bonus_dept_changes.sql`** once in
Supabase after deploying:

1. Clears `hsl_team_members.dept_key` for the five removed depts (members become
   unassigned but stay HSL employees; PAB/Tech unaffected). Reassign any of them
   to a new dept by editing the optional block.
2. Soft-revokes the `hsl:<key>` grants in `department_managers` for removed depts.
3. Optional blocks: populate the new teams' rosters, and hard-delete historical
   bonus rows for removed depts (kept for audit by default).

The new `callback_team` / `simple_texting` / `medical_records` depts start EMPTY —
populate them via the migration's dept_key block **or** the calculator's Add
member button. `hsl_managers` needs no roster work.

**No schema change to `hsl_bonus_entries`** — external members and the new depts
reuse the existing columns; the feature is client + `schema.ts` only.

## Dispatch wiring (auto-pay all weekly HSL KPI bonuses)

Previously dispatch auto-paid HSL KPI from **SSD only** (`ssdKpiAmounts` via the
`KPI_BONUS_ID` toggle); every other HSL dept showed in the HSL review total but
never reached the paystub unless Accounting keyed it into the Adjustment column.

Now (`src/components/PayrollWizard.tsx`):

- A single always-loaded `hslKpiAmounts` map sums `calculated_bonus` per employee
  across **all weekly HSL sub-departments** (SSD, Medical Records, Callback, Simple
  Texting, Care, Filing, Intake, Pre/Post-Hearing, Managers Weekly), **pinned to the
  processed Hubstaff week**. SSD is included, so it fully replaces the old SSD-only
  amount (no double count). It clears when no Hubstaff week is loaded, so it can
  never pay a different week's score.
- **Managers-dept monthly components** (Gyd's ₱25k; Ems/Star/Jazz's ₱2,500) are
  recomputed from `kpi_data` and only counted in the **final payroll week of the
  month** (`isFinalPayrollWeekOfMonth`), matching how PAB/catalog monthly bonuses pay.
- The amount is **auto-applied unconditionally** in `bonusTotals` (a dedicated
  `hogan_smith_law` pass, rate-gated exactly like dispatch) — **not** behind a
  toggle. So the emailed paystub equals the HSL tab review Total Pay by construction,
  with no toggle that can fall out of sync. The Additions "KPI Bonus" column shows
  the amount as read-only ("auto-applied").
- The HSL review (step 4's HSL tab since the 2026-08-28 Additions merge; step 4 as its
  own step before that) reads the same `hslKpiAmounts` (rate-gated), and its per-dept
  cards pin weekly depts to the processed week — so review == dispatch.

**Process change — important:** with auto-pay on, **stop keying HSL KPI amounts into
the Adjustment column by hand** — that would now double-pay. The Adjustment column is
only for genuine one-off deltas (and is how you make a per-person exception).

**Still manual (unchanged):** the three **monthly-cadence** HSL depts —
`collections`, `healthcare_team_lead`, `collections_tl` — are excluded from auto-pay
(monthly final-week gating for whole depts is riskier and out of scope here). Their
review cards are badged **"manual · Adjustment"**; apply those via the Adjustment
column as before.

## First-load reveal *(2026-08-24 — the skeleton was terminal)*

One tab renders two calculators and each had grown its own first-load gate:
`DeptBonusCalculator.ready` (derived) and `HslBonusCalculator.booted` (a latch
set from an effect). **Both waited on data that a failed week-resolution never
produces**, so `KpiCalculatorLoading` — a shimmer of the real chrome — became the
final state. It reads as a page still working, forever.

Both components already held the right thing to show: an identical rose
*"Couldn't confirm the payroll week"* alert. In both it renders **inside** the
chrome the gate was withholding, so the gate hid the only surface that could
explain the gate.

The rule now lives in one place both call — `kpiCalculatorRevealed`
(`src/lib/manager/kpi-calculator-reveal.ts`, tested):

> **An unresolvable payroll week is TERMINAL, not pending.**

| Failure | Was | Now |
|---|---|---|
| Departments | `ready` required every visible dept `loaded`, but `loadDept` returns early until the week resolves, so no dept ever loaded | `weekError` releases the gate; cards show their own per-card loading state under the alert |
| HSL | `booted` had `weekResolved \|\| weekError`, but `weekError` is set *after* the boot effect settled and was neither a dep nor part of `loadDept`'s identity — so the effect never re-ran to observe it | `booted` is **derived every render** (`loadsSettled` + `weekError`), so it cannot be re-broken by a dependency list |

**This loosens nothing.** `loadDept`'s early return stays — reading the
local-clock seed week is what made another manager's applied bonuses look absent.
Every read and write remains held on `weekResolved` at its own site, and
`kpiAutosaveGate` refuses on the same flag (see Autosave, above: writing early
"strands rows no reader asks for"). Three independent holds; this gate was never
one of them, it only looked like one. On the departments side an unresolved week
also leaves `state[k]` undefined for every dept — every card reads through `d?.`
and the autosave loop skips a dept with no state — so a released gate cannot
present an empty week as a scored one.

**Root cause is upstream.** The week is derived from the Hubstaff batch
*filename*; an undatable name resolves to nothing. That is now refused at ingest
— see `csv-imports.md` §4 → Hubstaff → *Filename contract*.

## Known gap (low, not fixed)

- **Removed depts still show on Employee Dashboard.** `getEmployeeKpiResults` has no
  dept-key filter, so historical ready/locked rows for the removed depts keep
  surfacing (labeled with the raw key). The migration's "inert" note is inaccurate
  for this one employee-facing path. Cosmetic; the data was already visible pre-change.
