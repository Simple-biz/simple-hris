# Payroll Wizard — HRIS vs NPD (Validation step tab)

A **HRIS vs NPD** tab on the Payroll Wizard's Validation step (7), in two steps. **Step 1, NPD
Figures**: Accounting pastes the NPD sheet's work emails and dollar figures. **Step 2, Output**
(opened with **Load output**, the input hidden): every person appears once with HRIS's dollar
figure beside NPD's. A **green** row with a check means they agree within N cents (N is set at the
top of the output, default 3). A **red** row
with an ✗ and the difference means they don't. A red **Not in HRIS** / **Not in NPD** means one
side has nobody at that address. Nobody on either side is ever dropped, except people configured
not to be paid this week, who are left out and listed. Display only: it writes
nothing.

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
| Rules tests (parse, buckets, union, work-email-only join, holds, source guards) | `src/lib/payroll/hris-npd-compare.test.ts` |
| Rendered-spec tests (green / red / labels / holds / the two steps / phone layout / wiring guards) | `src/lib/payroll/hris-npd-render.test.ts` |
| The panel: the step rail, and step 2 (rate line, hold banner, chips, the output's search, table) | `src/components/payroll/HrisNpdComparison.tsx` |
| Step 1, **NPD Figures** — the input (paste box, what was read, refused lines, Clear, Load output) | `src/components/payroll/NpdFiguresStep.tsx` |
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

## Two steps: the input, then the output (2026-09-30)

Kane, same day: *"Lets separate the input from the output please hide the input"*, then *"The NPD
Figures lets make this the first step after that it will load the output where we can see the
mismatches"*, then *"add a search bar in the output"*. So the tab is a two-step rail,
**1 NPD Figures → 2 Output**:

| Rule | Why |
|---|---|
| **Step 1 (`NpdFiguresStep`) is the input**: instructions, the paste box, what was read, **every refused line**, Clear, and **Load output** | The input has one place. Nothing about it shows on the output |
| **Load output needs at least one readable line.** With none, the button and the rail's Output are disabled, and asking for step 2 still shows step 1 | There is no output of nothing ("absence is not zero") |
| **Step 2 hides the input.** Its side of the rail shows `NPD Figures · N lines read`, the **skipped count in rose** when there are refusals, and **Edit** (back to step 1, paste intact) | Hiding the input must never hide a refused line |
| **Load output opens a fresh output**: chip back to All, search cleared. Moving along the rail keeps them. The "off by" setting is never reset by either (§ Match) | A new paste is seen whole. A quick look back at step 1 does not lose your filter. The tolerance is a setting, not part of a paste |
| **The step is wizard state, stamped with the week**: it rides in `npdPaste = {sourceFile, text, step}`. Another week, or an emptied paste, is back on step 1 | Otherwise a paste typed for the next week would flip straight to the output mid-typing. The step's panel and the full-screen overlay read the same state (it is in `hrisNpdPanelProps`), so they are always on the same step |
| The output opens on **All**, every row, with the mismatches in red. The **Mismatch** chip narrows to just them | Kane's spec is the whole list, green and red. Filtering is one click and never narrows the totals |
| In full screen, step 1's paste box grows into the overlay's height | Big pastes get room. The rail and the rules are the same panel's |

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

**A person on two lines (the same work email twice) is added together**, and the NPD cell then
says "2 lines added". This follows Kane's 2026-09-29 orphanage ruling (*"if there are two line
items just add them both"*, `orphanage-pay-step.md`), and HRIS pays one figure per person. The
parser does not decide this. The comparison does.

**The key must be the WORK email** (§ Matching people). It is the first email cell on the line, so
the block must start at the Work Email column. That is exactly what step 1 tells the clerk to
select. If a block starts at a personal-email column, its lines key on the personal address, and
each person shows as Not in HRIS plus Not in NPD rather than being matched. There is no
work-email domain rule anywhere in the code to recognise one by, so none is invented here.

## HRIS's figure is the one Payment Dispatch is sent

For each Validation row: **the staged final** (`dispatchNet`, i.e. `pay_php.final`) ÷ **this
cycle's USD→PHP rate**, rounded **exactly** as Send to Payment Dispatch stages `amount_usd`
(`Math.round((php / fx) * 100) / 100`, `stagedUsdCents`). The rules test reads
`PayrollWizard.tsx` and **fails if that staging line changes** without the module. Change both
together or not at all.

- **USD is the comparator** because it is the only figure comparable across PHP- and COP-settled
  people (`cop-country-payees.md`, [[settlement-currency-per-person]]). NPD's figures are USD
  (the 2026-08-18 reconciliation below).
- **No staged payload** (no payout address on file, so the pay run skips them) → the row's
  **Gross**, tagged **"No payout this week"**. The Final Pay table flags the same row red
  `not_dispatchable`. This is about where dispatch would SEND money. It has nothing to do with
  the match, which is on the work email.
- **Where Gross and the staged final differ** (the Final Pay table's red `gross_mismatch`), this
  column follows **dispatch**, not the Gross column. That is on purpose.
- **Two payable Validation rows on one email** are both staged, so both are paid. Their staged
  cents are **summed** ("2 HRIS rows added"), never deduplicated.
- **Who is "in HRIS"**: every PAYABLE Validation row, meaning every department including HSL (the
  same rows as Final Pay, minus the excluded). Contractor invoices (step 6) and orphanage interns
  are not part of it.

### People configured not to be paid are not compared (2026-09-30)

Kane: *"If they are configured not to be paid please lets not include them here"*. There are two
ways to be configured not to be paid this week, and both are the wizard's own do-not-pay settings
for the week (`payroll-wizard-configuration-tab.md` § "Pay this week"):

| Configured by | What happens here |
|---|---|
| **Exclude** ticked on the Final Pay table ("do not pay") | Not a row. NPD's line for them is **not** a false "Not in HRIS" either. They are listed as left out, with what NPD says for them |
| Their department's **"Pay this week"** off (Step 1 → Configuration) | They were never on the step. An NPD line for them is left out, not shown as "Not in HRIS" |

- **Left out, never silent.** The output shows a neutral line: `N people not compared, configured
  not to be paid this week: X excluded on Final Pay · Y in a department paused in Step 1 →
  Configuration. NPD lists Z of them.` **Show who** lists each work email, the reason, and NPD's
  figure (or "not in NPD"). It is neutral, not amber: a deliberate configuration is not a warning.
  `compareHrisNpd` returns them as `leftOut`.
- A paused-department person NPD does **not** list is never counted, since they were never going
  to be a row on this step. Every excluded person is listed, whether or not NPD has them.
- **Edge:** one work email with an excluded row AND a payable row is compared on the payable one.
  The row says `1 excluded row not counted`, and the person is not in the left-out list.
- **"No payout this week" is NOT a configuration** (a missing payout address, a data gap). Those
  rows stay in and are compared like anyone else.
- This reversed the first build (items 292–295), which kept excluded people in as struck green or red
  rows and showed paused people as "Not in HRIS" with a note. That was the brief's CHOSEN 7, whose
  other way was "payable-only".

The rate line prints the divisor (`final pay ÷ ₱61.52 per $1`). **An HRIS-vs-NPD gap is an FX
divisor question before it is a math question** (Payroll Wizard INDEX row; 2026-08-18: all three
reported gaps were 61.52 vs ≈60.93, and the pesos agreed to the centavo). Hovering a mismatch's ✗
gives **the rate NPD's figure implies** against HRIS's pesos. This is a hint only. It is not the FX
cross-check, which is still **OPEN** (`payroll-wizard-final-pay.md` § 2026-08-18).

## Matching people: the work email, exactly

**An NPD line reaches an HRIS row only when its email IS that row's work email**, case- and
whitespace-insensitive. Nothing else: no master-list bridge, no personal address, no alternate
work address. Kane, 2026-09-30: *"We are not connecting this with the personal email please we are
connecting this to the work email."*

That ruling reversed the first build (commits `e8c0cdba` / `7e6a50e3`), which fell back to the
orphanage paste's master-list bridge (work, personal, both alternates). It was the brief's CHOSEN 7.
So:

- **A line whose address is not an HRIS work email is its own Not in HRIS row, and the HRIS row
  stays Not in NPD.** Both are visible and nothing is guessed. That applies to a personal address,
  an old or alternate work address, or a typo alike.
- `compareHrisNpd` takes **no alias input at all** (there is nothing to hand an address to), and
  the wizard passes none. A rules test pins both. Re-adding a bridge is a change to Kane's ruling,
  not a cleanup.
- The HRIS side's address is the Validation row's email, which the wizard treats as the work email
  throughout (MV and Mark Paid key on it: `payroll-wizard-manual-validation.md` § The lookup key is
  `row.id`).

## Match means within N cents, and the operator sets N

`|npdCents − hrisCents| ≤ N`, inclusive. N is set in the output's **"off by" box**: *"Count as a
match when HRIS and NPD are off by at most [N] ¢"*, the first thing at the top of step 2. The
default is **3** (`DEFAULT_MATCH_TOLERANCE_CENTS`). Kane, 2026-09-30, first *"now lets make it match
if the difference is just 3 cents"*, then *"Lets add a user input at the top please after the load
output where the user can set the off by how many cents"*.

| Rule | Why |
|---|---|
| **Whole cents from 0 to 99 only** (`parseToleranceCents`, `MAX_MATCH_TOLERANCE_CENTS`). Anything else (a fraction, a negative, 100+, blank) marks the box red and **changes nothing**: the verdicts keep the last good N, and the hint says which (`Still using 1¢`). Leaving the box puts that N back | The box can never show a number the verdicts are not using. A value is never rounded or clamped into range, so what applies is exactly what was typed |
| `0` = only an exact match counts. **Reset to 3¢** appears whenever N is not the default | 0 restores the first build's "equal to the cent" |
| **One wizard state** (`hrisNpdTolerance`). It builds the comparison and fills the box, and rides in `hrisNpdPanelProps`, so the step's panel and the full-screen overlay always show the same N and the same verdicts. Load output does not reset it | Same rule as the search and the chip. It is a setting, not part of a paste |
| **Never saved**: every load starts at 3 | § Nothing is saved |
| The result carries the N it was given with (`comparison.toleranceCents`), and the "within N¢" tooltip reads it | The wording can never disagree with the verdict |

At the default, the measured cases behind the first build's "equal to the cent, no tolerance" (the
brief's CHOSEN 5) still read the same: the 2026-08-18 gaps ($0.81–$2.68) and that week's $0.07
residue (a sub-minute Hubstaff re-sync) are all **mismatches**. At N = 10 the residue would match.
That is the operator's call, and the box makes it visible.

**A within-tolerance match still shows its difference.** The row is green with the ✓, and
`NPD +$0.02` prints under it (the tooltip says it is within N¢). `deltaCents` is kept on the row, so
the tolerance makes a small gap acceptable, never invisible. A mismatch shows `NPD +$2.68` /
`NPD −$0.07` (NPD minus HRIS) under the ✗. **The default 3 is Kane's number**: do not move it as
cleanup.

## No row is ever dropped

The rows are the **union** of both sides: every payable HRIS email and every NPD address that
parsed. At 1,200 HRIS rows against 1,100 NPD lines, the test asserts one row per distinct person,
unique keys, and exact bucket counts. Rows sort by address. Unreadable paste lines are
**refusals**, listed on step 1, not rows.

**The one exception is people configured not to be paid this week** (§ People configured not to be
paid). They are left out on purpose, and the output says who and why, so this is the only thing
that is not a row, and it is never unaccounted for.

## No verdict before the figures can be judged

`compareHrisNpd` sets `hold` and gives **no row a status** while any of these is true, checked in
this order:

| Hold | When | What shows |
|---|---|---|
| `no_npd_rows` | nothing parsed | **no table at all**: step 1 (NPD Figures) shows, and Load output and the rail's Output are disabled. An empty box is not evidence that NPD has nobody, so "everyone is Not in NPD" would be a false claim |
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

**2026-10-01: NPD now has a home of its own, and this step does not read it.** Accounting → NPD
([npd-dashboard.md](./npd-dashboard.md)) stores the whole NPD sheet per tab per pay week in
service-role-only tables behind its own `npd` grant. This step still takes its own paste and is
unchanged. Wiring it to read the stored sheet is a separate decision, and that read would still
have to apply this step's paste contract to the dollar column (rightmost, fixed, ₱ refused).

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
(`payroll-wizard-final-pay.md` § 2026-09-09). The search matches the work email and the name. It is
a **full-width bar directly above the table**, the Final Pay pattern (Kane, 2026-09-30: *"add a
search bar in the output"*).

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

*Two steps + the output's search + work-email-only matching (2026-09-30, third commit):* both
test files **72/72**. `npm test`: the same 2 pre-existing failures only. tsc clean apart from the
stale `.next/types` errors. Driven in Chromium through the same fixture, wired like the wizard.
That run checked: step 1 shows the paste box and no table; Load output shows the table, the
full-width search and the rail summary with the input hidden; searching narrows to the one row;
Edit returns to step 1 with the paste kept; Clear leaves Load output disabled; full screen opened
from the output shows the output, Edit inside it moves both mounts to step 1, and Escape closes it;
no horizontal overflow at 390px on either step; no console errors. Still **not clicked through
signed in**.

*Within 3 cents (fourth commit) and configured-not-to-be-paid left out (fifth commit), 2026-09-30:*
both test files **81/81** after the fifth. `npm test`: the same 2 pre-existing failures only. tsc
clean apart from the stale `.next/types` errors. Pinned by render tests: a 2¢ match is green and
prints its difference; people configured out are not table rows, and the "not compared" line
counts them by reason.

*The "off by" box (sixth commit, 2026-09-30):* both test files **88/88**. `npm test`: the same 2
pre-existing failures only. tsc clean apart from the stale `.next/types` errors. Driven in Chromium
through the fixture: default 3 keeps a 2¢ row green; setting 1 turns it red and the Mismatch chip
counts it; typing 150 marks the box red and changes nothing ("Still using 1¢"); leaving the box
puts 1 back; 5 set on the step shows as 5 in full screen; Reset brings back 3; no console errors.
Still **not clicked through signed in**.

## Deploy notes

**No migration.** No env var, no n8n import, no route, no `app_settings` key. Nothing is PENDING
except the push (Kane).
