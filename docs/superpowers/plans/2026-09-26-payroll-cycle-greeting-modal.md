# Accounting → Payroll cycle greeting modal ("Hi Kane")

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`. Steps use `- [ ]` syntax.

**Goal:** when an Accounting person with Overview access **and** the Payroll Wizard grant opens the
Accounting dashboard, a modal greets them by first name. It shows the **live** payroll cycle's
Wizard Setup checklist, with the unfinished steps first and in their face ("USD → PHP / COP rates
not updated", "orphanage hours not synced"), and a **Go to Step N** button per item.

**Spec:** the `BLUEPRINT` brief posted in session `966f96da` on 2026-09-26 (audit item **234**).
Builds on item 233 (the Overview Payroll Notes card, `da7d22f5`). Kane's rulings:

| # | Ruling | Consequence |
|---|---|---|
| Q1 | (a) Overview access AND Payroll Wizard view | client gate on both tabs + the readiness route's own `payroll_wizard` view gate; a 403 never opens it |
| Q2 | (a) once per browser session | a UI flag in the Accounting tab cache: identity-stamped, purged on sign-out / viewer swap, 12h ceiling |
| Q3 | Go to Step N | new `jumpRequest` prop on `PayrollWizard`; **edit grant only** (the tab is `ReadOnlyTab strict` for view-only users); refused while spectating a driver |
| Q4 | don't open when every step is done | `shouldOpen = items.length > 0` |
| Q5 | (a) a closed week with no CSV leads the list | synthetic top item "Upload the <week> Hubstaff CSV" → Step 1 |

## Global constraints

- **Render `wizardSetup` as sent.** Status, detail, `stepNo` come from the server; the modal adds
  only presentation (a headline per step key). A failed read (`pending`) is never shown as done.
- **The step shown is DERIVED** — the first unfinished row in rail order. The wizard's own
  `currentStep` is in-memory, and the driver's step is broadcast-only (`useWizardFollow`).
- **A jump has exactly the power of a rail click** — never more: no jump for a view-only viewer,
  none while spectating, and it only ever switches the cycle BACK to the live period (never into
  a replay).
- Dialog: `max-h` + inner scroller + `gap-0` + an explicit `sm:max-w-*` (dialog-content-no-height-cap).

## Tasks

### Task 1 — pure rules (+ tests)

- [x] `src/lib/payroll/wizard-setup-spotlight.ts`: export `openStepsBySeverity` (the ordering
      `buildSpotlightSlides` already uses) so the modal and the card share it.
- [x] `src/lib/payroll/cycle-greeting.ts`: `buildCycleGreeting(setup)` →
      `{ shouldOpen, nextUp, items, done }`. Items: awaiting-week CSV first (Q5), then open steps
      by severity; each with `jumpStep` parsed from `stepNo`, and a headline (imperative for
      attention/blocked, the label for pending).
- [x] `src/lib/payroll-wizard/step-jump.ts`: `planWizardJump(...)` → refused (spectating / bad
      step) or `{ step, switchToFile }`, where `switchToFile` is set only when the request names the
      newest upload and the wizard is elsewhere.
- [x] Tests next to each.

### Task 2 — the "shown this session" flag

- [x] `TAB_CACHE_KEYS.cycleGreetingShown` in `src/lib/accounting/tab-cache.ts` (UI flag, value `true`).

### Task 3 — the wizard accepts a jump

- [x] `PayrollWizard` gains `jumpRequest?: { step; sourceFile; nonce } | null`; one effect applies
      each nonce once, after the upload list has loaded, via `planWizardJump`; toasts when refused.

### Task 4 — the modal

- [x] `src/components/accounting/PayrollCycleGreetingModal.tsx`: readiness (live week) via
      `readiness-cache.ts`; first name via `/api/employees?email=` + `resolveFirstName`; opens
      ~600ms after data is ready and never over another open dialog; marks the session flag on open.

### Task 5 — App.tsx wiring

- [x] Gate (perms + pages loaded, email known, Overview + Payroll Wizard accessible and visible).
- [x] `goToWizardStep(step, file)`: flip `wizardMode` to simple, set `wizardJump`, navigate.
- [x] Pass `jumpRequest` to `<PayrollWizard>`.

### Task 6 — verify + document

- [x] `tsc`, `npm test`; no `next build` if a dev server is live.
- [x] Feature doc + INDEX + README rows, components.md, payroll-readiness.md (third reader),
      accounting-dashboard-cache.md (new key), memory, close audit item 234.
