# MESA — suspend a member's weekly contribution without opting them out

**Brief:** in-session 2026-10-06. Kane: *"Accounting - MESA - Lets add a suspend button with an
efffectivity date picker that would suspend the mesa contribution without having to opt-out to remove
the -100"*. Built under the 2026-09-26 blueprint rule: recommendations taken (CHOSEN 1–8), no NEEDS.

**What was found first:** the ₱100 deduction and the ₱100 + ₱300 deposit are decided by ONE predicate,
`mesaContributesForWeek(since, weekEnd)` (`src/lib/mesa/deposit-date.ts`), imported by the Wizard's
final-pay compute, its display recompute (`mesaChargedThisWeek`), `current-pay.ts`,
`member-monthly-pay.ts` and the ledger writer. The only way to stop the ₱100 today is Opt Out, which
closes the account and releases the balance as an `offboard_payout`.

## Task 1 — the table

- [x] `references/sql/create/2026-10-06_mesa_suspensions.sql` — `mesa_suspensions` (account FK,
  `suspended_from`, `resumed_on`, reason ≤ 250, by/at pairs), resume-after-start CHECK, one open
  window per account (partial unique index), RLS on + revoke from anon/authenticated.
- [x] `scripts/apply-mesa-suspensions-migration.mts` — dry run (rolled back) by default, `--apply`,
  `--verify`; positive + negative controls inside savepoints.

## Task 2 — the gate

- [x] `src/lib/mesa/deposit-date.ts` — `mesaContributesForWeek(since, weekEnd, suspensions)`, the
  third argument REQUIRED; `mesaSuspendedOn(windows, depositDate)`.
- [x] `src/lib/mesa/deposit-date.test.ts` — existing cases pass `[]`; suspension cases (Friday rule,
  resume, zero-length cancel, open-ended, the writer/deduction invariant).

## Task 3 — the pure rules

- [x] `src/lib/mesa/suspension.ts` — index by email + account, `checkSuspend`, `checkResume`,
  `checkSuspensionReason`, `firstAffectedWeek`, `suspensionStatusOn`.
- [x] `src/lib/mesa/suspension.test.ts`.

## Task 4 — server data

- [x] `src/lib/supabase/mesa-suspensions.ts` — paged list for open accounts (missing table =
  `available: false`; any other error reported, never "none"), insert, CAS resume.

## Task 5 — routes

- [x] `app/api/mesa-suspensions/route.ts` — GET (elevated) · POST suspend (`mesa` edit).
- [x] `app/api/mesa-suspensions/[id]/route.ts` — PATCH resume (`mesa` edit).
- [x] Audit `employee.mesa.suspend` / `employee.mesa.resume`; registry note updated.

## Task 6 — every ₱100/₱400 site

- [x] `record-weekly-contributions.ts` (throws on a failed read — no deposit for anyone that run).
- [x] `current-pay.ts` · `member-monthly-pay.ts` (throw on a failed read).
- [x] `PayrollWizard.tsx` — suspensions fetched with the opt-out set, same loader state; both gate sites.

## Task 7 — UI

- [x] `AccountingMesa.tsx` Active Members — Suspend (row + bulk), Resume (row), Suspended/Scheduled
  badge, suspension banner states, export "Payroll deducting" reads the suspension.

## Task 8 — verify + document

- [x] `npm test` · `tsc --noEmit` (no `next build` while a dev server holds `.next/`).
- [x] `docs/features/mesa-suspension.md`, INDEX row, `mesa.md` pointer, data-sources entry, memory,
  Open items row.
