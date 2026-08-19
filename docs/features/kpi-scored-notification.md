# KPI Scored notification — the employee hears the number move

When a manager publishes a dept-week's KPI scores (Mark Ready / Lock), or a bonus
change lands on a week that is already published, every affected employee gets a
`kpi.scored` notification carrying the peso amount — a bell + toast on the Employee
dashboard (top-right), a Trophy card in their notifications panel, and the KPI
Results tab refreshes within the same ~30s beat. Shipped 2026-08-17.

## Key files
| Piece | File |
| --- | --- |
| Notify helper + re-notify policy | `src/lib/notifications/kpi-scored.ts` (+ `.test.ts`) |
| Trigger: submit (Mark Ready / Lock) | `app/api/hsl-bonus/period-status/route.ts` |
| Trigger: catalog bonus writes | `app/api/bonus-catalog-applied/route.ts` |
| Trigger: HSL entry writes | `app/api/hsl-bonus/entries/route.ts` |
| View mapping (`employee`) | `src/lib/notifications/notification-views.ts` |
| Toast + bell mount | `src/components/employee/EmployeeApp.tsx` (`useNotificationChime`, view `employee`) |
| Panel card (Trophy) | `src/components/notifications/NotificationsPanel.tsx` |
| Employee tab refresh | `src/components/employee/EmployeeKpiResults.tsx` (30s visible-tab poll) |
| DDL + apply script | `references/sql/alter/2026-08-17_add_kpi_scored_notification_type.sql` · `scripts/apply-kpi-scored-notification-type.mjs` |

## The de-dupe key is the AMOUNT, never "already notified"

Kane's ruling (2026-08-17): corrections must RE-notify. A dispute leads to a new or
changed bonus on an already-published week, and the employee must learn the number
moved. So every trigger call recomputes the dept-week's per-person visible totals
(catalog `amount` + HSL `calculated_bonus`, aliases merged by summing — the same
union `employee-kpi-results.ts` shows) and diffs against the `details.amount` of each
person's LATEST `kpi.scored` row for that (department, period_start):

- first time, non-zero → **"KPI Bonus Scored"**
- amount changed (up, down, or to zero) → **"KPI Bonus Updated"** with `previous_amount`
- unchanged → nothing · first-time zero → nothing (never announce ₱0)

Do not "simplify" this into notify-once-per-week — that reverts the ruling. And do
not remove the drop-to-zero notification: a silent drop is exactly the surprise this
feature exists to prevent. The policy lives in two pure functions
(`sumKpiTotalsByEmail`, `planKpiScoredInserts`) whose tests pin every branch.

## Drafts are structurally silent — that's what makes autosave safe

`POST /api/bonus-catalog-applied` and `POST /api/hsl-bonus/entries` are the KPI
Calculator's **autosave** paths, firing on every debounced score save. Hooking them
is safe only because `notifyKpiScored` returns before reading a single bonus row
unless the week's `hsl_bonus_period_status` is `ready`/`locked` — mirroring the
employee visibility gate in `employee-kpi-results.ts` (employees never see drafts,
so drafts never notify). On a published week an autosave that changes nothing
diffs to nothing. **Every notify call is best-effort in try/catch** — it must never
fail the save/submit that triggered it (also why a missing CHECK type is silent).

## What looks like a bug but isn't

- **Lock right after Mark Ready inserts nothing** — amounts didn't change.
- **Reopen → re-ready re-notifies only the corrected people** — everyone else's
  amount matched their last notification.
- **A whole-row DELETE on a published week doesn't notify by itself**
  (`hsl-bonus/entries` DELETE, Bonus History dept-week DELETE are unhooked); the
  save that follows does. A delete-with-no-resave is a known quiet path.
- **Toast latency up to ~30s**: `postgres_changes` never delivers to the anon
  browser client on RLS-guarded tables, so the chime's 30s poll is the real
  transport; the KPI Results tab polls on the same 30s beat (visible tab only).
- **Off-roster scorees are counted `skipped`, not notified** — a bonus row whose
  email resolves to no `active_employees` login has nowhere to land (same rule as
  `payroll-available.ts`; a transiently missing person — master-list sync race —
  misses the notification).

## Employee dashboard now has ears

`EmployeeApp` mounts `useNotificationChime(employeeEmail, { view: 'employee' })` —
the first employee-view chime (previously only HR + Accounting announced). This
toasts **every** employee-view type (Salary Ready, Paid, KPI scored…), per Kane's
Q1 = (a). It keys on the VIEWED identity (matching the unread badge), not the
session, so elevated `?email=` viewing hears that panel's slice.

## Why the employee's KPI Bonus card is missing (it is not unshipped code)

Asked and answered 2026-08-17 — the card was suspected of living in an uncommitted
branch. It does not: it is on `main` at
[`EmployeeDashboard.tsx:3097`](../../src/components/employee/EmployeeDashboard.tsx#L3097)
and **hides at runtime**, gated on `kpiBonusAmount > 0`. That value
([`:1935`](../../src/components/employee/EmployeeDashboard.tsx#L1935)) is zero unless one
of these holds:

1. a **published wizard snapshot** for the week carries `otherBonuses` (that arm wins
   outright, and on that path the KPI is already inside `final` — never added twice), or
2. the employee has rates, a week is selected (**"All Time" is always ₱0** — there is no
   week to key on), and a `kpiPeriods` entry matches that week's `period_start`.

`kpiPeriods` only ever contains **ready/locked** weeks — the same visibility gate this
notification rides (§ Drafts are structurally silent). So a week that was **scored but
never submitted** produces a correct ₱0 and a correctly absent card. That is a workflow
gap, not a code gap: memory `hsl-bonus-weeks-never-submitted` records ≈₱846k scored with
no status row. The fix is a manager pressing Mark Ready / Lock, not a deploy.

Diagnostic order, so nobody goes git-hunting again: check the selected week isn't
All Time → check `hsl_bonus_period_status` for that dept-week is `ready`/`locked` →
check the person has rates. Only then look at code.

## Deploy notes

- **PENDING** — run `node scripts/apply-kpi-scored-notification-type.mjs` (needs
  `DATABASE_URL`, direct port 5432). Until it runs, every insert is silently
  swallowed by the try/catch — the standard type-CHECK footgun. Verify with
  `--verify`. Probe first per the migration-folklore rule if in doubt. The script
  ABORTS if the live CHECK carries a type the SQL's restated list lacks.
- No n8n changes. No env vars.
