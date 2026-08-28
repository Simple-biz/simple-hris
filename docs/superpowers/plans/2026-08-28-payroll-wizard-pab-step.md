# Payroll Wizard — Step 6 "PAB"

Approved brief: revision 2 (2026-08-28). New step after Contractors listing everyone
ineligible for the current PAB period, with a severity column (failed-day count), a PAB
Calendar button, and a Forgive-the-month action that writes through the existing approved
dispute rail.

## The two decisions that shape everything

1. **Forgive-the-month writes `pab_day_disputes` rows, not a new store.** The approved
   dispute is the only PAB input already read by every verdict implementation and every
   money expression. A new month-level grant blob would need eleven new read sites, and its
   mirror (`pab_period_exclusions`) has never reached a single employee screen.
2. **`override_hours: 7`.** Server-side provably identical to today's `null`/`5`
   (`applyPabAdjustments` bumps anything ≥4h to 7h), but `EmployeeDashboard.tsx:1631` skips
   `null` and 5h sits below the 7h bar — only a 7 clears its violation set. This is what
   makes the employee dashboard inherit with zero dashboard edits.

## Tasks

### 1. Pure module

- [ ] `src/lib/payroll/pab-ineligibility.ts`
  - [ ] `PabDayEntry` = `{ iso, seconds, passes, forgivenByDispute, forgivenByHoliday }`
  - [ ] `computeHslWeekInfo(entries, opts)` — lift the inline clone from PayrollWizard's
        modal IIFE verbatim (qualifyingDays / weekPasses / overnightIsos)
  - [ ] `computePabIneligibility({ entries, isHsl, hslSunSat, periodStart, periodEnd })`
        → `{ severity, failedDays: { iso, seconds, shortfallSec }[] }`
        HSL carve-outs preserved exactly: Sat/Sun never count, overnight-qualifying never
        counts, a day inside a reconciled (`weekPasses`) week never counts.
  - [ ] `buildPabIneligibleRows(...)` — the whole-roster map → row list
- [ ] `src/lib/payroll/pab-ineligibility.test.ts` (`node:test`)
  - [ ] **IDENTITY TEST (the alarm):** for the same inputs, the set of emails with
        `severity === 0` must equal `computePabEligibleEmails(...)`. If this fails, PAB
        money has moved.
  - [ ] non-HSL: one sub-7h weekday ⇒ severity 1
  - [ ] HSL: 2 short days inside a week that still hits 5-of-7 ⇒ severity 0
  - [ ] HSL: weekend days never counted
  - [ ] overnight-qualifying day never counted
  - [ ] forgiven (dispute/holiday) day never counted

### 2. Route

- [ ] `app/api/payroll-wizard/pab-forgive-month/route.ts`
  - [ ] Gate mirroring `app/api/payroll-wizard/manual-validation/route.ts`
        (`requireFeatureAccess` + `requireFeatureEdit`)
  - [ ] Body: `{ email, monthKey, days: string[] }` — server re-derives nothing it can
        avoid, but VALIDATES every day is inside the resolved PAB period
  - [ ] For each day: create + approve a `pab_day_disputes` row with `override_hours: 7`,
        `reason: 'other'`, explanation naming the month
  - [ ] Idempotent — a day already forgiven is a no-op, not a duplicate (the table is
        unique on `(work_email, dispute_date)`)
  - [ ] **All-or-nothing result.** Partial success is reported as failure with a per-day
        readout. Never report "forgave N days".
  - [ ] Re-run the engine after the batch and return the resulting verdict
  - [ ] ONE `pab_dispute.month_forgiven` audit row (actor, month, day count, email) in
        addition to the per-day `pab_dispute.approved` rows
  - [ ] ONE notification, not N

### 3. UI

- [ ] `src/components/payroll/PabIneligibleTable.tsx`
  - [ ] Receives THE SAME rows array the step computes — never a re-filtered copy
        (the `ValidationFullScreen.tsx:29-34` contract)
  - [ ] Columns: person · dept · severity · status · PAB Calendar · Forgive
  - [ ] Severity band: 1–2 = amber "Review" (the HSL shifting-schedule cohort), 3+ = rose
  - [ ] Amber means warning only — never used for an OK state

### 4. Wizard wiring + renumber

- [ ] `steps` array: insert `{ id: 6, label: 'PAB', icon: CalendarCheck }`, renumber
      Validation 7 / Dispatch 8 / Reports 9
- [ ] Renumber sweep — every site below must move together:
  - [ ] `PayrollWizard.tsx` — 16 `currentStep` numeric comparisons
  - [ ] `PayrollWizard.tsx` — `isStepDataLoading` cases + a new row for step 6
  - [ ] `PayrollWizard.tsx` — `renderStepContent` cases + `setCurrentStep(8)`
  - [ ] `PayrollWizard.tsx` — `data-tutorial-target` attributes
  - [ ] `src/lib/payroll-wizard/tutorial/guide.ts` — target literals, `stepId`,
        `resolveStepTargets`, `deriveStepStatus`, the `n >= 1 && n <= 8` bound
  - [ ] `src/lib/payroll-wizard/tutorial/guide.test.ts`
  - [ ] `src/components/payroll-wizard/tutorial/TutorialGuide.tsx` — hardcoded 9s
  - [ ] `src/lib/payroll/wizard-setup-steps.ts` — `stepNo` strings
  - [ ] `src/components/admin/AdminWebhooks.tsx:50` — "Step 7 (Dispatch)"
  - [ ] `src/lib/payroll/validation-breakdown.ts:210` — "Step 7 (Dispatch)"
  - [ ] `app/api/payroll-wizard/audit/route.ts:18` — "Step 8 Reports timeline"
  - [ ] Closing check: `grep -rn "Step [1-9]" src app docs`
- [ ] Align the modal's `handleForgiveDay` override to 7 so the two forgive paths agree

### 5. Verify

- [ ] `node --test` on the new test file
- [ ] `npx tsc --noEmit` (a dev server is live on :3000 — do NOT run `next build`)
- [ ] Assert the two real gates by number after the move: red-flag confirm (was 6 → 7),
      FX-zero hard block (was 7 → 8)

### 6. Document (same commit)

- [ ] `docs/features/payroll-wizard-pab-step.md`
- [ ] `docs/features/INDEX.md` row
- [ ] memory `pab-wizard-step-forgive` + `MEMORY.md` pointer + INDEX wikilink
- [ ] Correct the six stale step-number docs: `docs/reference/system-architecture.md:454`
      (still describes a NINE-step rail), `docs/reference/components.md:615,644`,
      `docs/reference/llm-context.md:38-39`, `docs/features/paystub-dispatch.md:77`,
      `docs/features/bonus-calculator.md:89`, `docs/README.md:76`

## Out of scope (from the brief)

- What PAB pays — `dispatch-bonuses` / `current-pay` / `member-monthly-pay` verdicts
- `pab_period_exclusions`, time-adjustment dual sign-off
- `payroll.wizard.final_pay.<file>` blob shape (9 readers)
- The step-4 Attendance Issues panel and the modal's per-day Forgive — both stay
- EmployeeDashboard's dispute-overlay bug — it inherits via `override_hours: 7`
