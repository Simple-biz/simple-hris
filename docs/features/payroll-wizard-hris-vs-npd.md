# Payroll Wizard — HRIS vs NPD (Validation step tab)

A **HRIS vs NPD** tab on the Payroll Wizard's Validation step (7). Accounting pastes the NPD
sheet's work emails and dollar figures, and every person appears once with HRIS's dollar figure
beside NPD's: a **green** row with a check when they agree to the cent, a **red** row with an ✗
and the difference when they don't, and a red **Not in HRIS** / **Not in NPD** when one side has
nobody at that address. Nobody on either side is ever dropped. Display only: it writes nothing.

Kane, 2026-09-30: *"compare their Dollar Values - against their work emails … If they are a match
then that row will be green along with the Match column that has a check mark and X mark if other
wise and red row color … make sure not to delete any rows and just label the match column as - Not
in HRIS or NPD on whoever is missing"*. Shipped 2026-09-30, blueprint brief in-session (no NEEDS);
commit: `git log -- docs/features/payroll-wizard-hris-vs-npd.md`. Plan:
`docs/superpowers/plans/2026-09-30-payroll-wizard-hris-vs-npd.md`.

## Key files

| Piece | File |
| --- | --- |
| Pure module: parse the paste, HRIS's staged dollars, compare, filter, labels | `src/lib/payroll/hris-npd-compare.ts` |
| Rules tests (parse, buckets, union, bridge, holds, source guard) | `src/lib/payroll/hris-npd-compare.test.ts` |
| Rendered-spec tests (green / red / labels / holds / phone layout) | `src/lib/payroll/hris-npd-render.test.ts` |
| The panel (paste card, rate line, hold banner, chips, table) | `src/components/payroll/HrisNpdComparison.tsx` |
| The full-screen overlay (both sections) + the one `VALIDATION_SECTIONS` definition | `src/components/payroll/ValidationFullScreen.tsx` |
| Wiring: the strip, `npdPaste` + search/chip state, the memos after `validationRedFlagCount`, `hrisNpdPanelProps`, the one overlay mount | `src/components/PayrollWizard.tsx` |

## Where it lives

Step 7 now carries a **Final Pay | HRIS vs NPD** strip, a copy of step 5's `Departments | HSL`
strip (underline variant, `layoutId="validation-section-indicator"`). It sits **below** the
header, the summary cards and the US-holiday card, and **above** the workspace. The swap replaces
only the workspace: the department rail plus Final Pay table (with MV and Exclude), or the
comparison. The Validation Checks card stays under both. **Final Pay is the default**, and the
tutorial anchor `step7-validation-table` is on the header, so it is visible in both sections.

### Full screen (2026-09-30)

Kane, same day: *"please add this in the full screen view please"*. The Validation full-screen
overlay (`ValidationFullScreen`) carries the same `Final Pay | HRIS vs NPD` strip, and the
comparison has its own **Full screen** button in the same place as the Final Pay table's (the
table's header bar, so it shows once there is a table). The rules are in
[payroll-wizard-manual-validation.md § It carries both sections](./payroll-wizard-manual-validation.md#it-carries-both-sections-2026-09-30).
The short version:

- The overlay renders **this same panel from the same `hrisNpdPanelProps` object** as the step
  (`<HrisNpdComparison {...hrisNpd} fillHeight />`). Same paste, same verdicts, same holds, same
  search and chip. It is never a second implementation.
- It shows **the step's own section state**: opening full screen from HRIS vs NPD lands on HRIS vs
  NPD, switching inside it switches the step too, and Escape or ✕ returns to the section you were on.
- The wizard mounts **one** overlay, **outside** the section swap (source-guarded). Mounted inside a
  section's branch, switching sections from within the overlay would unmount it.
- `fillHeight` lets the table take the overlay's full height (no 62vh cap), and the panel then
  skips its own week label because the overlay's header already names the week.

The HRIS vs NPD tab's badge counts rows that need a look (mismatch + Not in HRIS + Not in NPD), in
rose. It shows **only once verdicts can be given**, never while they are held.

## The paste

TAB-separated, straight from the sheet. Google Sheets cannot copy two columns that are not next to
each other, so the clerk selects **one block from the Work Email column across to the dollar
column**. `parseNpdPaste` reads it like this:

| Rule | Why |
|---|---|
| The key is the **first cell on the line that looks like an email** | Lets the block start left of the email (a Name column) |
| The dollars are in the paste's **rightmost column that holds a value on any line with an email**, and that column is **fixed for every line** | A person whose dollar cell is blank has that line **refused**. Reading "their last non-empty cell" would take their pesos or hours instead. It also makes a selection wider than the data harmless, and a total row (no email) cannot move the column |
| The first content line is skipped as a header when it has no email. Any later line without an email is refused ("No work email on this line") | A stray total or note row is visible, not swallowed |
| `$`, `US$`, `USD` either side, a trailing `$` (`250$`), thousands commas, spaces, `-`/`+`, `( )` are tolerated. **`₱` / `PHP` / pesos / `COP` are refused**, and so is anything that is not a plain decimal (`#N/A`, `12,50`) | A PHP column pasted as the dollar column is the likeliest wrong paste, at ~60× too large |
| Cents come from the **decimal string**, never `float × 100`, and round half-up past the cent | `Math.round(1.005 * 100)` is 100 in doubles. The string says 101 |
| With **no tab anywhere** (typed by hand), each line is `email amount`, split at the first space, comma or semicolon. In a tab paste, a line with no tab is refused | Typed input is unambiguous because emails have no spaces. A mixed paste is not |
| Every refused line is listed with its line number (blanks counted, like QC Compare) and the reason | "A row is never silently dropped and never silently coerced" (`src/lib/qc/paste.ts`) |

**A person on two lines is added together**, and so is one person under two addresses (work +
personal). The NPD cell then says "2 lines added". This follows Kane's 2026-09-29 orphanage ruling
(*"if there are two line items just add them both"*, `orphanage-pay-step.md`), and HRIS pays one
figure per person. The parser does not decide this. The comparison does, because only it can see
aliases.

## HRIS's figure is the one Payment Dispatch is sent

For each Validation row: **the staged final** (`dispatchNet`, i.e. `pay_php.final`) ÷ **this
cycle's USD→PHP rate**, rounded **exactly** as Send to Payment Dispatch stages `amount_usd`
(`Math.round((php / fx) * 100) / 100`, `stagedUsdCents`). The rules test reads
`PayrollWizard.tsx` and **fails if that staging line changes** without the module. Change both
together or not at all.

- **USD is the comparator** because it is the only figure comparable across PHP- and COP-settled
  people (`cop-country-payees.md`, [[settlement-currency-per-person]]). NPD's figures are USD
  (the 2026-08-18 reconciliation below).
- **No staged payload** (no personal email, so the pay run skips them) → the row's **Gross**,
  tagged **"No payout · no personal email"**. The Final Pay table flags the same row red
  `not_dispatchable`.
- **Where Gross and the staged final differ** (the Final Pay table's red `gross_mismatch`), this
  column follows **dispatch**, not the Gross column. That is on purpose.
- **Excluded ("do not pay") people stay in**, with their figure struck through and an **Excluded
  from pay** tag. They are judged like anyone else, so **a green row can be excluded**: the two
  sheets agree on the figure, and HRIS still won't send it this week. The HRIS total includes them,
  and the footer says by how much.
- **Two Validation rows on one email** are both staged, so both are paid. Their staged cents are
  **summed** ("2 HRIS rows added"), never deduplicated.
- **Who is "in HRIS"**: every Validation row, meaning every department including HSL (the same
  rows as Final Pay). Not included: departments paused by *"Pay this week"* (they are not on the
  step), contractor invoices (step 6) and orphanage interns. When NPD lists someone from a paused
  department, the row reads **Not in HRIS** plus *"In HRIS, but their department is paused this
  week"*, using the same predicate `effectiveCalcResults` filters with.

The rate line prints the divisor (`final pay ÷ ₱61.52 per $1`). **An HRIS-vs-NPD gap is an FX
divisor question before it is a math question** (Payroll Wizard INDEX row; 2026-08-18: all three
reported gaps were 61.52 vs ≈60.93, and the pesos agreed to the centavo). Hovering a mismatch's ✗
gives **the rate NPD's figure implies** against HRIS's pesos. This is a hint only. It is not the FX
cross-check, which is still **OPEN** (`payroll-wizard-final-pay.md` § 2026-08-18).

## Matching people

The row's own address first, case- and whitespace-insensitive. If that misses, the **master-list
bridge the orphanage paste uses** (`orphanageResolveCtx.masterAliasesFor`: work, personal, both
alternates). A bridged row keeps HRIS's address and shows `NPD: <the address NPD used>`.

**A bridge that reaches two HRIS rows is refused as ambiguous.** The NPD line stays **Not in HRIS**
with a note naming both rows, and both HRIS rows stay **Not in NPD**. Personal addresses are
shared and recycled in the master list. A guessed pairing would show one person's figure against
another's, which is the same hazard MV's `row.id` rule guards (`payroll-wizard-manual-validation.md`).

## Match means equal to the cent

`npdCents === hrisCents`. **No tolerance**: the 2026-08-18 gaps were $0.81–$2.68, and one residue
was $0.07 (a sub-minute Hubstaff re-sync). A tolerance is a policy that hides the smallest real
differences. A mismatch shows `NPD +$2.68` / `NPD −$0.07` (NPD minus HRIS) under the ✗.

## No row is ever dropped

The rows are the **union** of both sides: every HRIS email and every NPD address that parsed. At
1,200 HRIS rows against 1,100 NPD lines, the test asserts one row per distinct person, unique keys,
and exact bucket counts. Rows sort by address. Unreadable paste lines are **refusals**, listed in
the paste card, not rows.

## No verdict before the figures can be judged

`compareHrisNpd` sets `hold` and gives **no row a status** while any of these is true, checked in
this order:

| Hold | When | What shows |
|---|---|---|
| `no_npd_rows` | nothing parsed | **no table at all**: "Paste NPD's figures to compare". An empty box is not evidence that NPD has nobody, so "everyone is Not in NPD" would be a false claim |
| `loading` | `hrisNpdUsdState` is `pending`: the Step-8 preview's own `totalUsd` judgement (`resolvePayStubFieldStates`, every Net input + FX, same PAB `settledByPolicy`) **or** step 7's load line | neutral banner. HRIS cells **and the HRIS total** shimmer, Match shows "—", no colour |
| `unavailable` | a loader behind the figure **failed** | amber, static banner naming the failed sources (`HRIS_SOURCE_LABELS`, a `Record` over every source key, so a new key is a type error until named) |
| `no_fx` | the cycle rate is still 0 | amber banner pointing at Step 2. HRIS cells show "—". `stagedUsdCents` never divides by 0 or a placeholder |

A green or red row painted over a figure that hasn't landed is the defect this prevents. **Do not
make verdicts "optimistic" while loading.** The status chips are disabled while held, and the
table falls back to All.

## Nothing is saved

The paste lives in `PayrollWizard` state as `{ sourceFile, text }` and is read only while that
week is on screen. So a paste can never be compared against another week's pay, and no clearing
effect is needed. It survives step and Accounting-tab switches (the wizard stays mounted,
[[payroll-wizard-tab-persist]]). It is **gone on reload**. There is no route, no `app_settings`
key and no audit row.

Why not share it like QC Compare (`qc.compare_paste.*`, [[qc-compare-paste-shared]])? That is
fewer writes, and more reversible. And the `payroll.wizard.*` family is **readable by every
signed-in user** through `GET /api/app-settings` (OPEN, Sep 16 log item 161,
[[app-settings-final-pay-readable-by-every-employee]]), so storing the whole company's NPD figures
there would widen an open exposure. To share it later, copy QC Compare: its own gated route, a key
family the generic route **refuses** on GET and POST, `by`/`at` stamped server-side, and an audit on
Clear.

Replays can paste too. Nothing is written, so there is nothing to protect, and the HRIS side is
the Validation step's rows for the replayed week.

## The search and the chips never narrow the totals

`filterHrisNpdRows` is display only. The search text and the chip are **wizard state**
(`hrisNpdSearch`, `hrisNpdFilter`), not the panel's, because the step and the full-screen overlay
each mount a panel and must show the same slice, the way Final Pay's `validationSearch` is
shared. Like that search, they are not cleared on a week switch. The "showing X of N" line says
when they narrow. The footer shows **whole-comparison** totals (sticky, so they
stay visible down a long list), and says "(every row, not just those shown)" when filtered. This is
the same rule as Reports: a total that follows a filter gets read out as the week's figure
(`payroll-wizard-final-pay.md` § 2026-09-09). The search matches the address, the name **and every
NPD address that landed on the row**, so a person found under an alias stays reachable by it.

## Phone layout (three traps, each pinned by a render test)

1. `min-width` sits on a **wrapper div**, never on the table. Browsers ignore `min-width` on a
   `table-fixed` table, so at 390px the three fixed columns crushed Work Email to 0.
2. The table carries **`table-keep`**. Without it, the site-wide <640px rule (`src/index.css`,
   "Global responsive tables") restacks every row as a card and repaints it `--card`, which
   erases the green and red.
3. The scroller is **`relative`**. The `sr-only` Match/Mismatch labels are absolutely positioned,
   and unpositioned they escaped the horizontal scroller from the off-screen Match column and
   widened the page.

## Not built

- **Sharing the paste** across clerks and reloads (above).
- **Pulling the NPD sheet directly.** That needs its sheet ID and a Google grant from Kane. The
  paste is the only NPD input.
- **The FX cross-check.** The implied-rate hint does not validate the typed rate
  (`payroll-wizard-final-pay.md` § 2026-08-18 stays OPEN).
- The Continue button's confirm does **not** consult this tab. It still counts only the Final Pay
  red flags.

## Verification at ship

`node --import tsx --test` on both new files: **57/57**. `npx tsc --noEmit`: clean apart from two
pre-existing errors in the generated `.next/types/validator.ts` (the retired
`bank-preferred-requests` routes). `npm test`: **5,169/5,171**. The 2 failures are pre-existing
and name no file this touches (`dept-label-render.test.ts` names `EditBuiltinManagersDialog.tsx`,
`KpiCalculatorLoading.tsx` and `ManagerApp.tsx`; `manager-time-adjustments-live.test.ts` reads a
manager file). The panel was rendered to static markup with fixtures and
screenshotted (light, dark, loading, no FX, empty, 390px) against CSS compiled by the app's own
Tailwind plugin. **Not clicked through signed in.** **`next build` not run**: a dev server was live
on :3000 ([[nextjs-build-vs-dev-shared-dir]]).

*Full screen (2026-09-30, second commit):* both test files **66/66**. `npm test` **5,178/5,180**,
the same 2 pre-existing failures. tsc clean apart from the same stale `.next/types` errors. The
overlay is a portal behind a mount guard, so it cannot be server-rendered. It was exercised in a
real Chromium instead: an esbuild bundle of the overlay + an inline panel, wired exactly as the
wizard wires them. That run checked: opens on HRIS vs NPD; switching to Final Pay inside it keeps
it open; filter + search inside it; Escape closes it and the step's panel shows the same search
and chip; the step's Full screen button reopens it; the strip sits at the same height in both
sections; no horizontal overflow at 390px; no console errors. Still **not clicked through signed
in**.

## Deploy notes

**No migration.** No env var, no n8n import, no route, no `app_settings` key. Nothing is PENDING
except the push (Kane).
