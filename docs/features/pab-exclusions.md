# PAB exclusions — zeroing one person's Perfect Attendance Bonus for a month

An exclusion sets a single person's Perfect Attendance Bonus to **₱0 for a whole
month**, regardless of their actual attendance. It is toggled from the Payroll
Wizard and stored as one JSON app-setting, not a table.

This doc exists because there wasn't one. The surface shipped 2026-08-03 with a
design spec and a plan, and neither mentioned auditing — so for its entire life
the action that zeroes someone's bonus recorded **nothing about who did it**.
Written 2026-08-20 alongside the fix.

## Key files

| Piece | File |
| --- | --- |
| Route — owns the write, the notification AND the audit row | `app/api/pab-exclusions/route.ts` |
| Pure patch + notification copy | `src/lib/notifications/pab-exclusion.ts` (+ `.test.ts`) |
| Setting parse / key | `src/lib/pab-period-settings.ts` (`PAB_PERIOD_EXCLUSIONS_KEY`) |
| Notify-failure observability | `src/lib/notifications/notify-failure-audit.ts` |

## The storage shape, and why the count surprises people

`app_settings.pab_period_exclusions` holds a **JSON string** — an object keyed by
`YYYY-MM`, each value an array of emails:

```json
{ "2026-06": ["iked@simple.biz", "..."], "2026-07": ["..."] }
```

Measured 2026-08-20: **2 month keys, 107 person-month entries.** It is a string
column, so a probe that does `Array.isArray(value)` gets `0` and concludes the
setting is empty — `JSON.parse` first. That mistake was made once already while
auditing this surface.

## Every change is audited — `pab_exclusion.added` / `pab_exclusion.removed`

**The gap this closes.** `audit_log` held ~41,000 rows and recorded PAB *disputes*
in full detail (`pab_dispute.approved`, `pab_dispute.orphanage_manager_created`),
yet **zero rows matched any exclusion change**. So merely *approving* a dispute was
fully logged, while *zeroing the bonus outright* left no trace of who or when. The
107 entries above have no recoverable author.

Rules:

- Actor comes from `getSessionActor()` — the same helper `hsl-bonus/period-status`
  already uses, so the actor shape matches every other payroll audit row.
- `resource` is `PAB_PERIOD_EXCLUSIONS_KEY`; `details` carries `employee`, `month`,
  `excluded`, `was_excluded` and `notified`.
- **Written only when `changed` is true.** Re-posting the same state is not an
  event, and logging it would bury the real changes.
- The action names deliberately mirror `pab_dispute.*` so the existing audit
  readers and the Admin Penny action-family search pick them up with no new code.

**A backfill is not possible.** The 107 pre-existing entries carry no author, no
timestamp and no order — nothing to reconstruct from. The trail starts from
2026-08-20 forward, and that limit is stated here rather than left to be
discovered.

## The notification is best-effort, and now observable

A change notifies the affected employee: `pab.excluded` ("You'll earn ₱0 PAB for
this period…") or `pab.restored`. Copy lives in the pure
`buildPabExclusionNotification`.

Delivery is **best-effort by design** — a failed notification must never fail the
exclusion write, which has already been persisted by that point. But until
2026-08-20 a failure went to `console.error` and nowhere else, and that is how
`pab.excluded` / `pab.restored` were **dead for 17 days**: the notification type was
missing from `employee_notifications_type_check`, every insert was rejected, and
**0 rows** existed for either type. Nothing surfaced.

Failures now go through `recordNotifyFailure` → an `audit_log` row with action
`notification.insert_failed`, flagged `likely_type_check_rejection` when the message
looks like a CHECK violation. Still non-fatal. **Do not "fix" a future failure here
by making the notify fatal** — that would let a notification outage block payroll
work. Make it visible, never blocking.

Two silent paths that are deliberate, not bugs:

- An email failing `isSafeEmail` is skipped (it would break the PostgREST `or()`
  filter). Logged, not notified.
- An email matching no `active_employees` row has nowhere to deliver — same rule as
  `payroll-available.ts`.

## Deploy notes

**No migration.** The `pab.excluded` / `pab.restored` types were added to
`employee_notifications_type_check` on 2026-08-20 (verified: both present, along
with `kpi.scored`). No DDL, no env var, no n8n import.

Cross-links: `docs/features/kpi-scored-notification.md` (same best-effort +
observability pattern) · `docs/features/orphanage-pab-coverage.md` (PAB
forgiveness) · memory `pab-calendar-parity`.
