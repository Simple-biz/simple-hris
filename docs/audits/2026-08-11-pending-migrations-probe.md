# Pending-migration probe — 2026-08-11

Ran `node --import tsx scripts/audit-pending-migrations.mts` (read-only) against production.

**Result: 21 APPLIED · 1 NOT APPLIED · 3 INCONCLUSIVE.** Nearly every "PENDING" claim in `docs/` and
the memory directory is **stale**. Do not trust those claims again — re-run the probe.

## Still not applied

| Migration | Evidence |
| --- | --- |
| `references/sql/alter/2026-08-03_restore_active_employees_definer.sql` | anon key sees **0** rows in `active_employees`, service-role sees **1303** — the view is still `security_invoker`. Every non-service-role caller gets an empty set. |

## Cannot be settled read-only

A CHECK-constraint's allowed values are not readable through PostgREST. The only read-only evidence
is whether a row already uses the value; absence proves nothing.

- `people.banking.overridden` (Mark-Paid bank override notification)
- `pab.excluded` / `pab.restored` (PAB exclusion notification)

`bank_preferred.decided` (1 row), `payroll.paid` (2412), `payroll.available` (2705) are **confirmed
applied** by the same method.

## Confirmed applied — stop calling these pending

`payroll_bank_exemptions` (3 rows) · `employee_calltools_usernames` · `hr_onboarding_submissions`
`.calltools_username` `.calltools_nickname` `.ip_agreement_agreed` `.ip_assignment_file_path`
`.invite_country` `.gmail_surname` `.first_name` `.last_name` · `mesa_accounts` (307 rows) ·
`employee_hourly_rates.mesa_account_number` · `onboarding_pay_plans` (5 rows) ·
`paystub_dispatch_queue` (9815 rows) · `urgent_payment_requests` · `mesa_notes` ·
`mesa_request_receipts` · the MESA `opt_in` cleanup (zero legacy rows remain).

## Docs and memory carrying claims now disproved

These say PENDING and are wrong. Each needs correcting, and the `Deploy notes` section is the usual
place the false claim lives:

- `docs/features/bank-preferred-routing.md:299` (`bank_preferred.decided` — applied)
- `docs/features/payroll-readiness.md:197-199` (bank exemptions — applied)
- `docs/features/onboarding-calltools-username.md:3-5, :258-260, :296` (applied)
- `docs/features/onboarding-ip-assignment.md:3-4, :245-250, :272` (applied; the path it cites is also
  stale — the file moved to `references/sql/alter/`)
- `docs/features/onboarding-pay-plans.md:3-4, :146-153, :168-169` (applied)
- `docs/features/onboarding-gmail-surname.md:3-4, :144-148, :168` (applied)
- `docs/features/mesa.md:3, :239` and `docs/features/paystub-dispatch.md:46, :194-195, :668` (applied)
- memory: `bank-preferred-approval-gate`, `bank-info-temporary-exemption`, `calltools-roster-backfill`,
  `mesa-accounts-per-stint`, `mesa-optin-requests-derived`, `people-pay-oneoff-urgent`,
  `employee-paystub-modal-and-paid-notification`, `onboarding-name-split`

## Consequence for the Monday board

**No board row changes.** The five Backlog rows from the 2026-08-11 pass were never blocked by a
schema migration — they are blocked by an n8n import, a seed re-run, a wizard cycle re-lock, and
missing `hsl:*` rate data. Verified against the pass; all five stay Pending Deploy.

One board row **is** now stale: `[HRIS] Run outstanding Supabase migrations + re-import n8n workflows
(12+ pending SQL files)` (HRIS-15, 3 SP, Critical, Sprint 25, still open). The migration half is done;
only the `active_employees` definer fix and the n8n imports remain. It should be re-scoped or closed.

## Root cause

The repo has **no migration runner and no applied-ledger**, so "has this run?" has no answer in the
codebase and drifts into folklore. `scripts/audit-pending-migrations.mts` is the stopgap — run it
before ever reporting a migration as pending. A real ledger would remove the guesswork.
