# Bank Preferred — send-from routing, approval gate & WIRES lock

*Shipped 2026-07-22; Wise updates + the No-Bank clobber discovery added
2026-07-25 (§7); People-tab parity + Accounting direct-edit added 2026-08-10
(§8). Migration status re-verified against production 2026-08-11 — see
[Migrations](#migrations). Bank changes KPI band added 2026-08-19 (§10) — rail-shaped, no bank names.*

"Bank Preferred" is the processor **Accounting sends a salary OUT on** — the
*send-from rail*. It is a first-class, employee-owned field that wins Payment
Dispatch's processor-routing precedence, is **held for Accounting approval**
before it takes effect, and carries a hard **WIRES lock** that a wires employee
can never be moved off of onto Kolan/HiGlobe.

> **Rebrand, 2026-08-24 — Hurupay is now Kolan.** Only the human-visible label
> changed. The processor **id**, `employee_ids.bank_preferred`, the
> `hr_onboarding_submissions.payment_method` CHECK, and the `hurupay_email` /
> `"Hurupay Email"` columns all still read `hurupay`. Renaming any of them would
> make `isWiresPreferred()` classify every Kolan payee as WIRES and lock them out
> of their own rail. Where this doc writes `hurupay` in code font it means the
> STORED VALUE and is still literally correct.


> **Do not conflate three separate things.** They live in different columns and
> mean different things:
>
> | Concept | Column | Meaning |
> |---|---|---|
> | **Bank Preferred** | `employee_ids.bank_preferred` | Which processor/rail Accounting pays **out** on (this doc). |
> | **Disbursement** | `employee_ids.preferred_processor` | How the employee elects to **receive** (radio tiles, own detail fields). |
> | **Receiving account** | `employee_ids.account_number` / `swift_code` / wallet-email cols | The employee's own bank/wallet where the money lands. |
>
> A Bank Preferred change **never touches the receiving account**. That part is
> absolute: `account_number`, `swift_code` and the wallet-email columns are the
> employee's own data and no rail pick may write them.
>
> The **Disbursement** picker is a different story as of **2026-08-24** (Kane).
> The first build wired both fields to `preferred_processor`, so changing either
> flipped the other — that was a bug and it stays fixed. But the two **wallet**
> rails are now deliberately coupled in ONE direction:
>
> **Setting Bank Preferred to Kolan or HiGlobe also sets Disbursement to match.**
>
> Kolan and HiGlobe pay *into* the same wallet they send *from*, so "send from
> Kolan, receive on Wise" describes nothing real — it just asks the employee for
> detail fields nobody will ever use. Wise / Jeeves / Wires impose nothing and
> remain fully independent, which is what the original decoupling protected. The
> rule lives in `mirroredDisbursementFor()` and is applied server-side in
> `app/api/people/[email]/banking/route.ts`, so it holds however the save was
> made; the People-tab form mirrors it only so the UI shows what will be saved.

---

## 1. The dropdown (Employee → Profile → Payment)

A `SmoothSelect` below the Disbursement form. Options and their stored processor
ids come from `BANK_PREFERRED_OPTIONS` in
[`src/lib/employee-payment-processors.ts`](../../src/lib/employee-payment-processors.ts):
HiGlobe / Kolan / Jeeves / Wise / **x1153**.

- **`x1153` → `wires`.** `x1153` is a specific wire account, not a distinct
  processor, so it maps to the `wires` processor id. Because there is no separate
  non-x1153 `wires` option, a saved `wires` value **displays as "x1153"** in the
  dropdown.
- The field shows a **"Pending approval"** badge whenever the employee has an
  outstanding change (see §3).
- `EmployeeIdRow` and both `.select(cols)` strings in
  [`src/lib/supabase/employee-ids.ts`](../../src/lib/supabase/employee-ids.ts)
  must list `bank_preferred`, or reads return `undefined`.

## 2. Routing precedence (how Payment Dispatch picks the rail)

When Payment Dispatch decides which processor tab a person lands in, it resolves
in this order — **Bank Preferred wins**:

```
employee_ids.bank_preferred            (this field — highest)
  ↓ else
employee_ids.preferred_processor       (the Disbursement pick)
  ↓ else
employee_hourly_rates."Bank Preferred" (legacy CSV free-text routing hint)
```

Applied in the routing resolvers: `mock-queue.ts` (the live queue),
[`pay-schedule.ts`](../../src/lib/payroll/pay-schedule.ts)
(`resolveEmployeeProcessor`), and
[`dispatch-export-csv.ts`](../../src/lib/payroll/dispatch-export-csv.ts)
(`buildDispatchExportRows` — where a *recorded* `dispatch.processor` still wins
first). The `preferred_processor` value must be **NULL** for the CSV-seeded
routing to be authoritative, since it outranks the legacy CSV column.

> **Sub-₱7k wires → Wise (2026-07-29).** After the precedence resolves to
> `wires`, Payment Dispatch reroutes the payment **via Wise for that week** when
> the week's PHP amount is strictly under ₱7,000 — recomputed every cycle, never
> written to `employee_ids`, so a ≥₱7k week lands the person back on Wires by
> itself. No interaction with the WIRES lock (§4), which guards *stored*
> transitions. Detail:
> [payment-dispatch.md §12.3.1](./payment-dispatch.md#1231-sub-₱7k-wires--wise-temporary-weekly-reroute-2026-07-29).

> **Known gap (accepted, awaiting a product call):** the All-Dept rates sheet
> writes free-text "Bank Preferred" into the lowest-precedence
> `employee_hourly_rates."Bank Preferred"` column
> ([`rates-upload-db.ts`](../../src/lib/supabase/rates-upload-db.ts)). For a
> person whose `bank_preferred` **and** `preferred_processor` are both null, a
> sheet cell saying "Hurupay" still routes them to Hurupay — a bulk path around
> the WIRES lock's intent. Needs a ticket or an explicit "accepted".

## 3. Accounting approval gate

Employee Bank Preferred changes do **not** write `employee_ids` directly. They
are held as a `pending` row and approved by Accounting first — mirroring the MESA
Requests workflow.

**Flow:**
1. Employee changes Bank Preferred → a `pending` row is inserted into
   `bank_preferred_change_requests` (data layer:
   [`src/lib/supabase/bank-preferred-requests.ts`](../../src/lib/supabase/bank-preferred-requests.ts)).
   The **old value stays live** for Payment Dispatch until approved. Other bank
   fields on the form still save immediately. **First-time set is also gated.**
2. The write path is intercepted in
   [`app/api/update-employee-ids/route.ts`](../../app/api/update-employee-ids/route.ts)
   (`interceptBankPreferred`), which is **fail-closed** — it never writes
   `bank_preferred` without filing a request.
3. **One pending per employee** (partial unique index). A re-submit supersedes
   the previous pending row; two near-simultaneous submits that trip the index
   (Postgres `23505`) are retried once instead of surfacing a raw 500.
4. Accounting approves/denies in the **Issues tab** (internal id `disputes`,
   gated by `requireFeatureEditAnyView('disputes')`) via
   [`BankPreferredApprovals.tsx`](../../src/components/payroll/BankPreferredApprovals.tsx),
   rendered above the PAB dispute queue. **Approve** writes
   `employee_ids.bank_preferred` (bootstrapping a row if none) and notifies the
   employee (`bank_preferred.decided`); **Deny** leaves the value untouched.

API routes: [`app/api/bank-preferred-requests/route.ts`](../../app/api/bank-preferred-requests/route.ts)
and [`[id]/route.ts`](../../app/api/bank-preferred-requests/[id]/route.ts).

## 4. The WIRES lock

A **WIRES employee** — one whose `employee_ids.bank_preferred` is set to anything
but exactly `hurupay`/`kolan`/`higlobe`, **including legacy free-text** — can
**never** be switched to Kolan or HiGlobe. WIRES is the residual bucket.

**`null` is NOT a lockout (changed 2026-08-24, Kane).** Two different questions
share the word "wires" and used to share one predicate:

| Question | Predicate | Unset (`null`/`''`) means |
|---|---|---|
| Which rail does this person get paid on? | `isWiresPreferred` | **wires** — no rail assigned ⇒ paid by bank wire |
| Is this person barred from the wallet rails? | `isWalletRailLocked` | **not locked** — never assigned ≠ put on wires |

Collapsing those two meant a payee whose `bank_preferred` had simply never been
populated could never be placed on Kolan/HiGlobe at all — **including every new
hire**. Routing is unchanged: `isWiresPreferred` still answers the routing
question exactly as before, and only the transition guard's `current` side moved
to the narrower predicate. A person **explicitly** on `wires`/`x1153`/legacy text
is still locked, and that is pinned by test.

**`kolan` is the rebranded spelling of `hurupay` (2026-08-24) and counts as that
same wallet rail — nothing else was widened.** The stored value stays
`hurupay`; `kolan` is accepted defensively because the rates sheet is free text
and a human will eventually type the new name. Reading it as WIRES would be a
misclassification that permanently locks a wallet payee out of their own rail.
Every other legacy spelling — including the `huru`/`huropay` aliases the TEXT
normaliser separately accepts — still counts as WIRES, and
`employee-payment-processors.test.ts` pins that non-widening explicitly.

Single source of truth, both unit-tested (incl. mixed-case legacy free-text) in
[`src/lib/employee-payment-processors.ts`](../../src/lib/employee-payment-processors.ts):

```ts
isWiresPreferred(value)                    // true unless value is exactly hurupay/kolan/higlobe
isBankPreferredTransitionAllowed(current, next)
  // false iff current is wires-preferred and next is NOT wires-preferred
```

**Allowed:** `hurupay ↔ higlobe`, `anything → wires`, and `unassigned → any rail`
(unassigned = **no** tier resolves a rail at all).
**Blocked:** `wires/legacy → hurupay | kolan | higlobe`, and `wires/legacy → unset`
(clearing would launder the lock, since unassigned is assignable).

**"Current" means the EFFECTIVE rail, not `employee_ids.bank_preferred` alone.**
`resolveWalletRailLock()` resolves all three tiers and **fails closed** — a read
error is a 503, never an unlocked payee. A tier-1-only check would read the
~1,351 people seeded into the legacy cell in 2026-07-22 (466 with
`preferred_processor` deliberately cleared) as "never assigned", because their
`bank_preferred` is still NULL — and let a wire-only payee onto a wallet in a
single save.

Five enforcement sites (defense in depth). They deliberately do **not** all ask
the same question, and that asymmetry is the design:

- The two **server gates** resolve the **effective** rail across all three tiers
  (`resolveWalletRailLock`) and fail closed. They are the real gate.
- The three **client / pre-filter** sites see only tier 1, so they use the
  **conservative** `isWiresPreferred` and treat unset as locked. Being stricter
  than the gate is safe; being looser is not. A UI that offers an option the API
  refuses is a bad prompt, but a UI that offers one the API *accepts* when it
  should not is a mispaid salary.

**Never wire a client site to `isBankPreferredTransitionAllowed` on a tier-1
snapshot.** Doing so is what silently un-disabled the Approve button for the
legacy sheet-routed population when `null` stopped meaning "locked".

| Site | Behavior |
|---|---|
| `update-employee-ids` intercept | **400** before a request is even filed |
| Approval **PATCH** re-check | re-checks against the **live** stored value at approve time → 400, request stays pending |
| People → Banking save (`/api/people/[email]/banking`) | **400** against the stored value, then applies the wallet mirror |
| Employee Profile dropdown | **hides** hurupay/higlobe options for an explicitly-wires employee |
| Accounting approvals row | **Approve disabled** + an "owner-only / locked" row note |

## 5. Mark Paid bank-details override

Separate but adjacent: when Accounting discovers wrong/stale **receiving** details
at pay time, a **pencil** on the Recipient divider of the Mark Paid modal
([`MarkPaidDialog.tsx`](../../src/components/payroll-clerk/MarkPaidDialog.tsx))
enters "override mode" → **Save to profile** writes the corrected receiving
details back to `employee_ids` via
[`POST /api/payment-dispatch/bank-override`](../../app/api/payment-dispatch/bank-override/route.ts).

- Accounting-gated; **deliberately NO dispatch-lock check** — this is the
  sanctioned mid-processing correction path.
- **Never touches routing** (`bank_preferred` / `preferred_processor` stay put) —
  only the receiving account.
- Column mapping is slot-aware (primary vs alternate via `preferred_bank_slot`;
  wallet processors map to their wallet-email columns) in
  [`bank-override-mapping.ts`](../../src/lib/payroll/bank-override-mapping.ts)
  (10 `node:test` cases).
- Shows in **People → Bank Changes** as `via: mark_paid_override` (masked
  values); the employee gets a `people.banking.overridden` notification.
- Also related: a Wise-routed employee now pre-fills **their own** bank on the
  modal ([`mark-paid-defaults.ts`](../../src/lib/payroll/mark-paid-defaults.ts)).

## 6. Data seeding & one-off fixes (2026-07-22)

- **CSV seed of send-from routing.** `references/docs/PD Data.csv` (a PD dispatch
  log) is the intended source of truth for `employee_hourly_rates."Bank Preferred"`;
  ~1,351 people were seeded and `employee_ids.preferred_processor` cleared for 466
  who had a pick, so the CSV routing became authoritative. Receiving accounts were
  left untouched. Done via Node scripts (Kane cannot paste SQL into Supabase);
  **always SELECT-to-backup a column before a destructive bulk UPDATE**.
- **Hurupay-no-email → wires flip.** 17 active people routed to Hurupay who had
  no Hurupay wallet email but full wire info were set to `bank_preferred='wires'`
  (backup in `references/backups/`, gitignored). **48 actives** remain
  Hurupay-routed with neither a Hurupay email nor wire info — a data-collection
  gap (`references/backups/2026-07-22_hurupay_no_payout_data.csv`), candidates for
  the People "Notify" missing-bank-info flow.

## 7. Wise updates & the No-Bank clobber discovery (2026-07-25)

- **Wise un-retired on employee-facing pickers.** `EMPLOYEE_SELECTABLE_PROCESSOR_OPTIONS`
  (`src/lib/employee-payment-processors.ts`) adds Wise to the Readiness "Set bank"
  processor picker and the Employee Dashboard disbursement radios; contractor
  gateways still exclude it. (The People tab always offered it.)
- **Wise = wire fields.** Since Wise payouts land in the payee's **bank account**,
  picking Wise now collects/shows the same field set as Wires (bank, account
  holder/number, SWIFT, address) in People → Banking (editor + reveal), the
  employee payout form (`employee-payout-fields.tsx`), and the Readiness Set-bank
  dialog.
- **PH Global Freelancers Wise seed.** 27 Global-Master-List people from
  `references/docs/PH Global Freelancers .xlsx` were seeded with `wise_email`, a
  last-4 tag, and `bank_preferred='wise'` (`scripts/seed-ph-freelancers-wise.mjs`;
  person-first matching to dodge stale `employee_ids` rows). 15 sheet emails had
  no master row and were skipped; spot-check joshs' `x1153`-style→Wise flip on the
  next cycle.
- **⚠ The §6 seed clobbered self-submissions — restoration OPEN.** An audit of the
  No-Bank list (`scripts/audit-nobank-external-link.mjs`, read-only) found **34 of
  145 listed people had already set their bank** — 28 of them complete Jul-21/22
  **external-link submissions** whose `preferred_processor` the Jul-22 PD-Data
  seed cleared, orphaning their details from the display/routing path. Old values
  are recoverable from `bank_update_history.changes`; the restore has **not been
  run** (Kane's call). One flagged row (Chris Lawang) was a misread — a SELF-row
  shadow, not a clobber.

## 8. People-tab parity & Accounting direct-edit (2026-08-10)

A live audit (`scripts/audit-people-vs-dispatch-banks.mjs`, read-only) found the
People tab disagreed with Payment Dispatch for ~12% of the routed roster: the
roster chip read `preferred_processor` alone (133 people chip-less though PD
routed them, 35 showing the wrong rail), "Missing bank info" ignored the legacy
rates-row fallbacks (27 false alarms), the profile Banking view hid accounts in
the non-preferred slot (9), and `bank_preferred` wasn't surfaced at all. Fixed
by resolving everything People shows through the SAME dispatch-parity helpers:

- **Roster chip + `hasBanking`** ([`people-roster.ts`](../../src/lib/people/people-roster.ts))
  use `resolveEffectivePayoutProcessor` / `isPayoutComplete` **with**
  `PayoutLegacyExtras` from the rates row — and the rate context now loads via
  `getEmployeeHourlyRatesRows()` (the deduped `_current` view PD reads, paged),
  fixing a silent 1000-row truncation of the old raw select.
- **Profile Banking view** ([`PeopleTab.tsx`](../../src/components/people/PeopleTab.tsx))
  shows three routing fields — *Pays via (Payment Dispatch)* (the effective
  rail + source), *Bank Preferred (send-from)*, *Disbursement pick* — keys field
  visibility on the **effective** rail, and falls back across bank slots with
  PD's pickFirst rule. The payload ([`people-banking.ts`](../../src/lib/people/people-banking.ts))
  carries `bank_preferred`, `effective_processor`, `effective_processor_source`;
  a sheet-routed person with no `employee_ids` row still gets a synthesized
  record so their routing shows.
- **Accounting direct-edit.** The People banking editor now offers a *Bank
  Preferred (send-from)* dropdown. `PATCH /api/people/[email]/banking` accepts
  `bank_preferred` **without filing a change request** — the route is gated to
  the same roles that approve those requests, so the edit *is* the approval.
  The **WIRES lock still applies**, enforced server-side against the live
  stored value and mirrored in the dropdown's option filter. The employee
  self-service path keeps the §3 approval gate unchanged. (A direct edit does
  not cancel an employee's pending request; the approval PATCH re-checks the
  lock at approve time as before.)

Parity is pinned by `src/lib/employee/payout-completeness.test.ts` and the
audit script's post-fix run: **0 disagreements across 1,498 active people**.

## 9. Routing + lock hardening (2026-08-10)

A follow-up audit found the same drift class on money-*moving* paths, plus the
locks not covering everything they imply. All fixed in one pass:

- **Urgent Payments preselected the wrong rail.** `preferredProcessor()` in
  [`urgent-payout-details.ts`](../../src/lib/payroll/urgent-payout-details.ts)
  read `preferred_processor` alone and **defaulted to `wise`** (retired), so a
  Hurupay-routed payee's card preselected Wise with no wallet email — and Send
  records a real dispatch. Now resolves with PD's full precedence (incl. a new
  `fetchLegacyBankPreferredByEmail` for the sheet tier) and returns **null**
  when nothing resolves; the card disables Send until the clerk picks a rail.
  Pinned by `urgent-payout-details.test.ts`.
- **`pay-schedule.ts`** returned `employee_ids.bank_preferred` **unmapped**, so
  a stored `x1153` failed `isWireProcessor` and produced a Tuesday pay date for
  a Thursday-paid wires payee. Now goes through the same text normalizer.
- **The Wizard's "People Tab · Live · Banking Info" card** claimed to mirror
  People but used the raw Disbursement pick and no cross-slot fallback. It now
  shows *Pays via* (effective rail) + *Bank Preferred*, with PD's slot fallback.
- **`/update-bank-info` prefill** omitted `bank_preferred`, so a
  `bank_preferred`-routed employee saw an empty picker and had to invent a
  `preferred_processor` that then disagreed with their real rail.
- **Lock coverage.** Approving a Bank Preferred request now checks the dispatch
  lock (it writes the send-from rail; every direct-edit path already did).
  Rate writes, payment-catalog pay structures, and Hubstaff hours POST/PATCH/
  DELETE are now lock-guarded too — previously the derived per-employee bonus
  amounts were guarded but the rates and hours they derive from were not.
- **`app-settings` POST was a lock + audit bypass.** It gated on
  `requireElevatedSession()` only, so `hr_coordinator` could POST
  `payroll.dispatch_locked=false`, drop every bank-edit freeze, and leave no
  audit row — routing around
  [`/api/payroll-dispatch-lock`](../../app/api/payroll-dispatch-lock/route.ts),
  which requires payment_dispatch edit *and* audits. Writes to
  `payroll.dispatch_lock*` now need payment_dispatch **or** payroll_wizard
  edit, sensitive keys (`auth.*`, webhook, token) are **admin-only to write**,
  and all such writes are audit-logged.
- **Contractor rail brought up to the employee rail's standard.** Profile and
  invoice routes had **no authorization at all** — a body-supplied
  `contractor_email` was the write key, and DELETE compared a query param
  rather than the session. Now self-or-elevated on every verb, payout edits are
  dispatch-locked, and they write `audit_log` + `bank_update_history`.
- **`update-employee-ids`** cross-employee writes now require the `people`
  feature (matching `people/[email]/banking`); a self edit can no longer claim
  `source: "people_tab"` in the change feed.

> **Still open — needs a product call.** The per-cycle lock
> (`payroll.dispatch_lock.<sourceFile>`) is read only client-side and gates
> nothing server-side, so "Accounting locked this cycle" is a UI convention.
> Making it also freeze bank edits would match the stated intent but could hold
> employees out for days at a time; deliberately not changed here.

## 10. Bank changes KPI band (2026-08-19)

**People → Bank changes** opens with two KPI cards above the feed, in the Payment
Catalog Summary band's card idiom. Both are **rail-shaped, and identical in rows and
order**:

| Card | Row value | Denominator |
|---|---|---|
| **Preferred bank · send-from** | people that rail carries | total routed |
| **Receiving details on file** | of those, how many are payable there | that rail's own headcount |

Same rows, two facts. The second card asks a different question rather than
restating the first, and a short bar there is a real collection gap.

Component: [`rail-mix-band.tsx`](../../src/components/people/rail-mix-band.tsx).
Aggregate: [`rail-mix.ts`](../../src/lib/people/rail-mix.ts) (`buildRailMix`, pure,
18 `node:test` cases in `rail-mix.test.ts`).

Live figures over `employee_ids` plus the legacy rates tier, 2026-08-19:

```
send-from        1,756 routed · 104 unrouted
  Hurupay 718 41% · Wires 430 24% · Wise 386 22% · Higlobe 219 12% · Jeeves 3 <1%

details on file  1,633 payable · 123 short
  Hurupay 682/718 95%  wallet email          Wires   395/430 92%  bank + account
  Wise    351/386 91%  bank + account        Higlobe 202/219 92%  email + account name
  Jeeves      3/3 100% bank + account
```

### 10.1 There are NO bank names on this band

The first build listed receiving banks by name. That is retired (Kane, 2026-08-19:
*no bank names, it has to be the same from preferred bank... if gotyme is being sent
from Wise or Wires*). Two reasons, both about the data rather than taste:

1. **`employee_ids.bank_name` is free text**: ~100 distinct spellings of maybe 30
   banks. `GoTyme Bank` and `GoTyme` are separate rows; so are three spellings of
   BPI. A leaderboard of those understates every real leader, and the only fix that
   invents no equivalences is a normalization pass on the column (a Node script with
   an `--apply` gate and a SELECT backup first), not a display trick.
2. **A bank is not the unit anyone pays on.** GoTyme measured `wise 132 · wires 45`:
   the bank is where money *arrives*, the rail is what Accounting *does*. Grouping by
   rail is also what makes the two cards comparable row for row.

**Do not reintroduce a bank-name breakdown here.** If a bank-level view is wanted
later it belongs on its own surface, after the column is normalized.

### 10.2 What "payable" means, per rail

Card 2 counts `isPayoutComplete`, the same predicate behind the roster's
Missing-bank-info list and the employee profile nudge, so the band cannot disagree
with either. Each row's caption comes from `payoutRequirementFor` in
[`payout-completeness.ts`](../../src/lib/employee/payout-completeness.ts), a switch
deliberately written in the **same shape** as `isPayoutComplete` right above it:

| Rail | Needs | Family |
|---|---|---|
| hurupay, wepay | wallet email | wallet |
| higlobe | email + account name | wallet |
| wise, jeeves, wires | bank + account (either slot) | bank |

Keep those two switches adjacent. A caption that disagrees with the check tells
Accounting to collect the wrong field, which is worse than no caption.

**HiGlobe stays a wallet rail** even though HiGlobe money does eventually reach a
Philippine bank: what the HRIS holds for those payees is an email + account holder,
and only **29 of 216** higlobe-routed people have a bank name on file at all
(hurupay: 45 of 697). Those few are leftovers from filling in every field, not the
payout destination. Wise is the opposite case and sits on the **bank** side, per §7.

`isWalletRail` derives from the requirement rather than being listed separately, so
the family split and the caption can never drift apart.

**An unrouted person is never counted as payable**, whatever they carry: Payment
Dispatch excludes them outright, so folding them in would inflate card 2 with rows
nobody can pay.

### 10.3 Roster-scoped, never feed-scoped

Both cards fold from `PeopleSummary.railMix`, built inside `buildPeopleRoster` from
the **very `processor` / `hasBanking` pair each roster row already carries**. No
second resolution exists to drift from the chips.

It is **not** computed from the change feed, for two independent reasons:

1. `bank_update_history.processor` stores **`preferred_processor`**
   ([`save/route.ts`](../../app/api/bank-update/save/route.ts)), i.e. the employee's
   *receive election*. That is NOT the send-from rail, so it may never feed a card
   labelled "send-from".
2. The feed is a capped, newest-first slice (`?limit=80`). Counting it would be a
   sample wearing a KPI's clothes.

The band describes the whole roster (or one department); the feed below describes
recent edits. **Every card prints its own denominator** so the two are never read as
one number.

### 10.4 Which rails get a row

`railRows` decides, and the rule is not "the enum":

- **any rail somebody is actually on**, retired or not. Wise and Jeeves are retired
  from the pickers yet carry 386 and 3 live payees; a rail with people on it must
  never be missing from Accounting's view.
- plus every **still-offered** rail at zero (muted), because "Kolan: 0" is a real
  answer and an absent row is indistinguishable from a forgotten one.
- a rail that is **both retired and empty** is dropped. That is Wepay today (Kane,
  2026-08-19: *let us remove We Pay*), and it is dropped **by rule, not by name**:
  the row returns by itself the moment one payee lands on it, so no hand-kept
  exclusion list can go stale. Pinned by four tests.

### 10.5 Department filter

Beside the search: a department picker that scopes **both** the feed and the band.
Three properties, all load-bearing:

- **It re-scopes the band, not just the list.** `PeopleSummary.railMixByDept` folds
  the same people once per department server-side, so a filtered band shows that
  department's real mix rather than org-wide figures beside a filtered list. Both
  card labels print the department name when scoped, because a scoped figure that
  looks org-wide is the one way this band could mislead. Department folds sum back to
  the org-wide fold across every field, asserted by test.
- **A filter never hides a row** (the rule [[dispatch-log-department-filter]] set):
  a change row whose payee is off the active roster resolves to no department,
  renders a dash, and lives under a **"No department"** option that appears whenever
  any row needs it. The selection falls back to *All departments* if the chosen one
  leaves the option set.
- **Options come from the ROSTER, not the feed**, so a department with no recent bank
  changes is still reachable for its mix; the empty feed then says so and points at
  the cards.

The email→department map is built over **work, personal and every alternate work
email** (first write wins), because a bank change can be recorded against any address
a person is known by, the same reason the dispatch log's `deptByEmail` indexes more
than one.

### 10.6 Width and the shared card shell

The whole view sits in `max-w-[1600px]`, the app's wide-content container
(`Overview.tsx`, `AdminCsvImports.tsx`), not the 3xl column it first shipped in
(Kane: *make this wider... utilize the space properly*). The band is two cards at
`lg:grid-cols-2`; each row is name / share bar / count / percentage on one line, so
the bar absorbs the extra width instead of whitespace doing it. Above `lg` a feed row
splits identity and change-summary into two columns for the same reason.

`TONES` / `KpiLabel` / `StatCard` / `StatValue` / `StatSub` moved out of
`PaymentCatalogOverview.tsx` into
[`kpi-stat-card.tsx`](../../src/components/accounting/kpi-stat-card.tsx) and both
bands import them, the same extraction `hero-stat-row.tsx` got for the CEO System
Overview. Payment Catalog renders byte-identically to before. **Never fork a copy
back into a dashboard.**

## Migrations

DDL has **no path from the dev environment** — run these in the **Supabase SQL
editor**:

| File | State | Effect |
|---|---|---|
| `references/sql/alter/2026-07-22_add_bank_preferred_to_employee_ids.sql` | applied (column pre-existed; adds CHECK) | the `bank_preferred` column + constraint |
| `references/sql/create/bank_preferred_change_requests.sql` | applied (verified present) | the approval-gate requests table |
| `references/sql/alter/2026-07-22_employee_notifications_add_bank_preferred_type.sql` | **APPLIED** (verified 2026-08-11 — a `bank_preferred.decided` row exists) | allows `bank_preferred.decided` |
| `references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql` | **UNVERIFIED** — a CHECK constraint's allowed values are not readable through PostgREST, and no `people.banking.overridden` row exists yet, which proves nothing either way | allows `people.banking.overridden`; if it has NOT run, the Mark Paid override notification no-ops (the override itself works) |

Both notification migrations restate the **full** `employee_notifications.type`
CHECK list and append the new type — never hand-pick a subset (a subset silently
breaks other notification inserts).

## Key files

| Path | Purpose |
|---|---|
| `src/lib/employee-payment-processors.ts` | `BANK_PREFERRED_OPTIONS`, `isWiresPreferred`, `isBankPreferredTransitionAllowed` (+ tests) |
| `src/lib/supabase/bank-preferred-requests.ts` | approval-gate data layer |
| `app/api/update-employee-ids/route.ts` | `interceptBankPreferred` (fail-closed) |
| `app/api/bank-preferred-requests/route.ts` + `[id]/route.ts` | list / approve / deny |
| `src/components/payroll/BankPreferredApprovals.tsx` | Issues-tab approval UI |
| `src/lib/supabase/employee-ids.ts` | `EmployeeIdRow` + select strings (must list `bank_preferred`) |
| `app/api/payment-dispatch/bank-override/route.ts` | Mark Paid receiving-detail override |
| `src/lib/payroll/bank-override-mapping.ts` | slot-aware override column mapping (+ tests) |
| `src/lib/payroll/{mock-queue,pay-schedule,dispatch-export-csv}.ts` | routing-precedence resolvers |
| `src/lib/employee/payout-completeness.ts` | shared effective-processor + payable resolution (+ tests) |
| `src/lib/people/{people-roster,people-banking}.ts` + `src/components/people/PeopleTab.tsx` | People-tab parity surfaces (§8) |
| `scripts/audit-people-vs-dispatch-banks.mjs` | read-only People↔PD parity guard |
| `src/lib/people/rail-mix.ts` (+ test) | send-from / payable-per-rail aggregate behind the KPI band (§10) |
| `src/components/people/rail-mix-band.tsx` | the two KPI cards above the Bank changes feed (§10) |
| `src/components/accounting/kpi-stat-card.tsx` | shared gradient KPI card — Payment Catalog + Bank changes (§10.4) |

See also: [payment-dispatch.md](./payment-dispatch.md) (the queue this routing
feeds), and the session log
[audit-2026-07-23-session-log.md](../audits/audit-2026-07-23-session-log.md).
