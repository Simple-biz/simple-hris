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
| `medical_records` *(new)* | Medical Records | weekly | Patient Portal Log Ins × ₱250 · RFC × ₱250 |
| `hsl_managers` *(new)* | Managers Weekly | weekly | bespoke per-manager checklist (see below) |
| `attestation` *(new 2026-07-21)* | Attestation | weekly | Attested Cases tiered (25→₱50 · 35→₱75 · 50+→₱100 per case; thresholds corrected 2026-07-27 to match the sheet formula — Filing Specialist still uses 30/40/50) |
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
  entries and flows to payroll through the normal Save → Mark Ready path. No
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
`KPI_BONUS_ID` toggle); every other HSL dept showed in the step-4 review total but
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
  toggle. So the emailed paystub equals the step-4 review Total Pay by construction,
  with no toggle that can fall out of sync. The Additions "KPI Bonus" column shows
  the amount as read-only ("auto-applied").
- The step-4 review reads the same `hslKpiAmounts` (rate-gated), and its per-dept
  cards pin weekly depts to the processed week — so review == dispatch.

**Process change — important:** with auto-pay on, **stop keying HSL KPI amounts into
the Adjustment column by hand** — that would now double-pay. The Adjustment column is
only for genuine one-off deltas (and is how you make a per-person exception).

**Still manual (unchanged):** the three **monthly-cadence** HSL depts —
`collections`, `healthcare_team_lead`, `collections_tl` — are excluded from auto-pay
(monthly final-week gating for whole depts is riskier and out of scope here). Their
review cards are badged **"manual · Adjustment"**; apply those via the Adjustment
column as before.

## Known gap (low, not fixed)

- **Removed depts still show on Employee Dashboard.** `getEmployeeKpiResults` has no
  dept-key filter, so historical ready/locked rows for the removed depts keep
  surfacing (labeled with the raw key). The migration's "inert" note is inaccurate
  for this one employee-facing path. Cosmetic; the data was already visible pre-change.
