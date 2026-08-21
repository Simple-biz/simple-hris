# Hubstaff zero-hours gap — reminder for Accounting

Approved brief: Readiness dimension + one ingest notification. No cron, no modal.

Kane's rulings (2026-08-21):
- **Q1** Lead Gen stays TRACKED — "this is just to remind accounting if they are still
  active or on leave or Sick". So the list is a reminder, not an accusation.
- **Q2** Approved Vacation leave is a legitimate no-hours week — the existing leave
  exemption stays exactly as it is. No new "known absent" mark.
- **Q3** One zero week is enough to flag. No history, no consecutive-week rule.
- **Q4** Accounting only.
- **Q5** Readiness dimension + ingest notification (the recommendation).

Consequence Kane was told: with Lead Gen tracked and a 1-week threshold the list runs
~190/week, so the dimension is **listed but NOT scored**. That is also what
`readiness-score.ts` demands — `ReadinessScoreComponent['key']` is the closed union
`'rate' | 'kpi' | 'bank'`, `SCORE_WEIGHTS` sums to 1.0 across those three, and the
headline is asserted to be the sum of the component points. A fourth component
would need a weight rebalance nobody asked for.

## Tasks

### 1. Exemption model — label drift
- [x] `src/lib/payroll/hubstaff-reconciliation.ts`: `isHubstaffExemptDept` must survive a
      dept rename that appends a parenthetical qualifier. `HUBSTAFF_EXEMPT_DEPTS` holds
      `'site building'`, but the live labels are `Site Building (US - Freelance)` (20
      people, **0** tracked) and `Site Building (PH - Freelancer)` (13, **0** tracked) —
      33 phantom gaps. Keep the exact-match Set as the primary; add ONE documented
      second pass that strips a trailing parenthetical qualifier and retries.
- [x] `hubstaff-reconciliation.test.ts`: pin all three Site Building labels exempt;
      pin `Lead Gen` NOT exempt (Kane's Q1); pin a negative control that a dept whose
      base label is not in the Set stays tracked even with a parenthetical.

### 2. The shared detector (pure)
- [x] `src/lib/payroll/zero-hours-gap.ts` — ONE rule, three consumers (Overview tile,
      Readiness dimension, notifier). Port `classifyNoHours` from `Overview.tsx:3868`
      verbatim in behavior: dept-exempt → approved leave (overlapping OR upcoming) →
      onboarding timing → unexplained gap. Framework-free, no I/O.
- [x] `zero-hours-gap.test.ts` — one case per branch + the priority order + an
      identity test proving the ported rule agrees with the numbers measured on the
      live Aug 9–15 week.

### 3. Readiness dimension (not scored)
- [x] `src/lib/payroll/payroll-readiness.ts`: `buildZeroHours(...)`, mirroring
      `buildMissingBank`'s scoping — off-board aging, future-hire aging, exception
      identities, paused depts, off-channel depts, alias matching. Add
      `zeroHours` + `zeroHoursCount` to `PayrollReadiness`.
- [x] Do NOT touch `readiness-score.ts`. Assert in a test that the score is
      unchanged by a non-empty `zeroHours`.

### 4. Overview re-point
- [x] `src/components/Overview.tsx`: `classifyNoHours` delegates to the new module so
      the tile, the pane and the email can never disagree. Behavior-identical.

### 5. Notification
- [x] `references/sql/alter/2026-08-21_add_payroll_hours_gap_notification_type.sql` — admit
      `payroll.hours_gap` to `employee_notifications_type_check`.
- [x] `scripts/apply-hours-gap-notification-type.mjs` — `--apply` gate. Kane runs it.
- [x] `src/lib/notifications/zero-hours-gap.ts` — fan out to active `accounting` role
      holders (pattern: `app/api/bank-update/save/route.ts:60`). De-dupe per
      (recipient, source_file) like `payroll-available.ts`. Carries a COUNT + top
      departments, never 190 names. Failures go to `notify-failure-audit.ts`,
      never a bare `console.warn`.
- [x] `src/lib/notifications/notification-views.ts` — `'payroll.hours_gap': ['accounting']`.
- [x] Hook both ingest paths: `app/api/hubstaff-hours/route.ts` and
      `src/lib/hubstaff/run-weekly-sync.ts`, beside the existing
      `notifyPayrollAvailable` call.

### 6. Pane row
- [x] `src/components/accounting/PayrollWizardNotesFab.tsx` — a "No hours this week"
      section in the Readiness pane. Informational tone, never a blocker chip.

### 7. Verify + document
- [x] `node --test` on the new tests; typecheck. Check for a live `next dev` before
      any build (shared `.next/`).
- [x] `docs/features/hubstaff-zero-hours-gap.md`, `docs/features/INDEX.md` row,
      memory `hubstaff-zero-hours-gap` + `MEMORY.md` pointer.
- [x] One commit, staged by explicit path. Never push.

## Guards

- `selectAllPaged` on every roster/hours read — 1287 roster rows, 1047 hours rows.
- DDL lands BEFORE the notifier ships, or every insert is silently rejected
  (`kpi.scored` was dead 3 days that way).
- `vercel.json` is not touched. `/api/cron/*` is 401-dead and the scheduler was
  retired by ruling on 2026-08-20.
