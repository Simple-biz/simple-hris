# Wizard Setup checklist in Payroll Readiness + Step-1 CSV warning modal

**Date:** 2026-08-03
**Status:** Approved (design), pending implementation plan
**Owner:** Kane / Accounting

## Goal

Give Accounting a per-week, per-wizard-step setup checklist inside the Payroll Notes →
Readiness tab — "everything that must be set before the cycle can go to Payment
Dispatch" — and warn inside the Payroll Wizard itself (Step 1) when a new pay week has
started but its Hubstaff CSV hasn't been uploaded yet.

Decisions locked with Kane (2026-08-03):

1. The checklist is **separate from the readiness score** — the 0–100 score, its
   rate/kpi/bank weights, blocker pins, grade rules, and the FAB ring are untouched.
2. Checklist rows: Hubstaff CSV (step 1), USD→PHP rate (step 2), Orphanage hours
   (step 3), KPI bonuses (steps 4–5), Notes adjustments (step 5), Contractor invoices
   (step 6), Sent to dispatch (step 8).
3. "USD amount set for this week" = **weekly confirm marker**, stamped on save or via a
   new "Confirm for this week" button (the global setting is sticky, so existence alone
   proves nothing).
4. Orphanage: rows for the cycle **or** an explicit "No orphanage hours this week"
   confirm marker. Real rows always outrank the marker.
5. Step-1 modal "Ignore" silences it **for that pay week on that browser**
   (localStorage keyed by week); it auto-disappears the moment the CSV lands.
6. Checklist placement: a section in the Readiness tab **below the hero, above the stat
   tiles**.
7. Checks are computed **server-side by extending the readiness API** (no second
   endpoint, no client-side RLS pitfalls).
8. **Readiness only reads its own week**: someone not yet hired during the week in
   view (master Start Date after the week's end) must not exist anywhere in that
   week's readiness — lists or denominators (added on approval, 2026-08-03).

## Week anchoring (load-bearing)

- **Expected pay week** = `payrollNotesWeekStart()` (`src/lib/payroll/manila-week.ts:42`)
  — Sunday of the current Manila week minus 7 days (Sun–Sat, one week in arrears).
- The checklist anchors to the expected pay week whenever the Readiness pane is on
  "current" — **not** to the `is_current` upload the rest of the pane uses. When the new
  week's CSV is missing, the pane's people-data is still last week's file; anchoring the
  checklist to it would show last week fully green and mask exactly the gap this feature
  exists to surface.
- When the Readiness week selector is on a specific past file, the checklist evaluates
  **that file's week** (its filename Sunday) — historical view.
- When the checklist week ≠ the pane's resolved data week, `wizardSetup.mismatch = true`
  and the CSV row's detail says so: "Not uploaded — sections below show Jul 19 – Jul 25".
- Week keys always derive from the Hubstaff filename's date-range **start, verbatim**
  (`parseDateRangeFromFilename`, `src/lib/hubstaff/calendar-column-dedupe.ts:735`) — never
  Monday-anchored (see warning at `src/lib/payroll/payroll-readiness.ts:236`).

## Server design

New module `src/lib/payroll/wizard-setup-status.ts`:

- Pure, unit-testable status-builders (one per row) + one I/O assembler
  `buildWizardSetup(...)`.
- Called inside `getPayrollReadiness()`'s existing `Promise.all`
  (`src/lib/payroll/payroll-readiness.ts:1327`); result added to the `PayrollReadiness`
  response as `wizardSetup`.
- Read failures append human-readable notes to `degraded[]` (existing convention) and
  yield `status: 'pending'` with a "couldn't read" detail — never a false green/red.
- The scorer (`readiness-score.ts`) is **not** touched.

```ts
export interface WizardSetupStep {
  key: 'csv' | 'fx' | 'orphanage' | 'kpi' | 'notes' | 'contractors' | 'dispatch';
  stepNo: string;              // "1", "2", "3", "4–5", "5", "6", "8"
  label: string;
  status: 'done' | 'attention' | 'blocked' | 'pending';
  detail: string;              // "Uploaded Sun 13:05 · 412 rows" / "2 awaiting approval"
}

export interface WizardSetup {
  expectedWeekStart: string;   // Sunday ISO the checklist evaluates
  weekLabel: string;           // "Jul 26 – Aug 1"
  matchedSourceFile: string | null; // upload whose filename week == expected week
  mismatch: boolean;           // pane's data week ≠ expected week
  steps: WizardSetupStep[];
  doneCount: number;
  totalCount: number;
}
```

### The seven predicates

| # | key | Done when | Otherwise |
|---|-----|-----------|-----------|
| 1 | `csv` | any `hubstaff_uploads` row's filename parses to the expected Sunday | **`blocked`** (the only rose row). Newest upload with an unparseable name → `attention` "can't tell — file name has no week" |
| 2 | `fx` | app_settings `payroll.wizard.fx_confirmed.<weekStart>` exists | `attention` — "Confirm on Step 2" |
| 3 | `orphanage` | `orphanage_pay` rows exist for `matchedSourceFile`, OR `payroll.wizard.orphanage_confirmed.<weekStart>` exists | `attention` — "Paste hours or confirm none on Step 3" |
| 4–5 | `kpi` | every due department's KPI period is Ready/Locked — reuses the KPI rows `getPayrollReadiness` already computes (no duplicate queries) | `attention` — "7/9 · SSD, NPD pending"; `pending` (neutral) when no departments are due |
| 5 | `notes` | zero `payroll_wizard_notes` rows for the week with a strict-parseable Adjustment amount (`parseAdjustmentAmount`, `src/lib/payroll/adjustment-bridge.ts:102`), OR every noted worker's normalized email has a non-empty Adj. override in the cycle's additions blob (`payroll.wizard.additions.<sourceFile>`) | `attention` — "2 of 3 not yet in wizard" |
| 6 | `contractors` | zero `pending` (non-stranded) contractor invoices riding this cycle — reuse the window + stranded rules from `src/lib/contractor/contractor-dispatch-queue.ts` | `attention` — "2 awaiting approval" |
| 8 | `dispatch` | `payroll.dispatch_lock.<matchedSourceFile>` has `locked: true` — detail "Locked by X · Thu 14:02" | **`pending`** (sky/neutral) — it's the end-state, not a warning |

Notes check is **existence-based** (does the worker have an override at all), not
equality-based: the bridge has no per-note "applied" column (it's window-event driven),
and hand-tweaked overrides after a pull are legitimate. Existence catches the real
failure mode on record (a whole week of notes never pulled) without false ambers.

When `matchedSourceFile` is null (CSV not uploaded yet): `orphanage` can only be green
via the confirm-none marker, `notes` compares against no blob (all noted workers count
as not-applied), `contractors` still evaluates (window-based), `dispatch` is `pending`.

## Week-scoped roster (existing readiness dimensions)

Rule: every readiness dimension evaluates only people who were on board during the week
in view. A hire whose master Start Date is **after the week's end** (weekStart + 6 days)
must not appear in that week's readiness period — current week or a past week via the
selector.

Per dimension:

- **Rate check** (`buildMissingRates`, `payroll-readiness.ts:751`) — already
  week-scoped: its population is the week's Hubstaff file roster; a future hire has no
  hours in it. **No change.**
- **Bank check** (`buildMissingBank`, `payroll-readiness.ts:1058`) — the leak. Its
  population is the current active-roster snapshot with an off-board aging rule
  (`:1166`) but no future-hire filter. **Add:** skip a person when their normalized
  start date (`normalizeStartDate`, `:540` — already handles the US-format master
  Start Date landmine) is strictly after the week's end **and** they are not
  `onPayroll`. Hours in the week's file always win (a stale/wrong start date must never
  hide someone actually being paid — same fail-safe shape as the off-board guard).
  Missing/unparseable start dates stay listed (fail toward over-flagging, the
  dimension's existing direction). The skip removes them from the list **and** from
  `eligibleCount` / `onPayrollEligibleCount`, so `bankEligibleCount`,
  `bankOnPayrollCount`, and `missingBankOnPayroll` all shrink consistently.
- **Exceptions** (`buildExceptions`, `payroll-readiness.ts:1214`) — pipeline rows
  (`onboarding` / `awaiting_orientation` / `no_show`) with a **known** staged start
  date after the week's end leave that week's visible list. Their `identities` still
  feed the rate/bank exclusion sets unconditionally (an onboarding hire must never cost
  points on any dimension, whichever week is in view). Dateless pipeline rows stay
  visible (can't place them in time; exceptions are informational and never scored).
  `started_this_week` is already window-scoped — no change.
- **Score:** the formula, weights, and pins are untouched — only its *inputs* shrink to
  the week-true population, which is the point.

Tests must cover: future-start person excluded from bank list + both denominators;
future-start person WITH hours in the week's file stays (onPayroll wins); unparseable
start date stays; past-week view excludes a person hired after that week.

## Weekly confirm markers (app_settings, audited)

| Key | Value | Written by |
|-----|-------|-----------|
| `payroll.wizard.fx_confirmed.<weekStart>` | `{ rate, by, at }` | Step 2's existing Apply & Save handlers (`PayrollWizard.tsx:9995` Enter, `:10049` button), plus a new lightweight **"Confirm for this week"** button on the rate card for no-change weeks |
| `payroll.wizard.orphanage_confirmed.<weekStart>` | `{ none: true, by, at }` | new small **"No orphanage hours this week"** button on Step 3, rendered only while the cycle has zero `orphanage_pay` rows |

- `<weekStart>` = the filename Sunday of `calcSourceFile`
  (`hubstaffWeekStart`, `PayrollWizard.tsx:2148`), falling back to
  `payrollNotesWeekStart()` when no file is selected — so writers and the readiness
  reader agree on the key.
- Writes go through the existing `POST /api/app-settings` path (permission-gated,
  audit-logged like the current `usd_to_php_rate` save).
- Markers are per-week; nothing is ever cleaned up or migrated (dead keys for past weeks
  are inert, matching `payroll.wizard.additions.<file>` precedent).

## UI: WizardSetupSection (Readiness pane)

In `src/components/accounting/PayrollWizardNotesFab.tsx`, between `ReadinessHero` and
the stat-tile grid (`PayrollReadinessGlance`, section renders around `:3068`):

- `PaneBody`-styled card. Header: **"Wizard setup · Jul 26 – Aug 1"** + `N/7` done
  count + collapse chevron. Defaults **open** while anything is unfinished, **collapsed**
  once all seven are done (no persistence).
- Row = step-number chip (`1`, `2`, `3`, `4–5`, `5`, `6`, `8`) + label + status pill +
  truncating detail text. Tones follow the pane's palette: emerald done, amber
  attention, rose blocked (CSV only), sky pending/neutral.
- **Read-only** — no write-actions in rows; detail text names the wizard step to fix on.
- Live refresh: add `hubstaff_uploads`, `orphanage_pay`, `payroll_wizard_notes`, and the
  contractor-invoice table to `useLiveRefresh({ tables })` (`PayrollWizardNotesFab.tsx:2836`).
- `ReadinessSkeleton` gains a matching shimmer block. The FAB ring keeps its score-only
  fetch — unaffected.

## Wizard Step 1: CSV warning modal

- shadcn `Dialog`, following the house pattern of the upload-confirm modal
  (`PayrollWizard.tsx:15847`), with the amber `AlertTriangle` callout style (`:15796`).
- Title: **"This week's Hubstaff CSV isn't uploaded yet"**. Body: the expected pay week
  label (e.g. *Jul 26 – Aug 1*) and what the newest upload actually covers.
- Buttons: primary **"Upload now"** → close + ensure Step 1's `upload` tab is active;
  outline **"Ignore for this week"** → write
  `localStorage["payroll.wizard.csvWarnIgnored.<weekStart>"]` and close.
- Trigger (all must hold): uploads list finished loading (`sourceFilesLoading` false) ∧
  `currentStep === 1` ∧ no upload's filename parses to `payrollNotesWeekStart()` ∧ the
  ignore key is absent. Re-evaluates when the uploads list changes, so it never appears
  once the CSV lands (including mid-session after an upload).
- The live Hubstaff API sync was removed from the wizard (rate limits — CSV only), so
  the modal offers no "sync now" action.

## Testing & verification

- Unit tests for the pure status-builders: each predicate's done/attention/blocked
  derivation, week-mismatch flag, rows-beat-marker precedence (orphanage), unparseable
  filename handling, degraded/read-failure path.
- Extend `scripts/verify-readiness.mts` to print the `wizardSetup` block (it runs the
  real `getPayrollReadiness()` against the live DB, read-only).
- Manual pass on `next dev` — check for an already-running dev server first
  (shared `.next/` dir).
- Update `docs/features/payroll-readiness.md` (key-files table, new section for the
  checklist, week-anchoring note).

## Non-goals

- No changes to score math, weights, pins, grades, or the FAB ring. (The week-scoped
  roster rule changes the score's *inputs* — who counts — never the formula.)
- No new hard gates on Payment Dispatch — its existing soft warnings and locks stand.
- No write-actions inside checklist rows (fixes live in the wizard steps).
- No notifications, schedulers, or n8n work.
- No Monday HRIS board involvement (the 2026-07-28 hold stands).
