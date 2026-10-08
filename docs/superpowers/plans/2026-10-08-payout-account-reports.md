# Employee-reported bank account status — implementation plan

> Kane, 2026-10-08: *"Lets also add in a mechanism for the Employees to mark these Bank Accounts as
> closed, deactivated or frozen some stuff like that so Accounting would know"*. Brief posted in
> session `9e18d69e` (blueprint). No `NEEDS`. Builds on payout change safety (item 401).

**Goal:** an employee can say "this account of mine is closed / deactivated / frozen", from Profile →
Payout and the public `/update-bank-info` link, and Accounting sees it before paying into it. It
informs and never re-routes pay.

**Architecture:** one new table (`payout_account_reports`, RLS on, no policies) holding an HMAC
fingerprint + masked hint of the reported account, never the number. A pure module decides which of
the person's current accounts a report still names. Three routes (public, dashboard, staff read)
and one shared component file.

## Tasks

- [x] **1. SQL + apply script.** `references/sql/create/2026-10-08_payout_account_reports.sql`,
      `scripts/apply-payout-account-reports-migration.mts` (dry by default; CHECK controls). Dry run.
- [x] **2. Pure module + tests.** `src/lib/banking/payout-account-reports.ts`: statuses + labels,
      `reportableAccounts(row, rail)`, `normalizeReportNote`, `validateReportInput`,
      `buildReportsView(accounts, reports, fingerprintOf)`. Tests: slot/wallet resolution, paid flag,
      matching by value across slots, stale report, note rules, no digits beyond the last 4.
- [x] **3. Server layer.** `src/lib/supabase/payout-account-reports.ts`: HMAC (NEXTAUTH_SECRET,
      refuse when absent), paged reads, `fileAccountReport` (supersedes an open one on the same
      account), `withdrawAccountReport` (owner-checked), `notifyAccountingOfReport` (existing type,
      `recordNotifyFailure` on error), `readAccountReportsView`.
- [x] **4. Routes.** `POST /api/bank-update/report-account` (session token) ·
      `POST /api/employee/payout-account-reports` (authorizeEmailAccess, self only) ·
      `GET /api/payout-account-reports?email=` (requireRateVisibilityOrFeatureEdit accounting/payment_dispatch).
      verify-otp and `/api/employee-ids?…&track=1` carry the view. Audit actions
      `bank_update.account_reported` / `bank_update.account_report_withdrawn`.
- [x] **5. UI.** `src/components/banking/payout-account-report.tsx`: `AccountReportsPanel`
      (employee), `ReportAccountDialog`, `PayoutAccountReportsBanner` (staff, self-fetching; renamed `StaffPayoutAccountStatus` the same day when it took the People track line). Mount in
      EmployeeProfile (read view), the public page (edit step), MarkPaidDialog, PeopleTab Banking,
      PeopleBankSearch. `PayoutTrackLine` never claims "no problems" on a reported account.
- [x] **6. Verify.** tsc, the full suite, a server-render smoke test.
- [x] **7. Docs.** `docs/features/payout-account-reports.md`, INDEX + README rows, api-reference,
      components, update-bank-info.md / employee-profile.md / payment-dispatch.md pointers, memory,
      Open items. One commit, explicit paths.
