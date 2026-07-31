# COP-country payees — Colombians see and copy native COP

> **Status:** Payment Dispatch shipped 2026-07-30 (`9f235c7`); paystubs followed the same
> day (`fc25241`). **Display + copy only** — no routing, amount, or dispatch-record change.
> No migration.

Colombian staff are paid in Colombian pesos, but there are **no COP Pay Structures in the
Payment Catalog** — they ride the ordinary **PHP** rails (PHP rate → USD → their bank).
So the system had no idea who was Colombian, and the secondary line on their dispatch
rows / paystubs showed a **peso** figure they never actually receive. Now the number they
*do* receive is the one shown, and the copy button pastes it clean.

> The dedicated **COP tab** in Payment Dispatch is effectively dead for these people:
> that tab is driven by `payCurrency === 'COP'` (a COP *Pay Structure*), and they have
> none. Don't "fix" their tab placement — they belong on Hurupay/Wires like any PHP payee.

Live example (Jul 2026 cycle — exactly 4 active payees): Arturo Yepes, Maria Canas,
Reinel Ruiz (Lead Gen) and Sonia Cardenas (Client VA).

---

## 1 · The marker: `countryCurrency`, from onboarding `country` ONLY

Two different fields could say "Colombia". Only one is trustworthy:

| Field | Trust | Why |
|---|---|---|
| `hr_onboarding_submissions.country` | **YES** — the hire selected it on their own submitted paperwork | this is the country they are paid *into* |
| `hr_onboarding_submissions.invite_country` (HR's invite-side pick) | **NO** | has real misclicks on never-submitted invites — a Filipino hire (Shanice Ganas) was invited under "Colombia". Trusting it would have replaced her peso line with a COP one |

Submissions are filed under the hire's **personal** email, so every resolver must match
against **all** aliases it knows (work + personal + gsuite alternates, bridged via the
master list / rates rows) and against **both** submission email columns
(`email`, `invite_personal_email`).

`currencyForCountry(country)` (`src/lib/onboarding/countries.ts`) maps the country to a
`PayCurrency`; Colombia → `COP`.

Two resolvers, same rule — keep them in sync:

| Scope | Function | Used by |
|---|---|---|
| **Bulk** (whole cycle) | `countryCurrencyByEmail` inside `computeCurrentPay` → per-row `countryCurrency` on the pay row (`src/lib/payroll/current-pay.ts`) | Payment Dispatch queue + Mark Paid |
| **Single person** | `resolveCountryCurrencyForEmails(emails)` (`src/lib/payroll/cop-country.ts`) | the paystub readers (`app/api/employee/paystub`, `app/api/accounting/paystub`) |

Both are **best-effort**: no matching submission, an unmapped country, or a DB error →
`null`, and the surface simply renders no native-currency line.

`getUsdToCopRate()` in the same module reads `app_settings.usd_to_cop_rate` through
`effectiveUsdToCopRateFromStored` — the *same* resolution `buildFxRates` gives the
dispatch queue, so a stub's COP figure always equals what Dispatch pays.

**`payCurrency` is never touched.** The marker is a parallel, display-only signal.

---

## 2 · Payment Dispatch

`ProcessorQueue.tsx` splits the two amount lines into helpers so the rule lives in one
place:

```
rowPrimaryAmount(row)   → payCurrency === 'COP' ? formatCOP(amountCOP) : formatUSD(amountUSD)
rowSecondaryIsCop(row)  → payCurrency !== 'COP' && countryCurrency === 'COP' && amountCOP != null
rowSecondaryAmount(row) → rowSecondaryIsCop ? formatCOP(amountCOP) : formatPHP(amountPHP)
```

- **Queue rows** (Hurupay / Wires / All pending / Excluded): the big **USD** number is
  unchanged; the small line beneath it shows `$COP526.686` instead of `₱10,161.52`.
- **Mark Paid dialog** (`MarkPaidDialog.tsx`): same swap on the secondary amount, and its
  **copy button pastes a bare integer** — `526686`, no symbol, no separators — so it drops
  straight into a bank field.
- Nobody changes tabs, and `amount_cop` is already persisted on every
  `payment_dispatches` row, so reports and history need no change.

---

## 3 · Paystubs

The statement carries a native-COP equivalent for the same people, on every paystub
surface (they all funnel through the shared `PayStubStatement`). The paystub readers call
`resolveCountryCurrencyForEmails` with the person's full alias set plus
`getUsdToCopRate()`, and `paystub-view.ts` derives the COP line from the PHP figures at
that rate — the stub's PHP arithmetic is untouched, so it still reconciles line-by-line.

---

## 4 · Verifying

```
node scripts/diagnose-cop-people.mjs          # who has a Colombia submission, and under which email
npx tsx scripts/verify-cop-country-marker.mts # runs the REAL pay computation against live data
```

`verify-cop-country-marker.mts` is permanent — rerun it any week; it prints exactly who
gets the marker this cycle and their COP figures (USD × the live rate). After deploying,
**reload the Payment Dispatch tab** so it refetches pay data.

---

## 5 · Files

| Path | Role |
|---|---|
| `src/lib/payroll/cop-country.ts` | single-person resolver + `getUsdToCopRate` |
| `src/lib/payroll/current-pay.ts` | bulk `countryCurrencyByEmail` → `countryCurrency` on each pay row |
| `src/components/payroll-clerk/ProcessorQueue.tsx` | `rowPrimary*` / `rowSecondary*` helpers |
| `src/components/payroll-clerk/MarkPaidDialog.tsx` | secondary amount + bare-integer copy |
| `src/components/payroll-clerk/mock-queue.ts` | `countryCurrency` on `QueueRow`, `formatCOP` |
| `src/lib/payroll/paystub-view.ts`, `src/components/paystub/PayStubStatement.tsx` | the stub's native-COP line |
| `scripts/diagnose-cop-people.mjs`, `scripts/verify-cop-country-marker.mts` | diagnostics |
