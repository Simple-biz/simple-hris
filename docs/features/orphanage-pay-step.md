# Orphanage pay — Payroll Wizard step 3

> The **pay** half of the orphanage feature. The **PAB forgiveness** half — the same
> hours excusing short workdays — is a separate, independently-removable rule in
> [orphanage-pab-coverage.md](./orphanage-pab-coverage.md). This document is about money.
>
> Before 2026-08-21 the pricing rule lived only in a code comment and a SQL header,
> and no test covered it. That is how a half-paying OT rate shipped for a week
> without anything on screen saying so. See [The 2026-08 incident](#the-2026-08-incident).

## What the step does

Accounting pastes three columns straight from the NPD sheet —
**Pay week ⇥ Work email ⇥ Hours** — and locks in. Each row resolves to an employee
in this pay period and to a PHP amount, which lands on the per-employee **Orphanage**
column of the Additions tab and from there into **Final pay**
([payroll-wizard-final-pay.md:217](./payroll-wizard-final-pay.md)) and onto its own
paystub line.

The pay-week column is **informational only**: every matched row applies to the period
being edited. Matching is by work email, case-insensitive, bridged through the master
list so an alternate / personal / Hubstaff address still finds the person's row.

## The pricing rule

**One implementation:** `src/lib/payroll/orphanage-pay-pricing.ts`
(tests: `orphanage-pay-pricing.test.ts`). Both the paste tool and the re-price action
call `priceOrphanageHours`, so a repair and a fresh paste cannot produce different money.

```
regular capacity left = max(0, 40 − hours already worked this pay week)
regular leg           = min(pasted hours, capacity left)
overtime leg          = pasted hours − regular leg
amount                = regular leg × regular rate  +  overtime leg × OT rate
```

| Rule | Why |
|---|---|
| **Orphanage OT prices at the FULL 1.5× rate, never the weekly 0.5× differential** | Orphanage hours have **no base leg**. The Hogan weekly form pays 1.0× on every hour including overtime and then tops up 0.5× ([hsl-weekend-ot-pay.md](./hsl-weekend-ot-pay.md)); there is no such base under an orphanage hour, so the differential pays a third of it. Kane 2026-08-18. |
| On HSL sheet-form rows the OT rate is **derived** as `round2(regular × 1.5)` | `CalcRow.otRate` on those rows IS the 0.5× differential — that is what it is *for* in the weekly form. Deriving removes the whole failure mode rather than trusting a field. |
| Every other row keeps its **stored** OT rate | A department may have negotiated something other than 1.5×, and this module does not overrule a real rate. |
| …but an OT rate **below the regular rate is REFUSED**, never substituted | Below-regular is the shape of a differential, not a rate. Refusing reports that the row's rate data is wrong; quietly deriving 1.5× would hide it. The refusal blocks only that person's orphanage line, and the rest of the paste still locks in. |
| No regular rate, no OT rate when hours cross 40, negative or non-finite hours → **refused** | A row we cannot price is not worth a smaller number. It appears in the "skipped" list with what to fix. |
| Hours **stack against the 40h weekly cap**, honouring the global and per-department OT switches | Same switches as the Initial Calculation ([payroll-wizard-configuration-tab.md](./payroll-wizard-configuration-tab.md)). OT off for a department ⇒ every orphanage hour stays regular. |
| The regular leg rounds to **2dp hours** and each leg is priced then summed, on HSL sheet-form rows | The Hogan sheet is the payment authority and it multiplies 2-decimal hours; whole-precision math "is wrong by definition" ([hsl-weekend-ot-pay.md:17](./hsl-weekend-ot-pay.md)). This is what makes HRIS agree with the NPD sheet **to the centavo**. Non-HSL rows keep full-precision hours and one trailing round — unchanged. |
| The OT leg is the **remainder** (`hours − rounded regular leg`), not independently rounded | So the two legs still sum to the pasted hours exactly. |

Worked example (the incident row): 15.50 pasted hours, ₱355/h, 34.1986 h already worked.
Capacity left 5.8014 → **5.80** reg + **9.70** OT. `5.80 × 355 = ₱2,059.00` and
`9.70 × 532.50 = ₱5,165.25` ⇒ **₱7,224.25**, the sheet's figure. Priced at the ₱177.50
differential the same row gives ₱3,781.00, and on 4dp hours it gives ₱7,224.00.

## Two carriers, and which one pays

| Carrier | Holds | Role |
|---|---|---|
| `app_settings['payroll.wizard.additions.<source_file>']` → `orphanageAmounts` | email → PHP | **This is what pays.** Flows into `dispatchData`, the final-pay snapshot, the staged stub. |
| `orphanage_pay` (one row per `source_file` + `employee_email`) | hours, reg/OT split, both rates, the amount | The **first-class record**. What the money can be checked against. Also feeds PAB coverage. |

Consequences that have each cost money at least once:

- The `orphanage_pay` write on lock-in is **best-effort** (`console.warn` on failure) —
  by design, because the paying value is already saved. So a row can exist in one
  carrier and not the other.
- **A manual cell edit on the Additions tab writes only the blob.** There is no
  `orphanage_pay` row behind a hand-typed orphanage amount, so it cannot be
  reconciled or re-priced, and if it is lost there is nothing but `audit_log`
  (`action = wizard.addition_edited`, `resource = orphanage_pay`) to recover it from.
- The blob is saved as a **whole object**, and until 2026-09-01 that write was
  last-writer-wins: a save from a tab holding stale state reverted **every** person
  in it, not just the one being edited — which is how the 08-18 correction was rolled
  back, and how the 2026-08-23 week ended up with 44 recorded-hours rows paying ₱0
  (₱176,016.67). **Closed 2026-09-01 by compare-and-swap**: `saveAdditionsProgress`
  presents the `updated_at` it loaded to `/api/payroll-wizard/additions`
  (`casUpdateAppSetting`; `src/lib/payroll/wizard-additions.ts` + tests), a stale
  write gets a **409 and nothing lands**, and the generic `/api/app-settings` POST
  refuses the key family so no un-CAS'd writer remains. There is **no server-side
  merge on purpose** — the maps carry deletions, and a merge cannot tell a stale key
  from an edit, so it would resurrect removed money. On a 409 the wizard re-hydrates
  (`loadAdditionsProgress`), tells the clerk whose version now stands, and the clerk
  re-applies their last change and saves again. Never "fix" a 409 by dropping the CAS
  predicate. A side benefit: a revision the tab never loaded is presented as `null`
  (an INSERT), so a manual lock-in fired before hydration can no longer wipe an
  existing blob — previously only *silent* saves were gated on hydration.
- A failed or refused blob save now **aborts the rest of its action**: lock-in keeps
  the paste and writes no `orphanage_pay` records, Re-price/Restore re-syncs nothing,
  and Remove leaves the record row alone — a record write behind a save that never
  landed is how record↔column divergence gets minted client-side.

## Reconciliation (2026-08-21)

Every locked-in amount is checked against its own recorded hours and rates on every
render of the step, via `reconcileLockedOrphanageAmount`. It **never rewrites money**.

| Status | Meaning | Shown as |
|---|---|---|
| `ok` | The amount is what its hours × rates price to (±₱0.02, since rows predating the sheet-2dp basis can sit a centavo off per leg) | nothing |
| `ot_underpriced` | OT hours were priced below the regular rate — the differential bug | amber row chip + banner, with the shortfall and the rate it should be |
| `amount_mismatch` | The stored money disagrees with its own hours × rates | same |
| `unverifiable` | No `orphanage_pay` record — a hand-typed amount. **Not a pass.** | "no hours record — entered by hand" |

Nothing reconciles until the record fetch has resolved (`orphanageDetailLoadedFor`),
or every row would read `unverifiable` merely for want of data.

**Re-price** (banner, and per row) re-runs `priceOrphanageHours` over the recorded
hours with the row's live inputs, writes through `updateOrphanageAmount` (audited),
saves once for the whole batch, re-publishes the snapshot and re-syncs the record.
It is **human-initiated and never automatic**: a rate can legitimately change after
lock-in, and a step that re-prices the period on every render is a step that moves
money nobody asked it to move. A row whose live inputs still refuse to price is
reported, not skipped.

The reverse direction is surfaced too: hours on record with **no amount on the
Orphanage column** get their own red panel. That is what a clobbered save looks like
from here — the hours were locked in and the money vanished — and it is never hidden
by the search box. Since 2026-09-01 the panel carries **Restore from record**
(human-initiated, audited): it resolves each record email to this period's Additions
row (the blob keys on the row's literal `.email`; the record keys are lowercased) and
rides the same re-price path, so a restore, a re-price and a fresh paste all price
through `priceOrphanageHours`. Anyone it cannot price — no longer in the period, no
rate — is **reported, not skipped**. Before this, the only repair was re-pasting from
a sheet nobody may still have open.

**Fleet-wide detector:** `scripts/audit-orphanage-pay-divergence.mts` (read-only, no
`--apply`) runs the same reconciliation over every week's record against every week's
blob. It reports underpaid and overpaid **separately and never nets them**, because a
single netted figure is how a report claims a week is nearly fine while two people are
wrong. `--file <source_file>` scopes it; `--json <path>` writes the findings.

Its scope is deliberately **record vs column, and nothing else.** It does not judge
which carrier ends up pricing a row: the snapshot-vs-staged precedence needs the
Payment Catalog to evaluate, and an approximation of it produced two separate
six-figure false alarms (₱134k, then ₱183k) before being removed on 2026-08-21 — both
of them weeks where the money was fine. Use `scripts/verify-dispatch-carryover.mts`
for the carrier question, and unlock + re-lock after repairing amounts.

## Removing data & starting fresh (2026-09-01)

Kane's ask: deleting in this step must delete **everything**, so a bad paste can be
re-entered clean. Before this, a delete could leave either carrier behind — the
per-row record delete was silent best-effort (a failed DELETE left a phantom
"hours on record" row still feeding PAB coverage), and a record with no amount on
the column (a bad paste's residue) was **undeletable from the UI**; the only offer
was Restore, i.e. re-creating money nobody wanted.

Three delete paths now exist, all wizard-only (replay stays view-only), all scoped
strictly to the active `source_file`:

| Path | Clears | Audit |
|---|---|---|
| Per-row **Remove** (✕ on the locked-in list) | blob entry + its `orphanage_pay` row | client `wizard.addition_edited` + route `orphanage_pay.record_deleted` |
| **✕ on a red-panel row** (hours on record, no amount) | the record alone — no blob change exists to make | `orphanage_pay.record_deleted` |
| **Remove all…** (card header, confirm dialog) | every blob amount **and** every record for the period | ONE client `wizard.orphanage_period_cleared` carrying all cleared amounts + ONE route `orphanage_pay.period_cleared` carrying the full row snapshot |

Invariants these paths keep:

- **Blob first, records second, CAS throughout.** Remove-all clears the column via
  `saveAdditionsProgress({orphanageAmounts: {}})`; a refused save (409) aborts the
  record wipe, exactly like per-row Remove.
- **A record delete failure is SAID, never swallowed** — the per-row and bulk paths
  toast the failure and the leftovers land in the red panel, where they are now
  deletable individually.
- **Nothing is destroyed unsnapshotted.** Both DELETE shapes read the row(s) into
  the audit entry *before* deleting, with a paged read on the bulk path, and a
  failed snapshot read **refuses the delete** (fail closed). The bulk client entry
  carries every cleared blob amount because a hand-typed amount has no record —
  after erict@, `audit_log` must always be able to answer "what was there".
- **The route's period wipe needs the explicit `all=1` flag**; a missing `email`
  never silently widens to the period, and passing both is refused as ambiguous.
- Deleting hours **withdraws their PAB coverage** — every path refreshes the
  coverage index, and the confirm dialog says so.
- The wipe does not touch the "No orphanage hours this week" marker (deleting to
  re-paste is not a claim that there were no visits), and it does not re-stage
  locked stubs — unlock + re-lock stays the sanctioned push into a locked cycle.

## The 2026-08 incident

The sequence, because every step of it is a lesson the guards above encode:

1. **2026-08-11**, `e0028b8d` — HSL pay became the Hogan sheet's column AN verbatim,
   which set `CalcRow.otRate` to the derived 0.5× differential. The paste tool read
   that field directly, so from this commit orphanage OT half-paid on sheet-form rows.
   Nothing on screen changed.
2. **2026-08-17** — the week of 2026-08-09 was locked in under that code. 34 people.
3. **2026-08-18 16:13Z**, `41a21ae1` — the OT binding was fixed. **Already-locked rows
   were not re-priced**, because nothing had ever re-priced one.
4. **2026-08-18 16:22Z** — all 34 were re-pasted by hand and came out right.
5. **2026-08-18 16:31Z** — one manual cell edit from a tab holding pre-fix state wrote
   its whole `orphanageAmounts` map back over the correction. All 34 reverted.
6. **2026-08-21** — one person was found by eye (₱3,781.00 against the sheet's
   ₱7,224.25), deleted, and re-pasted. That fixed one row of nine.

First measured on `simple-biz_daily_report_2026-08-09_to_2026-08-15.csv`: **9 people
underpaid by ₱27,550.20** (of an original 14 / ₱45,460.79), caught before money moved —
no `payment_dispatches` rows, no stub sent. They were repaired by hand in the wizard
over the course of the afternoon and the detector now reports the week **clean, 34/34**.

Still outstanding on that week: **erict@ ₱5,373.00**, entered by hand twice and
clobbered twice. It is absent from the column *and* reads `orphanagePay: 0` in the
snapshot, and because a hand-typed amount writes no `orphanage_pay` row it is invisible
to the detector too. `audit_log` is the only place it survives.

The 2026-07-19 week separately holds **2 rows overpaid by ₱862.12 each** (cjm@, jamec@):
priced at a ₱350 regular rate where the record says ₱325. A rate disagreement, not this
bug, and that week is long paid.

What closed, and what proves it:

| Failure class | Closed by | Proof |
|---|---|---|
| Orphanage OT priced off the 0.5× differential | `priceOrphanageHours` derives 1.5× for sheet-form rows | test: the incident row prices to ₱7,224.25 |
| A differential reaching pricing by any other route | refusal when OT rate < regular rate | test: "3,781.00 is not producible" |
| HRIS disagreeing with the sheet on rounding | 2dp regular leg, OT leg as remainder, per-leg pricing | test: legs are 5.80 + 9.70, amount ₱7,224.25 |
| An amount trusted forever after lock-in | `reconcileLockedOrphanageAmount` on every render + the banner | tests: 5 status cases |
| A repair drifting from a re-paste | both go through `priceOrphanageHours` | test: "a repriced row and a fresh paste agree exactly" |
| A rateless / OT-rateless row priced low instead of refused | refusal codes `no_regular_rate` / `no_ot_rate` | tests |
| Hours on record with no money on the column | the red "no amount on the Orphanage column" panel, with **Restore from record** since 2026-09-01 | — |
| An orphanage edit rolled back by a hydration landing mid-edit | `updateOrphanageAmount` now bumps `additionsEditGenRef`, and the hydration merges `orphanageAmounts` freshest-wins like the bonus maps | — |
| A save from a stale tab reverting the whole map (step 5 of the incident) | CAS on `payroll.wizard.additions.*` — stale write → 409, nothing lands; generic route refuses the family (2026-09-01) | `wizard-additions.test.ts`; `casUpdateAppSetting`'s predicate |
| A manual lock-in before hydration wiping an existing blob | unknown revision ⇒ `expectedUpdatedAt: null` ⇒ INSERT ⇒ conflicts with any existing row | `casUpdateAppSetting` insert branch |
| Record writes / paste-clear / record-delete proceeding after a failed blob save | `saveAdditionsProgress` returns success; lock-in, Re-price/Restore and Remove abort downstream on failure | — |
| A past week silently wrong | `scripts/audit-orphanage-pay-divergence.mts` | run against prod, 2026-08-21 |

## UI

- **Paste data** + **Preview** are a two-up pair while the period has nothing locked
  in. Once amounts exist they fold into a slim bar — the locked-in list is the subject
  of the step by then. An explicit toggle wins until the next lock-in; a draft left in
  the textarea is never hidden silently, the collapsed bar reports its parse counts.
  240ms height/opacity, crossfade under `prefers-reduced-motion`.
- **Locked in this period** has a name/email search. Filtering is display-only and the
  footer stays the **period** total (labelled "Period total" while filtering), so a
  search can never make the money on this step look smaller than it is.
- **Remove all…** sits on the "Locked in this period" card header (hidden in replay
  and when the period is empty) and confirms through `OrphanageClearConfirmDialog`
  — an in-app dialog in the `PabDecisionConfirmDialog` vocabulary, never
  `window.confirm`; undismissable while the wipe is in flight.
- **"No orphanage hours this week"** is an explicit confirmation marker
  (`orphanageConfirmedSettingKey`), audited as `wizard.orphanage_none_confirmed`, so a
  week with no visits is distinguishable from a week nobody got to.
- Replay is view-only: no paste, no re-price, no remove.

## The 2026-08-23 recurrence

The clobber fired again on the next-but-one week,
`simple-biz_daily_report_2026-08-23_to_2026-08-29 (1).csv`: measured 2026-09-01 by the
detector, **44 of 83 recorded rows had no amount on the column — ₱176,016.67 paying
₱0** — plus andret@ over by ₱3,187.50 (`amount_mismatch`). The paste itself had also
gone in badly and was re-pasted by hand (Kane), which is the same two-generations-of-
state shape as the original incident. This recurrence is what reversed the 2026-08-21
"out of scope" call on the CAS fix (Kane, 2026-09-01: fix the step and harden it) —
the whole-object write is now compare-and-swapped and the red panel can **Restore from
record** instead of demanding a third paste. The repair itself is a human action in
the step (Restore, then Re-price for andret@), and if the cycle was locked, **unlock +
re-lock** afterwards so the staged stubs re-stage.

## Open

- **The 2026-08-23 week's repair is pending a human**: 44 rows to Restore from record
  (₱176,016.67) and andret@ to Re-price (−₱3,187.50), then unlock + re-lock if the
  cycle was locked. Verify after with `scripts/audit-orphanage-pay-divergence.mts
  --file "simple-biz_daily_report_2026-08-23_to_2026-08-29 (1).csv"`.
- **Hand-typed orphanage amounts have no first-class record**, so they cannot be
  reconciled or re-priced, and a lost one is recoverable only from `audit_log`.
- **erict@'s ₱5,373.00 on the 2026-08-09 week is still missing** and no automated check
  can see it (no `orphanage_pay` row behind a hand-typed amount). It has to be entered
  again and the figure confirmed against `audit_log`.
- **The 2026-07-19 overpayments (₱862.12 × 2) are unresolved** and that week is paid.
- Staged stubs carry the amount as it stood when they were staged. Repairing the
  column does **not** re-stage them. The sanctioned way to push a corrected orphanage
  amount into an already-locked cycle is **unlock and re-lock**: re-staging stamps a
  fresh `locked_at`, which demotes any snapshot published before it
  ([payment-dispatch.md:429](./payment-dispatch.md)). Note that a row falling through
  to carrier C (`computeCurrentPay`) loses the orphanage money entirely — C cannot
  price it — and must report `valuesSource: 'recomputed'` rather than a silent ₱0.
