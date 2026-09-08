# Settlement currency — foreign-settled staff see and copy their native figure

> **Status:** Payment Dispatch shipped 2026-07-30 (`9f235c7`); paystubs the same day
> (`fc25241`). **Extended 2026-09-08** to the **Manager KPI Calculator** and the
> **Payroll Wizard**, with a shared per-person resolver and a settlement sticker on all
> three surfaces (Kane: *"COP people will be paid in COP Values, this should reach Payment
> Dispatch and Payroll Wizard as well"*). Still no migration.

Colombian staff are paid in Colombian pesos, but there are **no COP Pay Structures in the
Payment Catalog** — they ride the ordinary **PHP** rails (PHP rate → USD → their bank).
So the system had no idea who was Colombian, and every figure shown to a human was a
**peso** amount they never actually receive. Now the figure they *do* receive is the one
shown, on every surface that shows them money, and the copy button pastes it clean.

> The dedicated **COP tab** in Payment Dispatch is effectively dead for these people:
> that tab is driven by `payCurrency === 'COP'` (a COP *Pay Structure*), and they have
> none. Don't "fix" their tab placement — they belong on Kolan/Wires like any PHP payee.

Live spread (verified 2026-09-08 against prod — see §5): **7** non-PHP settled people on
the master list. Six COP — Maria Canas, Reinel Ruiz, Juan Ruiz, Santiago Marin (Lead Gen),
Arturo Yepes, Sonia Cardenas (Client VA) — and **one USD**: Alex Barba, also **Lead Gen**.
That USD payee matters: the "what if another department has someone in another country"
case is not hypothetical, it is already live *inside the department this shipped for*.
Nothing here hardcodes Colombia or Lead Gen.

---

## 0 · The two currency axes — do not cross them

This is the one thing to understand before editing any of it.

| Axis | Question it answers | Resolver | Feeds |
|---|---|---|---|
| **Catalog** currency | what is this AMOUNT denominated in? | `bonus.currency` / `PayStructure.currency` → `effectiveCurrency(deptKey, bonus)` | `phpPerUnit()` → **PHP-equivalent** → stored + paid |
| **Settlement** currency | what is this PERSON paid in? | `buildSettlementCurrencyByEmail` (`src/lib/payroll/settlement-currency.ts`) | `nativeAmountFromPhp()` → the figure a human keys into a bank |

A Colombian's KPI bonuses are **peso-denominated** (catalog PHP) and **COP-settled**.
Both directions of crossing the axes are a silent, expensive money bug:

- **settlement → `phpPerUnit`** (i.e. treating a ₱1,200 bonus as *COP 1,200*) multiplies by
  `php_per_cop ≈ 0.0154` and pays about **₱18** — a 98% underpay.
- **settlement figure → a PHP column** (`bonus_catalog_applied.amount`, `pay_php`) is read
  back as pesos by the Payroll Wizard and pays about **68×** the bonus.

So the payout layer stays **PHP-pivot end to end**, and the native figure is *reconstructed*
at each display boundary — never substituted into storage. This is exactly what
`src/lib/fx/currency-fx.ts` was built for (`phpPerUnit` in, `nativeAmountFromPhp` out).
Both classes are pinned by `src/lib/payroll/settlement-currency-surfaces.test.ts`, which
greps the real source of the KPI Calculator and the Wizard.

**`payCurrency` is still never touched**, and that is a payment-safety rule, not tidiness:
flipping a Colombian's `payCurrency` to `'COP'` moves them out of their Kolan/Wires
processor queue and into the empty COP tab, i.e. silently unpaid.

---

## 1 · The marker: settlement currency, from onboarding `country` ONLY

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

**One resolver, three callers.** The bulk marker logic used to live inline inside
`computeCurrentPay`; 2026-09-08 it moved out into the pure, tested
`buildSettlementCurrencyByEmail(onboardingRows, aliasesByEmail, aliasPairs)`
(`src/lib/payroll/settlement-currency.ts`). `current-pay.ts` now calls it, and so does the
route below — because "who is Colombian" answered two different ways on two surfaces is
the bug, not a redundancy.

| Scope | Entry point | Used by |
|---|---|---|
| **Bulk** (whole cycle) | `buildSettlementCurrencyByEmail` inside `computeCurrentPay` → per-row `countryCurrency` (`src/lib/payroll/current-pay.ts`) | Payment Dispatch queue + Mark Paid |
| **Per surface** (a list of emails) | `POST /api/payroll/settlement-currency` → `{ byEmail, rate }` | Manager KPI Calculator, Payroll Wizard |
| **Single person** | `resolveCountryCurrencyForEmails(emails)` (`src/lib/payroll/cop-country.ts`) | the paystub readers (`app/api/employee/paystub`, `app/api/accounting/paystub`) |

> **The route must admit every role that renders the surface.** `qc` was missing on the
> first cut and the symptom was silent: `DeptBonusCalculator` also drives the **QC first-pass**
> view, so a QC officer's fetch 403'd, no marker arrived, and every Colombian's row rendered
> in pesos with no sticker — indistinguishable from "this person is Filipino". Allowed roles
> are now `manager`, `qc`, `accounting`, `admin`, pinned by a test. If a Colombian ever shows
> no chip, check the role list before anything else.

The marker is **best-effort**: no matching submission, an unmapped country, or a DB error →
no marker, and the surface renders plain pesos. The route is the one exception that reports
rather than degrades: a *partial* identity read would silently UNDER-mark people, so a read
failure returns 502 instead of an empty map that reads as "nobody is foreign-settled".

`OnboardingCountryRow` deliberately has **no `invite_country` field**, so the untrusted
column cannot be passed in by accident. Pinned by a test.

Both identity bridges live in the resolver and both are load-bearing: master-list aliases
first, then work↔personal `employee_hourly_rates` pairs for people whose master row is
missing or carries a different personal email. The verifier in §4 fails loudly if any
non-PHP person ends up marked on their personal email *only* — pay surfaces key on the
work email, so that person would silently read pesos.

> **Landmine.** `employee_hourly_rates` is CSV-seeded: its columns are quoted and
> capitalised (`"Work Email"`, `"Personal Email"`). A snake_case projection fails with
> `column employee_hourly_rates.work_email does not exist`, and because the caller bails on
> that error, **every** marker is lost — not just the bridged ones. This was hit and fixed
> during the 2026-09-08 build. Always read that table through
> `getEmployeeHourlyRatesRows()`, which owns the naming variants, the deduplicated view,
> the env-var table name and the paging.

### The FX licence — why a rate can refuse to be used

A settlement figure is a *conversion*, so it is only as honest as the rate behind it. Two
failure modes are silent, and both used to be reachable:

| State | Cause | What the surfaces do |
|---|---|---|
| `unset` | the per-cycle rate starts at **0** on every new Hubstaff upload (setting it *is* the confirmation) | show **pesos**; chip turns amber, "`$COP · rate?`" |
| `fallback` | only the official placeholders are stored — `OFFICIAL_USD_TO_COP_RATE` is **4000** (indistinguishable from a real COP rate) and `OFFICIAL_USD_TO_PHP_RATE` is literally **1** | show **pesos**; same amber chip |
| `live` | both legs stored, > 0, and neither sitting on its placeholder | show the native figure |

`resolveSettlementRate(rawPhp, rawCop)` reads the **RAW** `app_settings` strings and must
never be fed through `effectiveUsdTo*RateFromStored` — those helpers are precisely what
replace a 0 with a plausible default and erase the "not confirmed yet" state. The route
resolves this **server-side** and the `live` variant is the only one carrying numbers, so
a client cannot read a rate off an `unset`/`fallback` response and convert with it anyway.

`settlementAmountFromPhp(php, currency, rate)` returns **null** unless the rate is `live`.
Null is the feature: the caller then prints pesos instead of a fabricated COP number.

---

## 2 · Payment Dispatch

`ProcessorQueue.tsx` splits the two amount lines into helpers so the rule lives in one
place:

```
rowPrimaryAmount(row)   → payCurrency === 'COP' ? formatCOP(amountCOP) : formatUSD(amountUSD)
rowSecondaryIsCop(row)  → payCurrency !== 'COP' && countryCurrency === 'COP' && amountCOP != null
rowSecondaryAmount(row) → rowSecondaryIsCop ? formatCOP(amountCOP) : formatPHP(amountPHP)
```

- **Queue rows** (Kolan / Wires / All pending / Excluded): the big **USD** number is
  unchanged; the small line beneath it shows `$COP526.686` instead of `₱10,161.52`.
- **Mark Paid dialog** (`MarkPaidDialog.tsx`): same swap on the secondary amount, and its
  **copy button pastes a bare integer** — `526686`, no symbol, no separators — so it drops
  straight into a bank field.
- Nobody changes tabs, and `amount_cop` is already persisted on every
  `payment_dispatches` row, so reports and history need no change.
- **The sticker (2026-09-08).** The COP number was already there; nothing said *why* it
  was COP. `settlementChipCurrency(row)` now drives a `SettlementChip` next to the name in
  both queue-row layouts, and the Mark Paid header carries the same badge inline (that
  header is a dark band, so it takes the on-dark badge treatment of its neighbours rather
  than the shared light chip). The predicate is deliberately narrow — `payCurrency` when it
  is non-PHP, else COP only when `rowSecondaryIsCop(row)` holds. A Colombian whose
  `amountCOP` is null (an arrears rollup) falls back to the peso secondary line, and
  stickering them would label a figure that is not on the row.
- Dispatch passes the chip `{ status: 'shown' }` rather than a `SettlementRate`: it holds a
  real persisted `amount_cop` from its own source, so there is no rate for it to vouch for
  and nothing to warn about. It must not invent a `live` rate it cannot prove.

---

## 3 · Manager KPI Calculator (2026-09-08)

`DeptBonusCalculator.tsx`. **Every member-scoped figure on a foreign-settled person's row
reads in their currency** — the bonus cells, the team-bonus share, their individual
bonuses, and their row total.

One resolver does it, and everything funnels through it:

```
settledFigure(deptKey, bonus, vars, email) -> { amt, cur }
  PHP-settled -> { computeNative(bonus, vars), effectiveCurrency(deptKey, bonus) }   // unchanged
  otherwise   -> { settlementAmountFromPhp(computeAmount(bonus, vars, fx, catalogCur), ...), settlementCur }
```

Note the pivot: `computeAmount` — *the same chokepoint that produces the peso figure
`saveDept` stores* — resolves the catalog currency to pesos **first**, and only then does
the settlement conversion happen. The settlement currency is never handed to
`computeAmount` or `phpPerUnit` (section 0).

### The display hierarchy (Kane, 2026-09-08)

> *"For the Lead Gen Total only the COP should be the highlighted value while the PHP should
> be secondary only but in the total field there should be USD, COP and PHP."*

**What they are paid is the headline; the peso is a quiet second line.** Every
member-scoped figure renders as:

```
$COP1.401.733        <- headline, emerald, the money that lands in their bank
≈ ₱28,000.00         <- PesoSubline: the peso this converts FROM
```

and every TOTAL adds the USD anchor, because for a department whose legs are in different
currencies USD is the only single number that compares:

```
$COP1.401.733        <- headline
≈ $446.43 · ₱28,000.00
```

`SettledTotalCell` renders that pairing everywhere a total appears — member row total, each
column subtotal, the individual-bonus subtotal, the department subtotal and the grand
total. `PesoSubline` does it for the individual cells.

**Neither extra line ever appears for a peso-settled person.** `PesoSubline` returns null
when the figure is already pesos (restating it is noise), and the peso leg of a total is
suppressed unless a non-PHP leg exists. A Filipino's row is therefore unchanged except that
totals gain the `~ $USD` anchor.

**The USD line obeys the same FX licence as the headline** — `usdFromPhp` returns null
unless the rate is `live`, and guards its divisor rather than returning `Infinity`. An
unconfirmed rate produces *no line*, never a plausible number.

### Two numbers, carried together: `SettledTotal`

```ts
type SettledTotal = { money: Money; php: number };
```

`money` is what recipients actually get, split by currency — those legs cannot be summed.
`php` is the PHP-**equivalent** of the whole thing: the pivot every leg converted through,
the only figure comparable across a mixed department, and the same number
`bonus_catalog_applied.amount` holds and the Wizard pays. Keeping both is what allows a COP
headline with a peso reconciliation line instead of forcing a choice between the currency
someone is paid in and the currency the books are kept in.

`settledFigure` returns `{ amt, cur, php }` from a single `computeAmount` call, so the
headline and its subline can never disagree about the same bonus.

**Column subtotals became `SettledTotal`s.** A column is one bonus, so its footer used to be
a single number. A department can now mix PHP-settled and COP-settled people, and adding
pesos to Colombian pesos produces a meaningless figure. A wholly-Filipino column still
reads as one plain peso sum, so nothing changed for the departments that have no
foreign-settled staff.

**The team-bonus input stays in the catalog currency.** `perPerson` is the number the
manager *typed once* for the whole team — an input, not a payout — so the header shows it
unconverted; each member's cell then shows their own settled equivalent.

**`bonus_catalog_applied.amount` is untouched.** It is still
`computeAmount(bonus, st.vars, fx, effectiveCurrency(key, bonus))` — the peso figure the
Payroll Wizard "KPI Sub." sum reads and pays verbatim. What a Colombian is *shown* in COP
is a reconstruction of that peso figure, never its replacement.

---

## 4 · Payroll Wizard (2026-09-08)

`PayrollWizard.tsx`, Additions tab. A `SettlementChip` next to the employee's name, and
`PhpWithUsd` gained `settlementCurrency` / `settlementRate`: for a foreign-settled payee the
native figure **replaces the USD line** (COP is derived *through* the USD anchor, so showing
both is the same number twice) and renders teal at peso weight.

**The peso stays the headline, on purpose.** That column sums into a peso footer Accounting
reconciles, so swapping the headline per-row would make the column unscannable. Payment
Dispatch shows the same pairing the other way up (USD headline, native secondary), so the
two Accounting surfaces agree about which figure is which.

Nothing the wizard **computes, stages or dispatches** changed: `pay_php` is peso-denominated
end to end.

---

## 5 · Paystubs

The statement carries a native-COP equivalent for the same people, on every paystub
surface (they all funnel through the shared `PayStubStatement`). The paystub readers call
`resolveCountryCurrencyForEmails` with the person's full alias set plus
`getUsdToCopRate()`, and `paystub-view.ts` derives the COP line from the PHP figures at
that rate — the stub's PHP arithmetic is untouched, so it still reconciles line-by-line.

---

## 6 · Verifying

```
node scripts/diagnose-cop-people.mjs             # who has a Colombia submission, and under which email
npx tsx scripts/verify-cop-country-marker.mts    # the REAL pay computation, this cycle's payees
npx tsx scripts/verify-settlement-currency.mts   # the SHARED resolver + FX provenance, whole master list
```

All three are permanent and read-only. Rerun any week.

`verify-settlement-currency.mts` is the one to reach for first: it prints the FX provenance,
the marker spread, **every** non-PHP settled person on the master list (not just this
cycle's payees), and it fails loudly if anyone is marked on their personal email only.
`verify-cop-country-marker.mts` covers a narrower set by design — only people with hours in
the current cycle — so a Colombian with no hours this week appearing in one and not the
other is expected, not a bug.

After deploying, **reload the Payment Dispatch tab** so it refetches pay data.

---

## 7 · Files

| Path | Role |
|---|---|
| `src/lib/payroll/settlement-currency.ts` | **the shared resolver** + the FX licence (`resolveSettlementRate`, `settlementAmountFromPhp`) |
| `src/lib/payroll/settlement-currency.test.ts` | the marker rules + both fabrication classes |
| `src/lib/payroll/settlement-currency-surfaces.test.ts` | source guards: settlement never reaches `computeAmount`/`phpPerUnit`, reads stay paged |
| `app/api/payroll/settlement-currency/route.ts` | POST emails -> `{ byEmail, rate }`; manager/accounting/admin |
| `src/components/payroll/SettlementChip.tsx` | the sticker, shared by all three surfaces |
| `src/components/manager/DeptBonusCalculator.tsx` | `settledFigure`, `Money` column subtotals, chip |
| `src/components/PayrollWizard.tsx` | `PhpWithUsd` settlement line + chip |
| `scripts/verify-settlement-currency.mts` | permanent read-only verifier |
| `src/lib/payroll/cop-country.ts` | single-person resolver + `getUsdToCopRate` (paystubs) |
| `src/lib/payroll/current-pay.ts` | calls the shared resolver -> `countryCurrency` on each pay row |
| `src/components/payroll-clerk/ProcessorQueue.tsx` | `rowPrimary*` / `rowSecondary*` helpers + `settlementChipCurrency` |
| `src/components/payroll-clerk/MarkPaidDialog.tsx` | secondary amount + bare-integer copy + inline badge |
| `src/components/payroll-clerk/mock-queue.ts` | `countryCurrency` on `QueueRow`, `formatCOP` |
| `src/lib/payroll/paystub-view.ts`, `src/components/paystub/PayStubStatement.tsx` | the stub's native-COP line |
| `scripts/diagnose-cop-people.mjs`, `scripts/verify-cop-country-marker.mts` | diagnostics |
