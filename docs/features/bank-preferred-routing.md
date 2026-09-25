# Bank Preferred — send-from routing (Accounting-only) & the 1:1 rule

*Shipped 2026-07-22; Wise updates + the No-Bank clobber discovery added
2026-07-25 (§7); People-tab parity + Accounting direct-edit added 2026-08-10
(§8). Migration status re-verified against production 2026-08-11 — see
[Migrations](#migrations). Bank changes KPI band added 2026-08-19 (§10) — rail-shaped, no bank names; feed bank-type filter added 2026-09-25 (§10.7).
Employee Profile dropdown moved onto the EFFECTIVE rail 2026-08-31 AM (§1). **2026-08-31 PM
(Kane): the stored-transition WIRES lock and the same-morning receiving gate were BOTH
superseded by the 1:1 rule (§4)** — the RECEIVING bank drives the send-from rail, the wallet
coupling is two-way, and Wise as a send-from is Accounting-only. **2026-09-24 (Kane): the
employee's own sending-bank pick and its Accounting → Issues approval gate were RETIRED —
every sending-bank change is Accounting's, made in People → Banking (§1, §3), and an
employee's receiving move no longer files or writes one (§4.1).***

"Bank Preferred" is the processor **Accounting sends a salary OUT on** — the
*send-from rail*. It is a first-class field that wins Payment Dispatch's
processor-routing precedence, is **set by Accounting alone** — in People →
Banking; no employee surface can change it (Kane, 2026-09-24: *"all changes for
the sending bank should be here only in accounting and accounting will the only
one who will be responsible for changing it"*) — and is constrained by the
**1:1 rule** (§4): the send-from rail must agree with the employee's RECEIVING
bank — a Kolan/HiGlobe receiver is paid from that same wallet, and a bank
receiver is never paid from a wallet.

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
> The **Disbursement** picker and Bank Preferred are deliberately coupled for
> the two **wallet** rails — and as of **2026-08-31 PM (Kane) the coupling is
> TWO-WAY, "1 to 1"**. Kolan and HiGlobe pay *into* the same wallet they send
> *from*, so the pair can only ever be that wallet on both sides:
>
> - **Bank Preferred → Disbursement** (2026-08-24): setting the send-from to a
>   wallet sets the receiving channel to match — `mirroredDisbursementFor()`.
> - **Disbursement → Bank Preferred** (2026-08-31 PM): setting the RECEIVING
>   bank to a wallet pins the send-from to the same wallet — "they cannot
>   receive from an x1153 or Wise if they have HiGlobe or Kolan" —
>   `mirroredBankPreferredFor()`. **This mirror runs ONLY where Accounting sets
>   the sending bank** — People → Banking, where it applies immediately (§8).
>   **An employee's own save never moves the sending bank** (Kane, 2026-09-24,
>   resolution (b) of that day's hardening brief): the dashboard and the OTP
>   page change the receiving channel only, and a save that leaves an
>   Accounting-set sending bank out of step is NAMED in Accounting's "Bank
>   details updated" alert (`sendFromMismatch`, §4.1) for Accounting to fix.
>   From 2026-08-31 PM to 2026-09-24 the dashboard save instead FILED the
>   matching change through the §3 approval gate, now retired.
>
> Wise / Jeeves / Wires impose nothing in either direction and remain fully
> independent, which is what the original 2026-07-22 decoupling protected. (The
> first build wired both fields to one column so changing either flipped the
> other — that was a bug, and the mirrors are NOT it: they couple the two wallet
> rails only, by rule, in code.) Neither mirror ever touches the RECEIVING
> ACCOUNT columns.

---

## 1. Who sets it: Accounting only (People → Banking)

**The sending bank is changed in exactly one place:** the *Bank Preferred
(send-from)* dropdown in Accounting → People → View → Banking, saved through
`PATCH /api/people/[email]/banking` (§8) — plus the Payroll Notes → Offboarded
override, which rides that same route. Kane, 2026-09-24: *"let us deprecate the
feature that the Employee can choose a sending bank and that it would pop up in
accounting under the issues Section - all changes for the sending bank should be
here only in accounting and accounting will the only one who will be responsible
for changing it"*.

Options and their stored processor ids come from `BANK_PREFERRED_OPTIONS` in
[`src/lib/employee-payment-processors.ts`](../../src/lib/employee-payment-processors.ts):
HiGlobe / Kolan / Jeeves / Wise / **x1153**.

- **`x1153` → `wires`.** `x1153` is a specific wire account, not a distinct
  processor, so it maps to the `wires` processor id. Because there is no separate
  non-x1153 `wires` option, a saved `wires` value **displays as "x1153"**.
- **Which options Accounting sees is the 1:1 rule (§4), keyed on the receiving
  channel in the same form.** `selectableBankPreferredOptions(receiving,
  'accounting')` is the one narrowing point: a wallet receiver gets exactly their
  wallet (the send-from is pinned), a bank-rail receiver the bank options, no
  receiving channel everything.
- `EmployeeIdRow` and both `.select(cols)` strings in
  [`src/lib/supabase/employee-ids.ts`](../../src/lib/supabase/employee-ids.ts)
  must list `bank_preferred`, or reads return `undefined`.

**The employee's own dropdown (Employee → Profile → Compensation → Payout) was
RETIRED 2026-09-24**, with its "Pending approval" badge and the §3 gate it filed
into. What the employee has instead:

- **A read-only view.** The payout card's **"Paid via X"** line is the
  server-resolved EFFECTIVE rail (`walletRail.effectiveRail` on
  `GET /api/employee-ids?email=`, all three tiers) — how Accounting actually pays
  them. It was already there; the retired dropdown's "defaulted to what they are"
  display (2026-08-31) had used the same value.
- **No write path.** The payout save sends the receiving channel and details
  only. `POST /api/update-employee-ids` refuses a posted CHANGE to
  `bank_preferred` with a **403** ("The sending bank can only be changed by
  Accounting, in People → Banking…") for every caller, self-service and staff
  alike; a page opened before the retirement still posts the UNCHANGED stored
  value, which `isBankPreferredChange` treats as a no-op so that save still
  lands. The check reads the live value and **fails closed** (503 on a read
  error, nothing saved). The OTP page's route never accepted the field.
- **Pinned** by `src/lib/employee/send-from-accounting-only.test.ts` (no body
  key, no picker, no badge read, no allowlist entry, no Issues row kind, the
  routes deleted — and People → Banking still accepting it), which scans code
  with comments stripped so the tombstones naming the retired pieces stay
  greppable.

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
> itself. No interaction with the 1:1 rule (§4), which constrains *stored*
> values, not the per-week reroute. Detail:
> [payment-dispatch.md §12.3.1](./payment-dispatch.md#1231-sub-₱7k-wires--wise-temporary-weekly-reroute-2026-07-29).

> **Known gap (accepted, awaiting a product call):** the All-Dept rates sheet
> writes free-text "Bank Preferred" into the lowest-precedence
> `employee_hourly_rates."Bank Preferred"` column
> ([`rates-upload-db.ts`](../../src/lib/supabase/rates-upload-db.ts)). For a
> person whose `bank_preferred` **and** `preferred_processor` are both null, a
> sheet cell saying "Hurupay" still routes them to Hurupay — a bulk write into
> the routing precedence that bypasses every picker and the §4 mirrors. Needs a
> ticket or an explicit "accepted".

## 3. Accounting approval gate — RETIRED 2026-09-24

**There is no employee approval flow for the sending bank.** Kane retired it on
2026-09-24 together with the employee's pick (§1): Accounting sets the sending
bank directly in People → Banking, where its edit has always been the approval
(§8), and nothing reaches Accounting → Issues any more.

**What it was (2026-07-22 → 2026-09-24).** An employee's Bank Preferred change,
and from 2026-08-31 PM also the 1:1 mirror of a wallet receiving move, was held
as a `pending` row in `bank_preferred_change_requests` by `interceptBankPreferred`
in `update-employee-ids` (fail-closed, one pending per employee), and Accounting
approved or denied it as a row in the Issues table (2026-09-01 onwards, with
editable and deletable decided rows). Design:
[2026-07-22-bank-preferred-approval-gate-design.md](../superpowers/specs/2026-07-22-bank-preferred-approval-gate-design.md);
the full mechanics are in git history. It was barely used: **8 requests in two
months** (2 approved, 1 denied, 3 superseded, 2 pending), measured read-only on
the retirement day.

**Removed:** the intercept and its "Bank Preferred change needs approval"
reviewer notification · `GET /api/bank-preferred-requests` and
`PATCH`/`DELETE /api/bank-preferred-requests/[id]` · the data layer
`src/lib/supabase/bank-preferred-requests.ts` · the Issues table's bank row kind,
its View / Deny / Edit / Delete dialogs, its KPI counts and the
`bankPreferredRequests` tab-cache key · the employee's "Pending approval" badge
and its read.

**Kept, deliberately:**
- the `bank_preferred_change_requests` **table and its 8 rows** — no DDL was run.
  Nothing reads or writes it now. **The 2 rows still `pending` at retirement**
  are both `none → wallet`, filed by the mirror for payees already receiving
  on, and paid via, that wallet (tier 1 NULL, tier 2 the wallet), so leaving
  them undecided moves no money. If they are not decided in Issues before the
  retirement deploys, they stay behind as inert records.
- the `bank_preferred.decided` notification type in the CHECK (old rows still
  render) and the `bank_preferred.request.*` audit events (still readable in the
  audit log and by Admin Penny's bank filter).
- the approvals' own history: every applied approval also wrote
  `bank_update_history` (`via: accounting_approval` / `accounting_edit`), so it
  still shows in People → Bank changes.

## 4. The 1:1 rule (supersedes the WIRES lock, 2026-08-31 PM)

**The RECEIVING bank drives the send-from rail** (Kane): a **Kolan/HiGlobe
receiver is paid from that same wallet — 1 to 1** — and a **bank receiver is
never paid from a wallet**. "They cannot receive from an x1153 or Wise if they
have HiGlobe or Kolan."

Single source of truth, pure and unit-tested, in
[`src/lib/employee-payment-processors.ts`](../../src/lib/employee-payment-processors.ts):

```ts
isBankPreferredAllowedForReceiving(receiving, next)
  // wallet receiving  ⇒ next must be THAT wallet (or unset)
  // bank receiving    ⇒ next must not be a wallet
  // no receiving      ⇒ anything (the forward mirror completes the 1:1 pair)
  // clearing (next unset) is always allowed — routing falls to tier 2
mirroredBankPreferredFor(receiving)   // wallet receiving pins the send-from
mirroredDisbursementFor(bankPreferred) // wallet send-from pins the receiving
walletFromReceiving(receiving)        // kolan-alias- and case-tolerant
```

**The verdict is STATELESS** — judged against the live receiving channel on
every write, never against transition history. That is why
`isBankPreferredTransitionAllowed` (the stored-transition WIRES lock, 2026-07-22
→ 2026-08-31) was **removed**, not adapted: with no stored-transition semantics
there is no clear-then-set laundering walk to defend, and its laundering guard,
its `null`-handling subtleties, and its five-site enforcement table went with
it. Do not reintroduce a transition-history guard.

Compared to the old lock, the rule is **tighter in one direction and looser in
the other, both deliberately**:

- Tighter: **wallet → wires is gone.** A wallet receiver can never be pointed at
  x1153/Wise/Jeeves without changing the receiving bank in the same save. The
  old lock allowed `anything → wires`.
- Looser: a payee who genuinely moves their RECEIVING bank onto a wallet is no
  longer barred from a matching send-from — under the old lock a wires-history
  payee could never reach Kolan at all. The old lock's protective content — "you
  cannot pay a wire recipient into a wallet" — survives receiving-keyed: it is
  exactly the "bank receiver never sends from a wallet" half.

**Every send-from is Accounting-only since 2026-09-24** (Kane — §1). Wise was
the first (the same 2026-08-31 PM ruling): employees never got Wise as a new
Bank Preferred pick — `selectableBankPreferredOptions(receiving, 'employee')`
excludes it for every receiving value, still pinned by test though the
`'employee'` audience has had no caller since the employee dropdown was retired
— and the employee Disbursement radios no longer offer Wise for new picks either
(`SELECTABLE_PROCESSOR_OPTIONS`; a stored Wise stays visible as the current
selection). Accounting sets every sending bank, Wise included, in People →
Banking, which uses the `'accounting'` audience. The radios' Wise change
reversed the 2026-07-25 employee-picker Wise exception for the employee surfaces
only; `EMPLOYEE_SELECTABLE_PROCESSOR_OPTIONS` is untouched for Accounting's
Readiness "Set bank" editor.

**Where the rule is enforced, and where it is only reported.** The 1:1 verdict
is ENFORCED where a sending bank is set — People → Banking. The receiving
channel is the employee's own data, so a self-service save that leaves the
Accounting-set sending bank out of step is NOT refused: it lands, and
`sendFromMismatch(receiving, sendFrom)` (the same verdict, pure and tested)
names the mismatch in Accounting's "Bank details updated" alert —
title *"Bank details updated — sending bank no longer matches"*, message ending
*"Their sending bank is x1153, which does not match their receiving bank
(Kolan). Change it in People → Banking."*, `details.send_from_mismatch` — on
both the dashboard route and the OTP page's route. Same
`people.banking.self_updated` type and `neutral` tone: the notifications CHECK
allows only `positive`/`neutral`, and a new type or tone is rejected silently.
No sending bank set (tier 1 NULL, 2,052 of 2,198 rows on 2026-09-24) is never a
mismatch — routing tier 2 then follows the receiving pick.

### 4.1 Enforcement sites

| Site | Behavior |
|---|---|
| People → Banking save (`PATCH /api/people/[email]/banking`) | **the one write path.** 1:1 check → **400**, then BOTH mirrors apply **immediately** (§8) |
| Payroll Notes → Offboarded override | rides the People → Banking PATCH (§8) — same gate, same 1:1 re-check |
| `update-employee-ids` (Employee dashboard save; Readiness / People → Offboarded "Set bank" default mode) | `bank_preferred` is not on the write allowlist; a posted CHANGE → **403**, an unchanged stale value is a no-op, an unreadable stored value → **503** (fails closed). Never mirrors. Reports a mismatch in the reviewer alert (`sendFromMismatch`) |
| `bank-update/save` (the OTP `/update-bank-info` page) | never accepted `bank_preferred`. Reports a mismatch in the reviewer alert, same helper and wording |
| Employee Profile UI | no sending-bank control (retired 2026-09-24); the radios write the receiving channel only; "Paid via X" on the payout card is read-only |

Retired with §3 on 2026-09-24: the `update-employee-ids` 1:1 pre-filter and
server-side mirror (which FILED requests), the approval PATCH's live 1:1
re-check, and the Issues-table rows' advisory rail-change note.

### 4.2 History

- **2026-07-22** — WIRES lock shipped: `bank_preferred` anything-but-wallet ⇒
  never movable to Kolan/HiGlobe; unset counted as locked.
- **2026-08-24** — `null` narrowed to "assignable" (`isWalletRailLocked` split
  from `isWiresPreferred`); the lock re-keyed to the EFFECTIVE rail via
  `resolveWalletRailLock()` (all three tiers, fails closed); Kolan rebrand
  aliased. `resolveWalletRailLock` **still exists** — it feeds the §1 display
  default and the People-tab "Pays via" resolution — it just no longer gates
  writes.
- **2026-08-31 AM** — the Employee Profile dropdown moved from a tier-1 read to
  the effective rail (920 tier-2 wallet payees could not see their own rail);
  a receiving-side gate (`checkDisbursementWalletMove`) briefly closed the
  "ungated tier-2 rail switch" hole.
- **2026-08-31 PM** — Kane's 1:1 ruling replaced both: the tier-2 "hole" — a
  receiving pick re-routes pay — is now the **mechanism**, made safe by the
  two-way mirror and the stateless rule above. The receiving gate and the
  transition guard were removed.
- **2026-09-24** — Kane retired the employee's sending-bank pick and the §3
  Issues approval gate: *"all changes for the sending bank should be here only
  in accounting"*. The hardening brief (session `5dbbfa67`) stopped on one
  conflict, whether the employee-side receiving→wallet pin survives, and Kane
  chose **(b)**: it becomes Accounting's job. So the reverse mirror now runs
  only in People → Banking, and a self-service mismatch is reported to
  Accounting instead of filed. The tier-2 mechanism is untouched: for a payee
  with no Accounting-set sending bank, the receiving pick still routes them (a
  Kolan receiver is paid via Kolan, a Wires receiver via x1153). That is the 1:1
  default, not a send-from choice.

> **Known data debt — MEASURED 2026-09-24, OPEN:** rows can violate 1:1 — e.g.
> tier 1 `wise` with tier 2 `hurupay` (tier 1 wins, so they are PAID via Wise
> while electing to receive on Kolan). The read-only population audit
> (predicate `!isBankPreferredAllowedForReceiving(preferred_processor,
> bank_preferred)` over all 2,198 `employee_ids` rows) found **13, 7 of them on
> the active roster**: 5 sent by wire (x1153) while electing a wallet (4 Kolan,
> 1 HiGlobe), 1 sent from HiGlobe while electing Kolan, 1 sent from Kolan while
> electing wires; the 6 inactive are 3 wire/Wise-sent Kolan electors and 3
> Kolan-sent bank electors. Origin per row not traced, and not cross-checked
> against what Payment Dispatch last paid them. **Not fixed**: correcting tier 1
> is a data write (Kane's call), and any People → Banking save of the row heals
> it through the mirrors. Session-log item 202.
>
> **By design since 2026-09-24, no longer a gap:** neither self-service path
> writes tier 1. The dashboard and the OTP page (`/update-bank-info`) both change
> only `preferred_processor`, so a tier-1-set payee who moves their receiving
> bank keeps Accounting's sending bank until Accounting changes it — and the
> "Bank details updated" alert now says so (§4). (Before that date the OTP
> page's behaviour was logged here as OPEN, because the dashboard filed a mirror
> request and the OTP page did not.)

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
- **Accounting direct-edit — since 2026-09-24 the ONLY way a sending bank
  changes.** The People banking editor offers a *Bank Preferred (send-from)*
  dropdown. `PATCH /api/people/[email]/banking` accepts `bank_preferred`
  directly — it is gated to Accounting's `people` feature, so the edit *is*
  the decision; there is no request to file (the employee §3 gate it once sat
  beside is retired). The **1:1 rule (§4) applies**, enforced server-side
  against the receiving channel the save leaves in place, and mirrored in the
  dropdown's option pinning.
- **Payroll Notes → Offboarded "Set bank" rides this same route (2026-09-15).**
  A leaver has nobody left to file a request, so the Offboarded tab's dialog is
  mounted in override mode: rail unlocked, and the save is a
  `PATCH /api/people/[email]/banking` with **both** `preferred_processor` and
  `bank_preferred` pinned to the chosen rail (equal values are always legal under
  §4) plus only the typed details, and `preferred_bank_slot: 'primary'` when a
  primary wire field was typed. Same gate, same 423 under the dispatch lock, same
  1:1 re-check. The PATCH accepts an optional `source` (one of the known
  `CHANGE_SOURCES`, default `people_tab`) so the audit row reads `via
  payroll_wizard_readiness`. The Readiness **Bank Info** fixer (default-mode
  "Set bank", on `update-employee-ids`) writes the receiving channel only and
  never `bank_preferred`; since 2026-09-24 a wallet pick there no longer files a
  mirrored sending-bank request either (for its only case, a person with no
  rail at all, tier 2 then routes them onto that wallet anyway).

Parity is pinned by `src/lib/employee/payout-completeness.test.ts` and the
audit script's post-fix run: **0 disagreements across 1,498 active people**.

> **History (2026-08-31 AM, superseded the same day):** the picker's option
> filter briefly failed OPEN — it read
> `isWalletRailLocked(banking?.effective_processor ?? null)`, and `banking` is
> `null` while loading, on a failed fetch, AND for "no row, no rail", so a
> hiccuped read offered a wire-only payee the wallet rails. A `bankingResolved`
> flag (still returned by `GET /api/people/[email]` — `bankErr == null`, since
> the combined `error` field is poisoned by history failures) fed a fail-closed
> verdict for a few hours. Under the 1:1 rule the options key off the FORM's own
> receiving field (local state, no fetch race) and the save re-checks
> server-side, so the picker no longer consumes the flag; it remains as honest
> metadata distinguishing "read failed" from "person has nothing".

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
  lock (it writes the send-from rail; every direct-edit path already did). *(The
  approval path itself was retired 2026-09-24, §3; People → Banking keeps its
  423 under the lock.)*
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

### 10.7 Bank-type filter (2026-09-25)

A third control beside search and department: **All bank types / Kolan / Higlobe /
Wise / Jeeves / Wires / …**, in
[`PeopleBankChanges.tsx`](../../src/components/people/PeopleBankChanges.tsx), with the
bucketing pure in [`bank-change-type.ts`](../../src/lib/people/bank-change-type.ts)
(8 `node:test` cases).

- **It scopes the FEED only, never the band.** The bucket is the change row's own
  `bank_update_history.processor`, which §10.3 establishes is the **receive election**
  for every self-service and People → Banking write. Letting it re-scope the
  send-from cards would be the exact conflation §10.3 forbids. The control's tooltip
  says so, and the band follows the department filter alone.
- **`mark_paid_override` rows are the exception**: their `processor` is the rail the
  payment was being marked paid on
  ([`bank-override/route.ts`](../../app/api/payment-dispatch/bank-override/route.ts)),
  not an election. They bucket under that rail.
- **A filter never hides a row (§10.5).** Values normalise through
  `processorIdFromBankPreferredText`, so `kolan` joins `hurupay` and `x1153` joins
  `wires`. A blank processor gets a **"No bank type recorded"** bucket (71 of 1,604
  history rows, 1 in the newest 80, measured 2026-09-25), and text no resolver
  recognises buckets under its own spelling. Pinned by test: every row's bucket is
  an offered option.
- **Options come from the FEED, not the roster**, unlike departments: the band does
  not follow this filter, so an option with no rows would only ever show an empty
  list. The selection falls back to *All bank types* when its last row ages out of
  the capped feed.
- Labels are the post-rebrand processor labels, so the row chip, which printed the
  raw stored id ("hurupay"), now reads **Kolan**, matching the filter. Search also
  matches the label.

Live mix, 2026-09-25, all 1,604 history rows: `wires 662 · hurupay 342 · higlobe 307 ·
wise 221 · null 71 · jeeves 1`; newest 80 (what the feed loads): `wires 29 · wise 21 ·
higlobe 16 · hurupay 13 · null 1`.

## Migrations

DDL has **no path from the dev environment** — run these in the **Supabase SQL
editor**:

| File | State | Effect |
|---|---|---|
| `references/sql/alter/2026-07-22_add_bank_preferred_to_employee_ids.sql` | applied (column pre-existed; adds CHECK) | the `bank_preferred` column + constraint |
| `references/sql/create/bank_preferred_change_requests.sql` | applied (verified present) | the approval-gate requests table. **Retained** after the gate's 2026-09-24 retirement (§3): 8 rows, nothing reads or writes it, no DDL was run |
| `references/sql/alter/2026-07-22_employee_notifications_add_bank_preferred_type.sql` | **APPLIED** (verified 2026-08-11 — a `bank_preferred.decided` row exists) | allows `bank_preferred.decided` — no longer emitted since 2026-09-24; kept so old rows stay valid |
| `references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql` | **UNVERIFIED** — a CHECK constraint's allowed values are not readable through PostgREST, and no `people.banking.overridden` row exists yet, which proves nothing either way | allows `people.banking.overridden`; if it has NOT run, the Mark Paid override notification no-ops (the override itself works) |

Both notification migrations restate the **full** `employee_notifications.type`
CHECK list and append the new type — never hand-pick a subset (a subset silently
breaks other notification inserts).

## Key files

| Path | Purpose |
|---|---|
| `src/lib/employee-payment-processors.ts` | `BANK_PREFERRED_OPTIONS`, `isWiresPreferred`, `isBankPreferredAllowedForReceiving`, both mirrors, `selectableBankPreferredOptions`, and since 2026-09-24 `isBankPreferredChange` (the self-service refusal's verdict) + `sendFromMismatch` / `sendFromMismatchSentence` (the alert line) (+ tests) |
| `app/api/people/[email]/banking/route.ts` | **the one sending-bank write path** — 1:1 check, both mirrors (§8) |
| `app/api/update-employee-ids/route.ts` | receiving-details save (dashboard + default-mode Set bank): refuses a `bank_preferred` change (403), reports a 1:1 mismatch in the reviewer alert |
| `app/api/bank-update/save/route.ts` | the OTP page's save — receiving only, same mismatch alert |
| `src/lib/employee/send-from-accounting-only.test.ts` | pins the 2026-09-24 retirement at the source (no employee write path, no Issues bank rows, routes gone, People → Banking still the path) |
| `src/lib/supabase/employee-ids.ts` | `EmployeeIdRow` + select strings (must list `bank_preferred`) |
| *(deleted 2026-09-24)* `src/lib/supabase/bank-preferred-requests.ts` · `app/api/bank-preferred-requests/route.ts` + `[id]/route.ts` | the retired approval gate's data layer and list / approve / deny / delete routes (§3) |
| `app/api/payment-dispatch/bank-override/route.ts` | Mark Paid receiving-detail override |
| `src/lib/payroll/bank-override-mapping.ts` | slot-aware override column mapping (+ tests) |
| `src/lib/payroll/{mock-queue,pay-schedule,dispatch-export-csv}.ts` | routing-precedence resolvers |
| `src/lib/employee/payout-completeness.ts` | shared effective-processor + payable resolution (+ tests) |
| `src/lib/people/{people-roster,people-banking}.ts` + `src/components/people/PeopleTab.tsx` | People-tab parity surfaces (§8) |
| `scripts/audit-people-vs-dispatch-banks.mjs` | read-only People↔PD parity guard |
| `src/lib/people/rail-mix.ts` (+ test) | send-from / payable-per-rail aggregate behind the KPI band (§10) |
| `src/components/people/rail-mix-band.tsx` | the two KPI cards above the Bank changes feed (§10) |
| `src/components/people/PeopleBankChanges.tsx` | the Bank changes view: band + live feed, department and bank-type filters (§10.5, §10.7) |
| `src/lib/people/bank-change-type.ts` (+ test) | feed-only bank-type buckets; a filter never hides a row (§10.7) |
| `src/components/accounting/kpi-stat-card.tsx` | shared gradient KPI card — Payment Catalog + Bank changes (§10.4) |

See also: [payment-dispatch.md](./payment-dispatch.md) (the queue this routing
feeds), and the session log
[audit-2026-07-23-session-log.md](../audits/audit-2026-07-23-session-log.md).
