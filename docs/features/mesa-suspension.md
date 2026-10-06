# MESA contribution suspension — stop the ₱100 without opting out

Accounting → MESA → **Active Members** can **Suspend** a member's weekly MESA contribution from an
effective date and later **Resume** it from another. While suspended, pay weeks whose Friday deposit
date falls inside the suspension are **neither charged the ₱100 deduction nor deposited the ₱100 +
₱300**. The member stays enrolled: same account, same account number, balance untouched, nothing
released or paid out. Kane, 2026-10-06: *"Accounting - MESA - Lets add a suspend button with an
efffectivity date picker that would suspend the mesa contribution without having to opt-out to remove
the -100"*. Built 2026-10-06 (session `d1583b1c`, blueprint, no NEEDS); the migration is **PENDING**
(see Deploy notes). Parent doc: [mesa.md](mesa.md).

## Key files

| Piece | File |
| --- | --- |
| The week gate (THE rule) | `src/lib/mesa/deposit-date.ts` — `mesaContributesForWeek(since, weekEnd, suspensions)`, `mesaSuspendedOn`, `MesaSuspensionWindow`, `NO_MESA_SUSPENSIONS` (`deposit-date.test.ts`) |
| Suspend / resume rules, lookup, badge status, first affected week | `src/lib/mesa/suspension.ts` (`suspension.test.ts`) — browser-safe, imported by the dialogs AND the routes |
| Server reads / writes | `src/lib/supabase/mesa-suspensions.ts` |
| Routes | `app/api/mesa-suspensions/route.ts` (GET list · POST suspend) · `app/api/mesa-suspensions/[id]/route.ts` (PATCH resume) |
| Table | `references/sql/create/2026-10-06_mesa_suspensions.sql` · applied by `scripts/apply-mesa-suspensions-migration.mts` |
| UI | `src/components/payroll/AccountingMesa.tsx` — `MesaActiveMembers`, `MesaSuspendDialog`, `MesaResumeDialog`, `MesaSuspensionBadge` |
| Charge sites | `src/components/PayrollWizard.tsx` (final-pay compute + `mesaChargedThisWeek`) · `src/lib/payroll/current-pay.ts` · `src/lib/payroll/member-monthly-pay.ts` · `src/lib/mesa/record-weekly-contributions.ts` |

## Which weeks a suspension skips — judged at the FRIDAY

A pay week is suspended when its **Friday deposit date** `d` (`mesaDepositDateFor(weekEnd)`) satisfies
`suspended_from <= d < resumed_on` (`resumed_on` NULL = still suspended). This is Kane's 2026-09-15
ruling — *"Friday should be the deposit dates"* ([mesa.md](mesa.md) § Opt-in effective date) — applied to
both ends, exactly as it already decides an enrollment's first week:

- Suspend effective **Monday–Friday** → that week is skipped. Effective **Saturday or Sunday** → the
  **following** week is the first skipped (that week's Friday is already past).
- Resume effective on a Friday or earlier in the week → that week is charged again. The window is
  half-open, so `resumed_on` is the first day contributing again, like an enrollment date.
- **Resume ON the start date = cancelled.** The window is empty and no week is ever skipped. That is how
  a mistaken suspension is undone; no suspension is ever deleted.
- Windows union. Two windows can never claim the same week by the route's rules, and if they did the
  week would simply be suspended.

The dialogs print the first affected Sun–Sat week (`firstAffectedWeek`), so nobody has to work this out.

## One gate, every charge site — and the argument is REQUIRED

The ₱100 and the ₱400 are decided by **one** predicate, `mesaContributesForWeek`, at every site that
charges or deposits: the Wizard's final-pay compute, its display recompute (`mesaChargedThisWeek`), the
employee live estimate / Payment Dispatch fallback (`current-pay.ts`), the monthly estimate
(`member-monthly-pay.ts`) and the weekly deposit writer. **The suspensions argument is required, not
optional**, so a new ₱100 site cannot compile while ignoring a suspension — it must pass the member's
windows or `NO_MESA_SUSPENSIONS` and own that choice. Do not make it optional to quiet a caller.

**The ₱300 match stops too.** The match is three times the contribution; a week with no ₱100 has nothing
to match, and a deposit with no deduction is money the fund never collected — the exact `dales@` defect
in [mesa.md](mesa.md) § The opposite drift. If a future ruling wants the match kept during a suspension,
that is a change to this one predicate and to the writer, never to the Wizard alone.

## A member's windows — matched on addresses AND account number

`mesaSuspensionsFor(index, { emails, accountNumber })` returns every window matching **any** of the
member's addresses (roster email, the account's email, and each one's MESA aliases from
`src/data/mesa-email-aliases.json`) **or** the rate row's `mesa_account_number`. The union is deliberate:
a rate row can lack the account number, and a member's MESA identity can be an earlier address
(`dale@` / `dales@`). Matching on only one of them is how a suspension silently misses its member.

## Keyed to the ACCOUNT — opting out makes it inert

A suspension row references `mesa_accounts(account_number)`. Readers only consult windows on an
**open** account (`listMesaSuspensionsForOpenAccounts`). So:

- **Opt Out** closes the account; its windows go inert with it. The opt-out releases the balance exactly
  as before ([mesa.md](mesa.md), `releaseMesaBalanceOnClose`) — suspension does not touch that path.
- A **re-join** opens a new account number with no suspension. Nothing carries over.
- Resume on a closed account is refused **409**.

## A suspended member is still a member

They stay on **Active Members** (and HR's MESA Eligible), keep their account number and balance, can
file disbursement / return / opt-out requests, and appear on no Non Members list. The badge beside the
name reads **Suspended** (in effect today), **Suspended · resumes <date>**, or **Suspends <date>**
(starts later), with the reason and who set it on hover. The export's **Payroll deducting** column
reads `NO - suspended from <date>` for a suspension in effect today.

`membership-drift.ts` is unchanged on purpose: it compares the FLAG with the LEDGER, and a suspended
member's flag is still `true`. A suspension is not drift.

## Not floored at today — and never retroactive past a snapshot

The effective date may be in the past, like Opt In and the opt-out date ([mesa.md](mesa.md):103,105):
Accounting back-dates corrections. But **payroll rule changes are forward-only** (memory
`payroll-rule-changes-forward-only`): a week already staged, snapshotted (`final_pay`), dispatched or
deposited keeps its ₱100 and its ₱400. Nothing is refunded, recomputed or deleted. The Suspend dialog
says so when the date is in the past. The live, unlocked cycle recomputes — that is what a back-dated
suspension is for. The re-lock trap in [paystub-dispatch.md](paystub-dispatch.md) still applies to the
live cycle, suspension or not.

The suspend date may not be **before the account opened** (400) nor inside a window that already ended
(409); a second open window on one account is refused by the route (409) **and** by the partial unique
index `mesa_suspensions_one_open_per_account`. A resume may not precede its start (400; the CHECK
`mesa_suspensions_resume_after_start_chk` refuses it too) and an already-resumed window is refused (409,
and the update is a compare-and-set on `resumed_on IS NULL`).

## A failed read is never "nobody is suspended"

| Reader | Table missing (migration pending) | Any other read failure |
| --- | --- | --- |
| `GET /api/mesa-suspensions` | `{ available: false, suspensions: [] }` | **500** — never an empty list |
| Ledger writer | no suspensions (nobody can be suspended) | **throws** — no deposit for anyone that run; idempotent per member-week, a re-sync fills it in |
| `current-pay.ts` | no suspensions | **throws** (same posture as its salary-history read) |
| `member-monthly-pay.ts` | no suspensions | returns `{ error }` |
| Payroll Wizard | no suspensions | **no suspensions** — the opt-out precedent ([mesa.md](mesa.md) § Never deduct from a non-member): charges per the flag, and the stub's MESA line reads `unavailable` because the suspension read shares the `mesaOptOut` loader state, which settles only when **both** reads answered |
| Active Members tab | Suspend / Resume disabled, tooltip names the migration | amber banner; Suspend / Resume disabled until a Refresh reads them |

The Wizard row is the known soft spot: a suspension that fails to load during a Lock In is charged. It
mirrors how an opted-out member is handled today and is surfaced on the stub, not hidden.

## The Action column — the same buttons on every row (Kane, 2026-10-06)

Active Members rows all carry **View · Suspend · Resume · Opt Out**, in that order: one labelled button,
then icon buttons. A button that does not apply (Resume on a member who is not suspended, Suspend on one
who is) is **disabled with the reason on hover, never removed**, so columns line up and nothing appears
or vanishes between rows. The Requests tab follows the same rule — see [mesa.md](mesa.md) § Accounting tab.
Bulk **Suspend** applies one date to every selected member and leaves out (and counts) anyone already
suspended. There is no bulk Resume.

## Authorization and audit

| Action | Gate | Audit |
| --- | --- | --- |
| List (`GET /api/mesa-suspensions`) | `requireElevatedSession` — the program-wide `/api/mesa-ledger` gate | — |
| Suspend (`POST`) | `requireFeatureEditAnyView('mesa')` — the Opt In / Opt Out gate | `employee.mesa.suspend` |
| Resume / cancel (`PATCH /[id]`) | `requireFeatureEditAnyView('mesa')` | `employee.mesa.resume` (`cancelled: true` when resumed on its start date) |

The actor is `auditFrom(request, authz)`; `suspended_by` / `resumed_by` are the session email, never the
body. The table has RLS on and no grants to `anon` / `authenticated` — service role only.

## Not covered

- The **Employee** dashboard shows no suspension notice. The employee's paystub, live estimate
  (`current-pay.ts`) and monthly estimate honour it; the EmployeeDashboard's client-side auto-estimate
  (shown only before the Wizard publishes a figure) charges the ₱100 on the flag alone — a pre-existing
  gap that already ignores the enrollment date.
- The Employee MESA **History** projection (used only for a member with no ledger rows) does not skip
  suspended weeks.
- Re-uploading a **past** Hubstaff week re-deposits by today's membership and suspensions, not the paid
  snapshot — the pre-existing gap in memory `payroll-rule-changes-forward-only`.

## Deploy notes

- **PENDING (Kane):** `node --import tsx scripts/apply-mesa-suspensions-migration.mts --apply`. No flag
  rehearses inside a rolled-back transaction; `--verify` checks only. Needs `DATABASE_URL` (session
  pooler). It creates `mesa_suspensions`, its four CHECKs, the one-open-window index, the FK to
  `mesa_accounts`, RLS on + revoke, and runs 5 positive and 7 negative controls inside savepoints.
  **Rehearsed against production 2026-10-06: 24/24 PASS (12 object checks, 5 positive, 7 negative
  controls), rolled back.** Kane asked for it to be run; the `--apply` call was blocked by the session's
  auto-mode permission classifier, so it has **not** been applied.
- Safe in either order. Until it runs: every engine reads "no suspensions" (today's behaviour), Suspend /
  Resume are disabled with *"MESA suspensions are not set up yet"*, and both write routes answer 503.
- No env var, no n8n import.
