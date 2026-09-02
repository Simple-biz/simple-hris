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

## Branch list + overlay, SSD workspace rebuild *(2026-09-01)*

Two changes, one pass. Reference: `references/UI improvement request/design_handoff_bonus_run/`.

### Branches are a two-column grid of rows, not a stack of accordions

`HslBranchList` replaced the stack of collapsible dept cards. One row per branch:
colour bar, name, cadence + period, status chip, headcount, total, chevron.
Picking a row opens that branch in an overlay.

Kane's call (2026-09-01). The accordions made page height depend on what was
open, so two branches could never be compared without scrolling past a full
roster, and the scoring surface was always squeezed into whatever width the
stack left it. `manualOpen` / `isOpen` / `toggleOpen` / `gridMode` are gone, and
`DeptBlock` no longer takes `collapsible` / `open` / `onToggleOpen`.

**Two rows per line, not one** *(Kane, 2026-09-02)*. The first cut was one
full-width row per branch. A manager with a dozen branches read them as a narrow
column with two thirds of a desktop viewport empty beside it, and the last row
sat well past the fold. `grid-cols-1 lg:grid-cols-2` — two columns from `lg`, one
below it. **An `auto-fill` card grid was tried in between and reverted** (Kane,
same day): the row is the presentation, the column count was the only problem
with it. Don't re-derive the card version.

The row was always built to wrap — that is what `basis-40` on the name block is
for — so the narrow case degrades by dropping the figures onto a second line
rather than crushing them. The figures' fixed widths came down with the column
width (`sm:w-14` headcount, `sm:w-28` total) because half the width now carries
the same four marks, and they stay fixed so each column still scans straight
down. `h-full` on the button keeps the pair on a line the same height when one
branch name wraps.

Rows are **separate bordered boxes**, not one `divide-y` container: with an odd
branch count a shared container leaves the bottom-right cell empty and its border
half-drawn.

**The skeleton mirrors the grid** — `KpiCalculatorLoading`'s `hsl` variant uses
the same `grid-cols-1 lg:grid-cols-2` and `HslBranchRowSkeleton`. A
single-column placeholder would reserve N rows where the data lands in N/2.

### Status chips: Draft / Ready / Locked *(2026-09-02)*

`src/components/manager/kpi-status-chip.tsx` — **shared by BOTH calculators**
(the HSL branch grid, the `DeptBlock` header, and the Departments landing rows),
so one status can never read two ways across the two tabs a manager switches
between all day. The three states are a ladder — nothing entered yet, the manager
has signed off, payroll has taken it — and are drawn as one:

| Status | Chip | Glyph |
| --- | --- | --- |
| `draft` | hollow, `zinc-300` border, no fill | `CircleDashed` |
| `ready` | filled `emerald-700`, white text | `CheckCircle2` |
| `locked` | filled `zinc-900`, white (inverted in dark) | `Lock` |

Before this they were three pale washes of the same weight at 9px, which made
"draft" and "ready" the same shape at a glance across a wall of branches — and
the two calculators disagreed with each other: HSL painted `ready` **amber**,
Departments painted `locked` amber, and amber is reserved for warnings everywhere
else in this app (see the cache chip in the same top bar, and
`wizard-step2-header-cards`).

**Ready is green** (Kane, 2026-09-02) — the manager's own sign-off, and the state
they scan the list for. That pushes `locked` onto the terminal ink instead: green
means *you* finished, black means payroll did and nothing moves now. Two greens a
step apart would have been the amber problem again in a different hue. Each chip
carries a glyph so the state survives being read at speed or in greyscale, and
the green is `emerald-700` (4.6:1 on white) rather than `-600`/`-500`, which fall
under 4.5:1 at this size.

`StatusChip`'s `warn` prop replaces the **draft** chip with an amber "Action
needed" — the deadline is close and the period is still editable. It is the only
amber on either calculator, which is what lets amber keep meaning "a person has
to do something". It never overrides `ready` or `locked`: once a period is signed
off there is nothing left to act on. (This is the old Departments `HeroBadge`
`warn` state, preserved through the merge.)

### A background reload never announces itself *(2026-09-02)*

`useLiveRefresh` falls back to a **30-second poll** plus a tab-focus refresh when
Realtime isn't available for these tables. Every tick re-ran `loadDept` for every
branch, so every branch flashed "loading…" twice a minute over figures that were
already on screen, and the page read as permanently busy. Kane: *"Add caching so
I dont have to see that loading — I think its polling time to time."*

The **fetch is untouched.** The tab cache is PAINT-only by ruling and carries no
skip-fetch flag (pinned by a test in `kpi-cache.ts`), so the way to stop showing
a spinner is to stop showing it, never to stop asking the database. What changed:

- `settledDepts` records every branch whose load has finished once on this mount,
  success or failure. `pendingFirstLoad = loadingDepts − settledDepts` is what
  the grid and the block header render, so only a branch with **nothing on
  screen** says anything. (`loaded` on the Departments side was already
  first-load-only and needed no equivalent.)
- The `animate-spin` `RefreshCw` next to the top bar's "as of HH:MM" cache chip
  is gone on **both** calculators — the timestamp was always the whole message.
- **The Refresh button still spins.** That one is answering a click.

`loadingDepts` itself is unchanged and still feeds the Payroll Readiness report's
`loaded` flag, which is a correctness signal rather than an indicator.

### The calculator switch lives in the toolbar *(2026-09-02)*

The HSL-Branches / Departments tablist was its own bar in `ManagerApp`, stacked
above whichever calculator was showing. It cost a full row of page height to hold
two buttons directly above a toolbar, and read as shell chrome rather than as
part of the screen. It now renders **inside** each calculator's own toolbar, in
the row that already holds that screen's search box — on HSL beside the people
search, on Departments where the "Department calculators" label was (that label
named exactly the thing the switch now changes).

`ManagerApp` still owns `kpiCalc` and renders the control **once**, passing it
down to both as a `calculatorSwitch` **node** — not a mode plus a callback. Two
independently rendered switches would drift; one node cannot. It is `null` when
the manager owns only one calculator, and both calculators tolerate that (the HSL
toolbar row now renders when *either* the switch or the multi-branch controls are
present).

It is also passed to **`KpiCalculatorLoading`**, drawn real rather than as a
shimmer. It has nothing to load, and now that it lives inside the calculator a
manager who landed on the slower of the two could otherwise not leave it for the
whole first load.

**Departments is the default, and comes first** (Kane, 2026-09-02). The switch
used to scan `managed` in assignment order and open whichever calculator owned
the first-assigned dept, so two managers with the same two calculators could land
on different screens for a reason neither of them could see. `firstAssigned` and
its "primary" marker are deleted; `active` is `kpiCalc ?? 'dept'` when a manager
owns both. A fixed default is one less thing to explain now that the switch is in
the toolbar. Departments is also the FIRST tab — a switch whose first tab is not
the one you land on reads as a bug.

**The indicator slides across the remount; the swap itself is a hard cut.**
The switch lives inside the calculator it navigates away from, so every click
unmounts it with the outgoing calculator and mounts a fresh one with the incoming
— and the incoming side may mount **twice**: its loading skeleton for a frame,
then the real calculator. Three versions shipped on 2026-09-02:

1. A CSS `transition-transform` on an inline `translateX`. Could never play across
   a remount — the new node is born at its final position — so the pill jumped.
2. A motion `layoutId` inside the active button. Animated HSL → Departments but
   **not** Departments → HSL (Kane: *"vice versa there is no animation"*).
   Switching to HSL paints the HSL skeleton for a frame before the real
   calculator, so the pill mounts twice and `layoutId` hands the second mount a
   snapshot that is already at the destination; the travel is lost. Departments
   has no such intermediate mount, hence the asymmetry.
3. **This one** — `KpiCalculatorSwitch` (`kpi-calculator-switch.tsx`): the CSS
   transition again, but the pill is *born* where the previous instance's pill
   came to rest (`restingAt`, **module-scoped** so it outlives any instance) and
   moves to the active tab on the next frame. A skeleton that mounts and unmounts
   mid-flight never records a resting position, so the real calculator's pill
   simply starts the same slide from the same place. `transitionend` records the
   rest; a `TRAVEL_MS + 50` timeout is the fallback for when it never fires
   (reduced motion, a hidden tab). Deterministic, no measurement, no library
   snapshot to lose. Reduced motion is `motion-reduce:transition-none`.

The buttons are `flex-1 basis-0` with **no gap**, which is what makes each exactly
half the padded box so the pill travels a clean 100%.

The crossfade is **gone**. It was covering for the jump the pill no longer makes,
and both calculators now paint the identical header, so the only thing that
visibly moves on a swap is the pill gliding to the other tab. No wrapper, no
transform — a transformed ancestor re-anchors `position: fixed`, which is what
forced the branch overlay into a portal in the first place.

### The branch filter is a dropdown *(2026-09-02)*

The rail of one pill per branch (plus "All") is replaced by a single
`SmoothSelect`. With a dozen branches the rail wrapped to three rows and pushed
the branches themselves below the fold. The pills' count badges survive as part
of each option label (`Callback Team · 12`); the menu is `portal`led so the
sticky, blurred top bar cannot clip it, and turns `searchable` above 8 branches.
Picking a branch still clears the cross-branch people search — the two filters
would otherwise fight over what is on screen.


**A manager with ONE branch still gets the block directly** — a one-row list you
must click through is pure ceremony, and it preserves what the Payroll Readiness
modal already relied on (it scopes `managedDepts` to a single key, so
`multiDept` is false and the branch renders in place, as before).

### Three overlay presentations

`HslOpenMode` = `window` | `half` | `full`, chosen from a `ViewSwitch` in the top
bar and switchable again from inside the overlay. Deliberately the same set
`DeptBonusCalculator` offers, so a manager scoring in both learns one control.
Full screen adds a branch rail so you can move between branches without closing.

Portalled to `<body>`: the Payroll Readiness modal mounts this component inside a
transformed ancestor, which would otherwise re-anchor a `fixed` panel. Escape
closes, body scroll locks while open, focus moves to the panel and returns to the
opener.

**The panel keeps ONE key across mode switches.** Centring lives on an outer
layer as flexbox and the entrance is driven by variant *name* (`PANEL_VARIANTS`),
not inline objects. The first cut centred the window with
`translate(-50%,-50%)`, which had to be baked into every keyframe and therefore
forced a per-mode key — switching Windowed → Full screen remounted the whole
branch and silently discarded the open team, the page and the roster selection.

### SSD Medical Records workspace

`SsdSubTeamGrid` + `SsdEmployeeTable` + `SubTeamChips` are replaced by
`SsdWorkspace`: a status strip that doubles as the team tab bar, ONE team card,
then a full-width roster. Used by both the manager calculator and
`HslBonusEditModal`, so an Accounting correction reads like the original entry.

- **Status strip** — `N / 6 teams scored` plus six tabs, each carrying a glyph
  (`✓` entered, `!` incomplete, `·` scored earlier, `–` not started) as well as a
  colour, so status never rests on hue. Real `tablist` with roving arrow-key
  focus. The unassigned count is a button that filters the roster to them.
- **Team card** — three fields (accuracy / records / RFC), live arithmetic for
  **both** rules shown separately (a team under 90% accuracy still earns its RFC
  pool, and one summed figure would hide that), a three-segment tier meter, and
  the per-member payout. Keyed by team so it replays its entrance on switch.
- **Roster** — full width, filter chips, bulk-assign bar, and a single native
  `<select>` per row instead of seven chips. At 60+ people the chips were the
  loudest thing on the screen.
- **Rules panel** — the real thresholds, read off `HSL_DEPTS` rather than
  restated, so a schema edit can never leave the UI describing a rate that no
  longer pays. It is an `@container`: its two-column split keys on **its own**
  inline size, because it is ~330px wide beside the card in a half-window overlay
  and full width when stacked. Keying it to `sm:` collided the two columns' text
  at exactly the width the side panel produces.

Two things in the handoff are deliberately NOT followed, and both are called out
in code comments at the site:

1. **Tier thresholds are the real ones** (`<90%` → nothing, `90–94.99%` →
   ₱250/record, `95%+` → ₱350/record, plus the separate ₱250 RFC pool). The
   handoff's `90/95/98 → 50/75/100% of pool` ladder is flagged as invented in its
   own README.
2. **No "✓ Saved" footer.** It would be a lie sitting under three fields that are
   deliberately never persisted (see *SSD sub-team inputs are still NOT saved*).

The handoff also marks unassigned rows with a 3px inset side stripe; this uses a
dot instead (side stripes are banned by the `impeccable` skill).

### `restored` — the fourth team state

The handoff has three states (complete / partial / empty). This surface needs a
fourth, and it is forced by the persistence rule above: after a reload the three
inputs are blank while the per-member shares they produced are not.

A team whose inputs are blank but whose members carry a non-zero
`calculated_bonus` is `restored`, not `empty`. Calling it "Not started" would
send the operator off to re-key numbers that are already banked — and
`recomputeSsdEntries` refuses to overwrite those shares precisely because they
are real.

**A restored team reports the SAVED share, never a recompute.** `shareForRow`
returns the row's `calculated_bonus` and the card takes `savedShareByTeam`.
Without that the roster printed ₱0.00 against every member of a team the header
was simultaneously totalling at ₱29,640 — caught in review, not in theory. A
typed `0` still counts as entered, matching `subTeamInputsBlank`.

### Sub-team colour tokens

Six teams named after colours means colour is data, not decoration: one hue has
to drive a tab dot, a card rail, a roster chip and a payout figure in both
themes. Tailwind classes can't be handed to `color-mix()` or an inline `style`,
so each team has four custom properties in `src/index.css`
(`--ssd-<t>`, `-solid`, `-on`, `-text`) and every SSD surface reads them through
one `--team*` alias set by `teamVars()`. `-solid`/`-on` are a separate pair from
the identity hue because the identity hue does not carry label text at 4.5:1.

### First-load skeleton

`KpiCalculatorLoading`'s `hsl` variant mirrors the same split: several branches
paint as a list of rows, a single branch paints as the scoring block. It also
takes `teamSplit`, set when the one visible branch scores by sub-team, and then
paints the SSD workspace shape (status strip, team card beside the rules panel,
full-width roster) instead of a plain roster.

That flag is not cosmetic. The SSD workspace is roughly twice the height of a
plain roster, so the generic placeholder would drop the page several hundred
pixels the moment data landed — and the single-branch path is exactly what the
Payroll Readiness modal loads. The view switch is drawn as real chrome rather
than a shimmer block, because it has nothing to load and is usable the instant
the calculator mounts.

**Not verified in the real app:** the overlay and the redesigned surface were
checked against Playwright-stubbed API routes at 390 / 820 / 920 / 1180 / 1440px
in both themes, not against production data or a real manager session.

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

## Tab-switch & reload cache *(2026-09-01)*

Kane: *"add proper caching practices where I don't have to hit the database again
to pick up the data."*

`ManagerApp` renders its content pane inside an `AnimatePresence mode="wait"`
keyed on `activeTab` (`ManagerApp.tsx:404`), so **leaving the KPI Calculator tab
unmounts both calculators**. That unmount is load-bearing and stays — it is what
flushes a pending autosave (see *Autosave*, point 3). What it cost was every
fetch re-running from cold on the way back:

| calculator | per visit |
|---|---|
| HSL | 1 week-resolve + **3 per branch** (entries · period-status · team-members) |
| Departments | 1 week-resolve + catalog + FX + **2–3 per dept** |

all `cache: 'no-store'`. Six branches is nineteen round trips to look at a number
you were looking at ten seconds ago. Listed as still-open in
`memory/dashboard-switch-performance` ("/manager re-fetches on every tab switch").

The store is `src/lib/manager/kpi-cache.ts` (+ `kpi-cache.test.ts`), bound to the
viewer by `src/hooks/useKpiCacheIdentity.ts`. It mirrors
`src/lib/employee/tab-cache.ts`: in-memory Map plus a `sessionStorage` mirror,
**never `localStorage`**, identity-stamped, schema-versioned, 12h age ceiling,
and a capacity trim (the department week picker mints a key per dept-week).

### A cached value paints. It never decides.

Every consumer seeds its state, then runs its **existing, unconditional** fetch
and overwrites it. There is deliberately **no skip-fetch flag** — Accounting's
`tab-cache.ts` exports `hasFetchedThisSession` and copying it here would be a bug:
other scorers edit the same dept-week and `useLiveRefresh` re-pulls it, so a
skipped fetch freezes one manager's view of a week somebody else has changed. A
`no-skip-flag` test greps the module's own exports so it cannot return by
copy-paste.

Three consequences, none of which may be undone:

1. **`weekResolved` is never seeded from the cache.** `KPI_CACHE_KEYS.presumedWeek`
   only decides *which* cached week may be painted while the live Hubstaff
   resolve is in flight. Every read and write stays held on the live answer, and
   `kpiAutosaveGate` still refuses on `week-unresolved` — see *First-load reveal*.
   Seeding the *view* week from it is strictly better than what it replaces: a
   real Sunday-anchored upload week instead of the Monday-anchored clock guess.
2. **Nothing seeded is `dirty`.** A cached payload came out of the database. On
   the department side the seed runs the same `applyDeptPayload` as the fetch, so
   a never-saved draft still arrives pre-applied and flagged `seeded` — which
   autosave still refuses (`seeded-only`).
3. **Only RAW payloads are cached** — `HslBranchPayload` and `DeptAppliedPayload`,
   both re-derived through the one merge each surface has (`mergeHslBranchPayload`
   / `applyDeptPayload`). Never `DeptState`: it holds a `Set` (`rosterEmails`),
   which `JSON.stringify` turns into `{}` — an empty roster reads as "everyone is
   an external member" and paints a removable ✕ against every real member. And
   `subTeams` is **never** cached: blank-after-remount is exactly what makes
   `subTeamInputsBlank` hold a banked SSD share instead of zeroing it, and what
   produces the `restored` team state.

### Scoring is held until every write input is confirmed live

`weekPending` (departments) / the `weekPending` prop (HSL branches) makes the
surface read-only until, on **this mount**, the payroll week has resolved (or
failed), the catalog is in, and the FX lookup has settled.

This loosens nothing — before the cache, that window was a loading skeleton,
which was not editable either. It closes two things:

- an edit typed against a cache-painted week that the live resolve is about to
  replace would survive that replacement (`loadDept` will not overwrite a dirty
  department) and then save under the **new** week's key;
- a USD/COP bonus scored before `/api/app-settings` answers banks the **fallback**
  rate, because the peso figure is snapshotted at save time and nothing
  downstream re-converts (`bonus-catalog.md` → *FX at save time*). `fxSettled`
  means the lookup finished, not that it succeeded — a failed lookup has a
  documented answer (the official rates) and must not block scoring forever.

### What a load may overwrite

`isUnsavedLocalWork` (`kpi-autosave.ts`, tested) replaces the departments' old
`cur?.dirty || cur?.saving` write-time guard. A `seeded` state is dirty but
**untouched** — every mutator clears `seeded` in the same update that sets
`dirty` — so treating it as local work would leave a pre-applied department
frozen on whatever painted first, accepting neither another scorer's change nor
its own live re-fetch. Overwritable and writable are separate questions: a load
may replace a seeded department, and autosave must still never persist it.

A department's load **failure** no longer blanks rows that are already on screen,
matching the Payroll Notes panes' background-guard rule
(`memory/payroll-notes-panes-cache-live-freshness`).

### Disclosure

While cached rows are on screen ahead of the live answer, both toolbars carry a
neutral **"as of HH:MM"** chip stamped with the cache write time (not the paint
time), cleared once the live loads settle — and kept if one of them failed, so
the label stays honest. Neutral, not amber: amber is reserved for warnings.

### The catalog: cached for paint, live for the write

The first cut left `/api/bonus-catalog` uncached, reasoning that a bonus
definition is a *write* input. That was right about the write and wrong about the
paint, and it showed: the catalog gates the pre-apply pass and the reveal, so
switching in from HSL Branches still sat on the skeleton for a full round trip
even when every department's rows were already cached (Kane, same day: *"when I
switch to Department from HSL Branches it reloads it again"*).

The split that fixes it without giving anything up:

| | seeded from cache | waits for the live fetch |
|---|---|---|
| `bonuses` / `assignments` (what is drawn) | yes | overwritten when it lands |
| `catalogAvailable` (may we paint?) | yes | — |
| `catalogLoaded` (may we score?) | **never** | yes — and `weekPending` holds on it |
| the per-dept live loads | — | yes, so what persists is derived from the LIVE catalog |

So a cached definition can be *drawn*, and only a live one can be *derived from*
into anything that gets saved. The seeded paint is `seeded` (untouched), which is
exactly why `isUnsavedLocalWork` lets the live load replace it.

### Not cached, on purpose

- **The FX rates.** `usd_to_php_rate` is snapshotted into the stored peso amount
  at save time, and unlike the catalog it has a documented fallback that a cached
  copy would silently displace. One small request, and `fxSettled` already holds
  scoring until it answers.
- **SSD sub-team inputs** (above).
- **Nothing server-side changed.** Every route keeps `cache: 'no-store'`.

### Not verified in a browser

`tsc` is clean and 2176 tests pass. The live tab-switch and reload behaviour was
not clicked through (needs Google SSO + Supabase auth).

## Known gap (low, not fixed)

- **Removed depts still show on Employee Dashboard.** `getEmployeeKpiResults` has no
  dept-key filter, so historical ready/locked rows for the removed depts keep
  surfacing (labeled with the raw key). The migration's "inert" note is inaccurate
  for this one employee-facing path. Cosmetic; the data was already visible pre-change.

## The Departments calculator adopts the branch row *(2026-09-02)*

Kane: *"in the Departments — make it similar to the design of the HSL Branches
please so its much simpler."* `DeptSummaryCard` became **`DeptSummaryRow`** in
`DeptBonusCalculator.tsx`, the same shape as an HSL branch: colour bar, name over
a meta line, then status / headcount / projected / chevron pushed right, two per
line from `lg` (the grid there was already `grid-cols-1 lg:grid-cols-2`).

What went is ornament, not information:

| Was | Now |
| --- | --- |
| 64px monogram tile (`uniqueDeptAbbrevs`, `deptAbbrevByKey`) | the same 1px colour bar the branches use — the tile was ~¼ of the card's width to say what the colour already said |
| `CompletionGauge` on the card | `entered/headcount ppl`, the numbers the gauge was drawing, in the slot a branch puts its headcount in; `toFill` moved to the `title` |
| up to two per-person match pills | one `match` / `N matches` chip, names in its `title`, plus the branches' blue hit border |
| `HeroBadge` | the shared `StatusChip` (above) |
| hover lift (`whileHover y:-3`), boxed chevron | the branches' border-and-shadow hover |

`uniqueDeptAbbrevs` and `deptAbbrevByKey` were deleted with the tile — nothing
else used them. `initials()` stays (roster avatars) and `CompletionGauge` stays
(it is still drawn inside an open department's panel, where there is room for
it). The entrance/exit variants and `layout` stay too: the parent grid filters
with `AnimatePresence mode="popLayout"`, and without them a narrowing search
teleports the survivors.

`KpiCalculatorLoading`'s `departments` variant mirrors it with `DeptRowSkeleton`
— the same rule as the HSL side: a placeholder of the wrong shape reserves the
wrong height and the page jumps when the data lands.

### One header for both calculators *(2026-09-02)*

Kane: *"make sure they use the same headers."* They were reading as two
different products. The Departments bar had an **18px bold** title under a
`0.22em` eyebrow, `px-4 sm:px-6` padding, and **two large stat tiles**
("Projected · week" on an emerald gradient, "Headcount" beside it, both
`text-xl`), with Refresh / "Open as" / the cache stamp down in the toolbar row.
HSL had a **16px semibold** title under a `0.2em` eyebrow, `px-5`, and one quiet
bordered pill carrying the figure and the headcount together, with the controls
beside it.

**The HSL bar won, verbatim** — container, eyebrow, title, and the single figure
pill, then `ViewSwitch` → cache stamp → Refresh in that order. The twin tiles
were the hero-metric template, and a projection nobody has locked yet is not the
loudest thing on a scoring screen. Both second rows are now the same two things
in the same order: the calculator switch, then that screen's search.

**Second pass, same day** — Kane: *"Do you understand that the headers should
be the same?"* The class names matched; the header did not, because three things
inside it had no HSL counterpart:

- **The `WeekPicker`** was a bordered button with a calendar glyph, a `12.5px`
  semibold date, a Live/Past badge and two arrow buttons, sitting where HSL prints
  `week of 2026-08-23` in `font-mono text-xs text-zinc-500`. It now renders as
  **that exact span** — same classes, inside the `<h2>` — that happens to open the
  week menu on click. A small `past` marker is the one addition. The prev/next
  arrows became **←/→ on the trigger**; the menu still lists every week.
- **`DeadlineBanner` / `PastWeekBanner`** (and the monthly-bonus note) rendered
  INSIDE the sticky bar, making it a full band taller than HSL's on every scroll.
  They moved **below** the bar, above the rows — the same slot HSL uses for a
  banner. Same messages, same place a banner goes.
- **The second row** had a `flex-1` wrapper, a `flex-1` search box and an emerald
  focus ring. It is now byte-identical to HSL's: `{calculatorSwitch}` then a
  `w-full max-w-[260px]` search with the blue ring. The `weekError` alert moved
  from inside the title column to a sibling row, where HSL's sits.

One deliberate difference remains: the pill reads **"Projected"** on Departments
and **"Total"** on HSL. A shared shape is worth copying; a wrong label is not.

`KpiCalculatorLoading`'s `departments` variant mirrors the new bar — same rule
as everywhere else here: a placeholder of the wrong shape reserves the wrong
height and the page jumps when the data lands.

The **rows** were already identical: every shared class in `DeptSummaryRow` and
the HSL branch row matches byte for byte. What Departments adds — the amber
`dirty` dot, the loading skeletons, the `isOpen` ring in the department colour —
are signals HSL has no equivalent for.

### The payroll-processing banner, and an UNRESOLVED disagreement *(2026-09-02)*

Kane: *"in the departments I cannot see the payroll is being processed lock UI."*
It was not there, and it is not only a missing banner.

`ManagerApp` swaps the whole `hsl-bonus` tab for `PayrollProcessingLock` once
Accounting hits **Start processing** — but **admins bypass it**, matching
`processing-guard.ts` server-side. So the only person who ever sees the inside of
either calculator during a dispatch is an admin. From there the two disagree:

| | HSL | Departments |
| --- | --- | --- |
| Reads the dispatch lock | yes (`useDispatchLock`) | **no** — `payrollLocked: false` is hard-coded into `kpiAutosaveGate` |
| Mark ready / unready during processing | **blocked** | allowed |
| Banner | red, *"You cannot mark ready or unready until processing is complete"* | none, until now |

Both sides are argued in the code. HSL blocks. The Departments call site says
reading the lock there *"would silently stop an admin's corrections from ever
persisting, which is worse than the 423 they'd never see."*

**What shipped is the banner only.** Departments now subscribes to the lock **for
display**, and prints the same red bar in the same slot, worded to what is
actually true there — *"Accounting is dispatching from these figures … changes
you make here still save."* An admin was previously editing numbers a dispatch
was reading with nothing on screen to say so. `kpiAutosaveGate` still receives
`payrollLocked: false`; **no guard was touched.**

**UNRESOLVED — Kane's call.** Either an admin may correct KPI figures mid-run or
they may not, and today the answer depends on which calculator they happen to be
in. Fixing it means changing behaviour on a money path in one direction or the
other, so it was not settled by copying one into the other.

### Readiness lives in the header; the lock banner is the employee shell's *(2026-09-02)*

Kane: *"for the all departments submitted for this week put them at the header
please, and the Payroll Is being processed should be the same from the Employee
dashboard where there is a line running around."*

**`KpiReadinessChip`** (`kpi-readiness-chip.tsx`) — the Departments
`DeadlineBanner` folded into a chip and placed **first in the figure cluster on
BOTH calculators**, so the headers stay the same header. Same `rounded-lg`
bordered shape as the figure pill beside it; `N/M ready` (or `submitted`), tinted
by the banner's own tiers (done → emerald, ≥4 days → neutral, ≤3 → amber, ≤1 or
overdue → red), with the countdown as one more span **only where a deadline
exists** — Departments' managers submit before the week's payroll; HSL's week is
pinned to the Hubstaff batch and has none. HSL gained `readyBranches`
(`ready` or `locked` branches ÷ visible) for it. `DeadlineBanner` is deleted; the
`PastWeekBanner` and the monthly-bonus note stay below the bar and the wrapper
that holds them now renders only when one of them does.

**`PayrollLockBanner`** (`components/employee/PayrollLockBanner.tsx`) — the
employee shell's banner, with its pulsing lock ring and the `payroll-lock-sweep`
line along the bottom edge — now replaces both calculators' plain red bar. It
gained two props: `detail` (the one-line consequence for THIS surface; the
employee default is unchanged) and `dismissible` (the calculators pass `false`,
because on them the lock changes what the viewer can do). The two calculators
pass different `detail`s for the reason recorded above: HSL blocks mark
ready/unready, Departments deliberately does not, and a shared banner must not
say something untrue on one of them.

### The dispatch lock comes from the shell *(2026-09-02)*

Kane: *"When I switch tabs it disappears like it doesn't know that payroll is
processing."* It didn't. Both calculators called `useDispatchLock()` themselves,
and a fresh hook instance starts **unlocked** and only flips after its first
fetch — so every tab switch remounted the calculator, the banner vanished, and it
reappeared a round-trip later. The hook's own doc says to mount it once at the
shell and pass the result down.

Both calculators now take an optional **`dispatchLock?: PayrollDispatchLockState`**
and prefer it over their own instance (`dispatchLockFromShell ?? fallback` — the
fallback hook still exists because hooks cannot be conditional). `ManagerApp`
passes the `payrollProcessing` state it already holds for the tab-level
`PayrollProcessingLock`; `QCApp` passes its own. The Payroll Wizard's Readiness
modal has no shell instance and takes the fallback, which is the pre-existing
behaviour there. With the shell's already-resolved state handed in, the banner is
on screen in the first frame of the mount, and `PayrollLockBanner`'s
`AnimatePresence initial={false}` means it does not animate in either.

### The sidebar tab wears the lock *(2026-09-02)*

Kane: *"for the tab on the side bar 'KPI Calculator', if the Payroll is
Processing let's add an outer border color running around on it."*

`ManagerSidebar`'s `navBtn` gained a `ring` flag; the KPI Calculator item passes
`lockState.locked` (the sidebar already held its own `useDispatchLock()` — it is a
shell component that never remounts, so no flash). The rim is
**`.payroll-lock-ring`** in `index.css`: the same masked-conic engine as
`.urgent-ring` (reusing its registered `--urgent-angle` and `urgent-ring-spin`
keyframes), in the payroll-lock banner's **rose → amber** palette, 3s per lap, so
"payroll is running" is one colour story from the employee shell's banner to the
manager nav. It is an absolutely positioned `-inset-px` overlay with
`pointer-events-none`, so the button's own layout, active gradient and hover are
untouched; the outer radius is `7px` — the button's `rounded-md` plus the 1px
outset. Under reduced motion the rim stays and stops travelling — the rim is the
signal, the motion is not.

### Alphabetical, at the source *(2026-09-02)*

Kane: *"for the Departments and HSL Branches alphabetical order them please."*
Both calculators now sort by the **display name the row prints**, with
`localeCompare('en', { sensitivity: 'base' })`, and they sort the **source list**
rather than the rendered one — `visibleDepts` in HSL, `visibleDeptKeys` in
Departments — so the grid, the overlay / focus-mode branch rail, the filter
dropdown and the first-load order all agree. Before, HSL was `HSL_DEPT_KEYS`
declaration order from `schema.ts` and Departments was catalog / assignment
order — both history, neither something a manager could predict. Departments'
sort uses the same name resolver as `DeptSummaryRow`
(`DEPARTMENTS[..].name ?? deptLabelByKey ?? humanizeDeptKey`), so what sorts is
what is read; `deptLabelByKey` joined that memo's deps for it.
