# PAB exclusion: notify the employee in the Employee Dashboard

**Date:** 2026-08-03
**Status:** Approved

## Problem

The Payroll Wizard's PAB settings modal lets Accounting explicitly exclude a
person from a given month's Perfect Attendance Bonus (`togglePabExclusion` in
[PayrollWizard.tsx](../../../src/components/PayrollWizard.tsx) — a per-month
"Exclude from PAB" checkbox list). An excluded employee earns ₱0 PAB for that
month regardless of attendance, but they currently have **no way to know it
happened** — nothing lands in their Employee Dashboard. The ₱0 (or absence of
the bonus) just shows up on payday with no explanation.

## Decisions (user-confirmed)

1. **Notify both directions** — exclude AND restore (un-exclude) each fire
   their own notification, mirroring the existing `dispute.approved` /
   `dispute.denied` / `dispute.revoked` pattern.
2. **Notification card only** — no persistent "Excluded" badge on the
   dashboard's PAB calendar/pill for this feature. (That's a separately known,
   pre-existing gap — not addressed here.)
3. **Architecture:** a new dedicated API route owns the write + the
   notification together, replacing the client's current direct write to the
   generic `pab_period_exclusions` app-setting. This matches how every
   comparable action in this codebase works (dispute decisions, bank-preferred
   requests, resignation decisions) — a domain route, not a generic
   key/value POST, is what fires notifications reliably and keeps the
   "did this actually change?" check in one place.

## Approach

### New API route — `POST /api/pab-exclusions`

**Body:** `{ email: string, monthKey: string /* "YYYY-MM" */, excluded: boolean }`

**Gate:** `requireElevatedSession` — the same gate that currently protects the
generic `POST /api/app-settings` write this route replaces.

**Behavior:**

1. Validate `monthKey` (`^\d{4}-\d{2}$`) and a non-empty `email`.
2. Read the current `pab_period_exclusions` blob fresh via
   `getAppSettingStrict` + `parsePabPeriodExclusions` (not the client's cached
   copy — closes a latent staleness/race window the client-side
   read-modify-write had).
3. Normalize the email (`normEmail`), compute `wasExcluded` = whether that
   month's set already contains it.
4. If `wasExcluded === excluded` (no-op toggle, e.g. a double-click race):
   skip the notification, but still perform the write below (idempotent).
5. Patch just `monthKey`'s set (add or remove the email), re-serialize the
   **full** map preserving every other month untouched — same shape
   `writeExclusionsBlob` produces today — and `upsertAppSetting`.
6. Resolve the notification recipient: query `active_employees` (service-role
   client, bypasses RLS) for a row whose Work / Personal / Alternate Work /
   Alternate Work Email 2 matches the normalized email (case-insensitive),
   and notify its canonical **Work Email** (falling back to Personal Email).
   This mirrors `notifyPayrollAvailable`'s alias-resolution reasoning — the
   wizard's roster email is Hubstaff-sourced and can differ from the login
   email — but as a single targeted lookup, not a full-roster reverse map,
   since this fires per single toggle rather than per CSV upload.
   - No match found → skip the notification entirely (log a warning), don't
     write a dead row nobody will ever see.
7. Insert the notification (skipped if step 4 found no state change or step 6
   found no recipient):
   - Excluded: `type: 'pab.excluded'`, `tone: 'neutral'`, title "Excluded from
     Perfect Attendance Bonus", message: `You've been excluded from the
     Perfect Attendance Bonus for {Month Year}. You'll earn ₱0 PAB for this
     period regardless of attendance. Reach out to Accounting if this
     doesn't look right.`
   - Restored: `type: 'pab.restored'`, `tone: 'positive'`, title "Perfect
     Attendance Bonus Restored", message: `Your Perfect Attendance Bonus
     exclusion for {Month Year} has been reversed. You're eligible again
     based on your attendance for the period.`
   - `details: { month: monthKey, month_label }`.
   - Insert failure is best-effort (logged, doesn't fail the request) — same
     footgun as every other notify-on-insert call until its type migration
     runs.
8. Return `{ success: true, notified: boolean, error: null }`.

### Client change — `PayrollWizard.tsx`

`togglePabExclusion` calls `POST /api/pab-exclusions` with
`{ email: norm, monthKey: editMonthKey, excluded }` instead of
`writeExclusionsBlob` + `savePabSetting(PAB_PERIOD_EXCLUSIONS_KEY, ...)`, then
still calls `pabPeriodSettings.refresh()` on success exactly as it does today.
`writeExclusionsBlob` is deleted — `togglePabExclusion` was its only caller.
The `isReplay` guard already in `togglePabExclusion` is untouched (replay mode
never reaches the new route).

### Notification wiring

Both new types go in `NOTIFICATION_TYPE_TO_VIEWS`
([notification-views.ts](../../../src/lib/notifications/notification-views.ts)) as
`['employee']`, ungated (no feature-permission gate — same as `dispute.*` and
`payroll.available`). No entry added to `notification-actions.ts`: these are
informational cards with no click-through target, matching most of the panel's
existing non-stub, non-ticket cards. `NotificationsPanel.tsx` needs no changes
— its rendering is generic (title/message/tone-color) unless a type opts into
special-case UI, which these don't.

### Migration

`employee_notifications.type` has a CHECK constraint. New file
`references/sql/alter/2026-08-03_pab_exclusion_notification_types.sql`
restates the full allowed list (copied from the latest migration,
`add_payroll_available_notification_type.sql`) plus `pab.excluded` and
`pab.restored`. Paired with `scripts/apply-pab-exclusion-notification-types.mjs`
— same shape as `scripts/apply-fix-security-definer-views.mjs` (direct `pg`
client via `DATABASE_URL`, since Supabase's JS client can't run DDL): applies
the ALTER, then verifies by reading `pg_constraint`'s definition for
`employee_notifications_type_check` and confirming both new values are
present. Until this runs, both notification inserts fail silently
(best-effort try/catch) — the exclude/restore toggle itself still saves.

## Error handling

- Missing/invalid `monthKey` or `email` → 400.
- Not elevated → 401/403 via `deniedResponse`.
- `getAppSettingStrict` / `upsertAppSetting` failure → 500, surfaced as the
  existing `pabSaveState = 'error'` + toast in the client (unchanged UI
  behavior, just a different endpoint).
- Notification insert failure → logged only, never fails the response (the
  exclusion state change is the thing that must not be lost).

## Testing

- Route-level checks: excluding a not-previously-excluded email flips the
  blob and inserts `pab.excluded`; excluding an already-excluded email is a
  no-op notification-wise; un-excluding inserts `pab.restored`; an email with
  no `active_employees` match writes the blob but sends no notification.
- Manual: toggle a person on/off in the PAB settings modal, confirm the
  Employee Dashboard notification panel shows the card once the SQL migration
  has been applied.

## Out of scope

- Any persistent "Excluded" badge on the Employee Dashboard's PAB
  calendar/pill (explicitly deferred per the decision above).
- A reason/note field on the exclusion toggle (none exists in the current UI;
  not requested).
- Changing how `current-pay.ts` / `member-monthly-pay.ts` apply the exclusion
  to actual pay (unchanged — this is notification-only).
