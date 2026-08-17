# Payroll Wizard Tutorial Mode — driver-only processing guide + week narrative

When Payroll Processing is started (the dispatch lock flips on), the lock **driver** gets a
floating **chat head** (a small messenger-style bubble, bottom-right — explicitly NOT a panel
or modal, Kane 2026-08-17) that walks the shipped wizard steps 1→9. Tapping the head toggles a
compact speech balloon with the current step's hint, advisory note, and nine status dots; the
teaching itself is done by spotlight rings drawn over each step's key indicators. The Reports step additionally
gains a **Processing Narrative**: a templated, plain-English retelling of the calendar week's
audit events — every Start/Stop toggle and what happened around them. Shipped 2026-08-17.

## Key files
| Piece | File |
| --- | --- |
| Step definitions + advisory status derivation (pure) | `src/lib/payroll-wizard/tutorial/guide.ts` |
| Week window + narrative builder (pure) | `src/lib/payroll-wizard/tutorial/narrative.ts` |
| Week-scoped audit query (server, paged) | `src/lib/payroll-wizard/tutorial/week-audit.ts` |
| API route | `app/api/payroll-wizard/audit-week/route.ts` |
| Chat head + balloon + spotlight | `src/components/payroll-wizard/tutorial/TutorialGuide.tsx` |
| Narrative section (Reports step) | `src/components/payroll-wizard/tutorial/ProcessingNarrative.tsx` |
| Wizard wiring (marked blocks + anchors) | `src/components/PayrollWizard.tsx` — grep `[WIZARD-TUTORIAL]` and `data-tutorial-target` |

## The guide never gates — that is the contract, not a preference

Kane's rule (2026-08-17): *tutorial mode, not a wizard-within-the-wizard*. The spotlight layer
is `pointer-events-none`; the statuses (`pending` / `attention` / `done`) are badges derived in
`guide.ts` and grant or deny **nothing**; every step is skippable; the balloon tucks away into
the head and "Hide for this cycle" removes the whole thing until the next cycle. The head is
UI-shaped like a chat head on purpose — a later redesign must not grow it back into a panel or
modal. The wizard's real gates (FX-zero hard-gating Step 8, the Step-7 red-flag confirm) live
where they always lived — do not move a gate into the guide, and do not "fix" a wrong badge by
blocking navigation. It looks like a missing feature that "Next" works while a step shows
`attention`; it is the feature.

The guide mounts only for `isLockDriver && lockState.locked` — spectators are already in
read-only follow mode (`useWizardFollow`) and must never see a second overlay.

Dismiss/collapse/visited state persists in localStorage per **(driver email, cycle
source_file)** (`tutorialStorageKey`) — dismissing this week's guide must not hide next week's.

## The narrative window is the CALENDAR Sun–Sat week, not the cycle and not the lock

Kane's ruling (2026-08-17): the point of the narrative is auditing **when processing was turned
on and off and why-shaped context around it**, so the window is the calendar week
(`payrollWeekWindowFor`, local Sunday 00:00 → next Sunday 00:00). Two consequences that look
like bugs but aren't:

- **Stopping processing does not stop the trail.** Events after `dispatch.lock_released` render
  in a dashed "with processing off" segment of the same week. The trail ends only when the next
  week begins.
- **A cycle switch mid-week does not reset the narrative.** The per-cycle view is the existing
  `AuditTrailPanel` below it; the narrative deliberately answers a different question.

The client computes the window in its own timezone and sends explicit instants
(`window_start`/`window_end`); the server validates span ≤ one week and never guesses week
boundaries. The query pages via `selectAllPaged` (PostgREST truncates at 1000 even with
`.range()`).

## Render-only: the close-out stays the only per-cycle record

The narrative is computed at view time from `audit_log` rows that existing code already writes
(`dispatch.lock_acquired`/`lock_released`, wizard edits, FX changes, contractor/orphanage/gift
decisions, dispatch events). This feature **persists nothing** and adds **no audit actions** —
`cycle-closeout.md`'s invariant (the close-out is the only per-cycle record, allowed to record
failure) is untouched. If the narrative ever needs a new event, add the POST at the acting
surface with cycle context, never a narrative-side write.

Sentences are deterministic templates in `narrative.ts` (Kane rejected AI-written prose).
Chatty categories (wizard/bonus/addition edits) aggregate into counts; money-moving events get
one line each.

## Anchors degrade, never crash

Spotlight targets are `data-tutorial-target` attributes on stable wizard containers. The wizard
stays mounted across dashboard tabs and re-renders freely, so `TutorialGuide` re-measures on
step change/resize/scroll plus a slow interval; an anchor that is missing or collapsed (hidden
tab pane) is simply skipped — the guide runs head-only. Never anchor by text or DOM position.

## Adjacent, already-shipped behavior this feature leans on (do not duplicate)

- **Sidebar auto-retract on Start Processing** — `App.tsx` (collapse + restore around the lock,
  animated by the sidebar's `--sb-collapse-ms` transition). The tutorial did not add this.
- **Per-cycle audit trail** — `AuditTrailPanel` on the Reports step, cycle-keyed.
- **Start/Stop = the dispatch lock** — `payroll.dispatch_locked` in `app_settings` via
  `useDispatchLock`.

## Removal (one-shot)

The whole feature deletes cleanly, by design. To remove it:

1. Delete `src/lib/payroll-wizard/tutorial/` (guide, narrative, week-audit, tests).
2. Delete `src/components/payroll-wizard/tutorial/` (TutorialGuide, ProcessingNarrative).
3. Delete `app/api/payroll-wizard/audit-week/`.
4. In `src/components/PayrollWizard.tsx`, remove every block commented `[WIZARD-TUTORIAL]`
   (import block, `tutorialSignals` memo, the `<TutorialGuide>` mount, the
   `<ProcessingNarrative>` block on Reports) and every `data-tutorial-target="…"` attribute.
5. Delete this doc, its `docs/features/INDEX.md` row, the memory entry
   `payroll-wizard-tutorial-mode` (+ its MEMORY.md line), and
   `docs/superpowers/plans/2026-08-17-payroll-wizard-tutorial-mode.md`.

Nothing else references the feature: no DB objects, no n8n, no env vars, no cron. localStorage
keys (`wizard-tutorial:*`) become inert orphans and may be ignored.

## Deploy notes

**No migration.** No env vars, no n8n imports, no cron. Reads existing `audit_log` rows through
a new same-gated route (`requireRateVisibilityOrFeatureEdit('accounting','payment_dispatch')`,
mirroring `/api/payroll-wizard/audit`).
