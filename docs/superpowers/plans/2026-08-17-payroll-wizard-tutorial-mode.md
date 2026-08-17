# Payroll Wizard — Processing Tutorial Mode + Processing Narrative trail

Approved brief (2026-08-17). Kane's rulings:

- **Trail window = calendar Sun–Sat week** — so on/off toggles are auditable against the
  week itself, regardless of which cycle is active or whether processing is stopped.
- **Narrative = deterministic templates**, no AI.
- **Tutorial shows every processing session** (dismissible), driver-only.
- **Tutorial follows the shipped step order 1→9.** Never gates: no forced clicks,
  everything skippable, statuses advisory.
- **One-shot deletable**: all new code in dedicated folders; every touchpoint in an
  existing file carries a grep-able `[WIZARD-TUTORIAL]` marker; the feature doc has a
  Removal section listing exact artifacts.

Already shipped, out of scope: sidebar auto-retract on lock (App.tsx:85-102, animated
via `--sb-collapse-ms`), per-cycle AuditTrailPanel on Reports (PayrollWizard.tsx:~16846),
audit event vocabulary + POST sites.

## Tasks

- [ ] **Pure lib — guide** `src/lib/payroll-wizard/tutorial/guide.ts` (+ `guide.test.ts`, node:test)
  - `TUTORIAL_STEPS`: one entry per wizard step 1–9 — title, hint copy, spotlight
    target keys, kind (`action` | `review`).
  - `deriveStepStatus(stepId, signals)`: pure — serializable `TutorialSignals` in,
    `pending | attention | done` + note out. Signals read existing wizard state only
    (report uploaded/week match, fx zero, orphanage rows, pending contractor count,
    validation blockers, dispatch done, visited set).
  - localStorage key helpers per (email, sourceFile): dismissed, visited steps.
- [ ] **Pure lib — narrative** `src/lib/payroll-wizard/tutorial/narrative.ts` (+ test)
  - `payrollWeekWindowFor(date)`: Sun 00:00 local → next Sun 00:00 (local instants out as ISO).
  - `buildProcessingNarrative(events, window)`: group by lock sessions
    (`dispatch.lock_acquired` … `lock_released`), events after a stop stay in the week's
    trail ("After processing stopped…"). Templated sentences, counts by category,
    FX values, dispatch totals. Deterministic; tested with fixture events.
- [ ] **Server** `src/lib/payroll-wizard/tutorial/week-audit.ts` +
      `app/api/payroll-wizard/audit-week/route.ts`
  - GET `?window_start=ISO&window_end=ISO` (explicit instants from the client — no
    server TZ guessing). Same gate as the sibling audit route
    (`requireRateVisibilityOrFeatureEdit('accounting','payment_dispatch')`).
  - Query mirrors `cycle-audit.ts` strategy 2 (action whitelist + created_at window),
    **paged via `selectAllPaged`** (PostgREST 1000 cap).
- [ ] **UI** `src/components/payroll-wizard/tutorial/TutorialGuide.tsx`
  - Floating rail: 9 steps w/ status badges, current hint card, Go-to-step /
    Next / Skip / collapse / dismiss. Never blocks: spotlight layer is
    `pointer-events-none`; rail chrome only interactive part.
  - Spotlight ring around `[data-tutorial-target]` anchors; re-measure on step
    change / resize / scroll; missing anchor degrades to rail-only.
  - Rendered inside the wizard container (inherits theme; no portal).
- [ ] **UI** `src/components/payroll-wizard/tutorial/ProcessingNarrative.tsx`
  - Reports-step section above AuditTrailPanel. Defaults to the current Sun–Sat
    week, ◀ ▶ week navigation. Renders narrative chapters + session on/off ledger.
- [ ] **Wiring** in `PayrollWizard.tsx`, every block marked `[WIZARD-TUTORIAL]`
  - `data-tutorial-target` attrs: step-1 Hubstaff weekly upload + Configuration tab,
    orphanage Paste Data field, HSL review region, Additions System Bonus (PAB range +
    Tech-bonus period selector), Contractors pending list, Validation table/exclude,
    Dispatch lock-in CTA, Reports audit trail.
  - Signals `useMemo` + `<TutorialGuide>` mount when `isLockDriver && lockState.locked`.
  - `<ProcessingNarrative>` in the Reports step.
- [ ] **Verify** `node --test` on new libs; `npx tsc --noEmit`; check for live dev
      server before any build.
- [ ] **Docs**: `docs/features/payroll-wizard-tutorial-mode.md` (with **Removal
      (one-shot)** section), INDEX row, memory `payroll-wizard-tutorial-mode` +
      MEMORY.md pointer. Same commit as code.
- [ ] **Commit** direct to main, explicit paths, `git status` re-run first. No push.

## Data

No migration. Reads existing `audit_log` rows; tutorial state in localStorage.

## Removal contract (design constraint)

Delete: `src/lib/payroll-wizard/tutorial/`, `src/components/payroll-wizard/tutorial/`,
`app/api/payroll-wizard/audit-week/`, feature doc + INDEX row + memory entry; then strip
every `[WIZARD-TUTORIAL]`-marked block and `data-tutorial-target` attribute from
`PayrollWizard.tsx`. Nothing else in the repo may reference the feature.
