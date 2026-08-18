# Readiness activity feed + KPI submission attribution

Approved blueprint (Kane, 2026-08-18): Q1=(a) audited saves only — no presence, no
unattributed scoring pulse; Q2 = last 15 minutes, newest first, cap 8 lines;
Q3 = People-tab profile edits (name parts, transfers) belong in the feed too.

Render-only over `audit_log` (the Processing Narrative invariant): **no new
tables, no new audit actions.** The feed is informational — it never becomes a
score dimension, and a failed audit read yields an empty feed silently (a
missing feed doesn't flatter the dashboard, so it stays out of `degraded[]`).

## Action allowlist → surface

| Action | Surface | Line |
| --- | --- | --- |
| `payroll.rate.set` | rates | set a pay rate (Payment Catalog) |
| `employee.rates.revoke` | rates | revoked a rate history row |
| `bank_update.saved` | bank | updated payout details |
| `people.banking.updated` | bank | updated banking details (People tab) |
| `people.bank_info.requested` | people | requested bank info (People tab) |
| `people.profile.updated` | people | edited a profile (People tab) |
| `department_transfer.requested` | people | requested a department transfer |
| `payroll.kpi.marked_ready` | kpi | marked <dept> KPI scores ready |
| `payroll.kpi.locked` | kpi | locked <dept> KPI scores |
| `payroll.kpi.reopened` | kpi | reopened <dept> KPI scores |

Templates only — the mapping never prints `details` verbatim (rate amounts and
bank fields stay out of the feed).

## Tasks

- [ ] 1. `src/lib/payroll/readiness-activity.ts` — pure, client-safe (no
      `server-only`): `ReadinessActivityLine`, `ACTIVITY_WINDOW_MS`,
      `ACTIVITY_MAX_LINES`, `buildActivityLines(rows, nowMs, deptNames?)`,
      `latestKpiSubmissionByDept(rows, periodStart)`.
      Tests (`node:test`, sibling file): window filter, newest-first cap,
      unknown actions dropped, latest-per-dept pick honors period_start,
      no `details` leakage into labels.
- [ ] 2. `src/lib/payroll/payroll-readiness.ts` — two `selectAllPaged` audit
      reads (feed window; `payroll.kpi.*` since the period start, matched to
      `details.period_start` client-side to keep the `created_at` index).
      Best-effort try/catch → empty feed / no attribution, NOT degraded.
      `ReadinessKpiDept` gains optional `submittedBy/submittedAt/submittedVia`
      (audit actor wins; `locked_by`/`locked_at` status-row fallback for weeks
      predating the ~Jul-25 trail). `PayrollReadiness` gains `activity`.
- [ ] 3. `PayrollWizardNotesFab.tsx` — KPI Submissions rows show
      "Submitted by <name> · <date, time> (· via <source>)" on ready/locked;
      pane bottom gets a frozen (shrink-0) activity-feed strip under the
      scrolling detail body, refreshed by the pane's existing Realtime + 30s
      poll cycle.
- [ ] 4. Typecheck + tests (expect the pre-existing executive_assistants
      failure only).
- [ ] 5. Docs: new section in `docs/features/payroll-readiness.md`, memory
      `readiness-activity-feed` + MEMORY.md pointer + INDEX row-16 wikilink.
      One commit, explicit paths.

No migration.
