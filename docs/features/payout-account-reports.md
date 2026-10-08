# Employee-reported account status — "this account is closed / deactivated / frozen"

An employee can tell Accounting that one of their own payout accounts stopped working: **closed**,
**deactivated / dormant**, **frozen / on hold**, or **other** (with a note). They do it from
Profile → Compensation → Payout or from the public `/update-bank-info` link. Accounting sees it on
the in-app alert, in People → Banking (both the popup and the Search Bar) and **in the Mark Paid
dialog before a payment goes out**. Built 2026-10-08 (session `9e18d69e`, Open item 406) on Kane's
*"Lets also add in a mechanism for the Employees to mark these Bank Accounts as closed, deactivated
or frozen some stuff like that so Accounting would know"*.

It sits beside payout change safety ([update-bank-info.md](update-bank-info.md) § *Payout change
safety*, item 401): that one warns before a change; this one records that an account on file has
died.

## Key files

| Piece | File |
| --- | --- |
| Table (RLS on, no policies) | `references/sql/create/2026-10-08_payout_account_reports.sql` |
| Apply + verify (dry by default, CHECK controls) | `scripts/apply-payout-account-reports-migration.mts` |
| Statuses, reportable accounts, note rules, the view, the payload parser (pure) | `src/lib/banking/payout-account-reports.ts` (+ `.test.ts`, 13 tests) |
| Data layer: HMAC fingerprint, paged reads, file / withdraw, Accounting alert | `src/lib/supabase/payout-account-reports.ts` |
| Public route (session token) | `app/api/bank-update/report-account/route.ts` |
| Dashboard route (self only) | `app/api/employee/payout-account-reports/route.ts` |
| Staff read (also returns the paid account's `payoutTrack`, for People → Banking) | `app/api/payout-account-reports/route.ts` |
| The view on the existing reads | `app/api/bank-update/verify-otp/route.ts` (`account_reports`) · `app/api/employee-ids/route.ts` (`&track=1` → `accountReports`) |
| UI: employee panel + dialog, staff status (`StaffPayoutAccountStatus`) | `src/components/banking/payout-account-report.tsx` |
| Hosts | `EmployeeProfile.tsx` (Payout read view) · `app/update-bank-info/page.tsx` (edit step) · `MarkPaidDialog.tsx` · `PeopleTab.tsx` (Banking) · `PeopleBankSearch.tsx` |

## A report INFORMS. It never moves money

Nothing in the routes or the data layer writes `employee_ids` or touches routing, and a source-scan
test with a negative control pins that (`payout-account-reports.test.ts`, last test). The payout
destination changes only through the edit form (employee-profile.md §6.2). A payment to a reported
account is **not** held or switched to the backup: the Mark Paid banner tells the clerk, and the
clerk decides (Problem, Not paid, or the pencil override, as before). Kane's ask was *"so
Accounting would know"*. An automatic hold would be a money rule, and nobody has made it.

**Reporting the PAID account does not make the person "missing bank info".** `isPayoutComplete` is
untouched, because it is held at parity with what Payment Dispatch pays (people-tab-bank-drift-audit).
Instead the employee's panel says *"Payroll still pays the account you reported. Add your new
account"*, with a button into the edit form.

## A report follows the ACCOUNT, not the slot

The row stores `account_fingerprint = HMAC-SHA256(NEXTAUTH_SECRET, "account:<digits>" |
"wallet:<email>")` and a masked `account_hint`, **never the number** (update-bank-info.md rule 22;
the CHECK only admits 64 hex characters, so a raw number cannot land there). Every read rebuilds
the person's CURRENT accounts and matches by fingerprint:

- the account moved to the other slot → the report moves with it (`reportedKind` keeps where it was);
- the account was replaced → the report applies to nothing and is listed as **"no longer on your
  record"**. It is never attached to the new account, and Accounting's banner leaves it out.

So no one has to "resolve" a report when an employee fixes their details. The employee can also
withdraw one ("It works again"). There is **no Accounting resolve button** in v1.

**No constant key.** When `NEXTAUTH_SECRET` is absent, every read is `unavailable` and every write
refuses (503). The OTP pepper falls back to a constant (update-bank-info.md § Security notes); this
must not, because a fingerprint under a known key is a brute-forceable account number.

## Which accounts can be reported

`reportableAccounts(row, rail)`: each bank slot holding an account number (the alternative dropped
when it is the same account), plus the wallet payroll pays when the rail is a wallet. `paysHere`
comes from `payoutDestinationKey`, the same rule the payout safety check and Mark Paid use. The
rail is the EFFECTIVE one (all three tiers, `resolveWalletRailLock`). A wallet that payroll does
not pay is not listed.

**Only the employee files.** The dashboard route answers 403 when the session is not the subject,
although `authorizeEmailAccess` lets staff read anyone. A report is the employee's statement about
their own account. The public route takes identity from the session token only, never the body.

**One open report per account** (a partial unique index). Reporting the same account again
withdraws the old one as `superseded`, so the history is kept. Withdraw is owner-checked: the
report must belong to one of the caller's own addresses.

## Not gated on the payroll lock

Both write routes accept a report while `payroll.dispatch_locked` is on. A report writes no payout
field, and mid-dispatch is exactly when Accounting needs to hear that an account is dead. This is a
deliberate difference from the save (update-bank-info.md rule 19), not an oversight. The employee
panel stays usable while Payout is read-only, but its *Add new account* button is hidden while
locked.

## The note

Free text, at most 500 characters, control characters out. **Any run of 6+ digits is cut to its
last 4** (`normalizeReportNote`), because a note is shown to Accounting and kept forever, and an
employee will type their new account number into it. *Other* requires a note (route and CHECK).

## Failed reads are never "nothing reported"

A failed read, a missing table or a missing key is `{ status: 'unavailable' }`. The employee panel
says reporting isn't available right now; the staff banner says *"Couldn't check whether the
employee reported an account closed or frozen"*. Absent (an older server) renders nothing. Same
rule as the track record (update-bank-info.md rule 27).

While the PAID account carries an open report, the track line (*"Paid successfully N times … no
problems on record"*) and the change notice's *"your current account has been paid N times"* are
**not shown**. A reported account is not one to call problem-free.

## Who hears about it

- **In-app alert** to live `admin` / `accounting` / `ceo` role holders, type
  `people.banking.self_updated` (`neutral`), the type the bank saves already use. A new type would
  be rejected by the CHECK until an ALTER ran (notification-alerts.md). Title *"Bank account reported
  CLOSED"* (or DEACTIVATED / FROZEN / PROBLEM), or *"Bank account report withdrawn"*. A failed
  insert is written to `audit_log` as `notification.insert_failed` (`recordNotifyFailure`) and never
  fails the report.
- **Mark Paid**: a rose banner above *Recipient*, naming the account, the date, whether payroll pays
  it, and the note. It pre-fills and changes nothing.
- **People → View → Banking** and **People → Search Bar**: the same banner, shown whether or not the
  record is revealed (it carries masked hints only), under the paid account's track record
  (`showTrack`, people-bank-card.md §10). The track line is hidden while the PAID account is
  reported. Mark Paid shows the banner only.
- **Audit**: `bank_update.account_reported` / `bank_update.account_report_withdrawn` (the registered
  `bank_update.` family).

**Not in v1:** Payroll Readiness, People → Bank changes feed, the payroll-team email. Each is a
follow-up, not a refusal.

## Deploy notes

- **PENDING (Open item 406): the table.** Kane runs
  `node --import tsx scripts/apply-payout-account-reports-migration.mts --apply`. Dry run 2026-10-08:
  14 object checks and 12 controls pass (RLS on, 0 policies, one-open index, every CHECK bites), all
  rolled back. Until it runs, every read is `unavailable` and Report is refused with 503. Nothing else
  breaks.
- `NEXTAUTH_SECRET` must be set (it already is wherever sign-in works).
- No new notification type, no n8n import, no env var.
