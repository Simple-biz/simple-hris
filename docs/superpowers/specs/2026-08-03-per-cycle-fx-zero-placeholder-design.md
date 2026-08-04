# Per-cycle FX rates with zero placeholders (Step 2)

**Date:** 2026-08-03 (same-day follow-up to the Wizard Setup checklist)
**Status:** Approved (design), pending implementation plan
**Supersedes:** the weekly fx confirm marker (`payroll.wizard.fx_confirmed.<weekStart>`)
from `2026-08-03-wizard-setup-readiness-checklist-design.md` — that spec's fx sections
now defer to this document.

## Goal

Kane: "the placeholders for these rates should be zero, then when it's changed we know
it was fixed — this should happen every new Hubstaff upload." Both Step-2 rates
(USD→PHP and USD→COP) start at **0 for every new pay cycle**; typing the real rate is
itself the weekly confirmation. The readiness "USD rate confirmed" row goes green only
when **both** rates are non-zero for the cycle, and Dispatch is **hard-blocked** while
either is 0 (both decisions confirmed by Kane 2026-08-03).

## Why per-cycle storage (not zeroing the globals)

Every consumer of `app_settings.usd_to_php_rate` / `usd_to_cop_rate` — employee
paystub API, urgent payments dispatch, `useDispatchQueue` COP conversion, bonus
catalog resolve-time FX, People roster, and the wizard's own loader — reads through
`effectiveUsdToPhpRateFromStored` / `effectiveUsdToCopRateFromStored`
(`src/lib/fx/usd-php.ts:12`, `src/lib/fx/currency-fx.ts:28`), which **replace a
missing/invalid value with the official fallback rate**. A zero written to the global
key would be silently erased everywhere, including on Step 2 itself. So:

- The zero placeholder lives in a **per-cycle record**; the globals never hold 0.
- Saving a rate **writes through** to the globals, so all non-wizard consumers keep
  today's behavior with the freshest rate.

## The cycle record

app_settings key **`payroll.wizard.fx.<sourceFile>`** (same keying family as
`payroll.wizard.additions.<sourceFile>`):

```json
{ "php": 58.9, "cop": 4050, "by": "lenny@simple.biz", "at": "2026-08-09T02:11:00Z" }
```

- Absent key ⇒ `php = 0, cop = 0` — the placeholder. A new Hubstaff upload mints a new
  `sourceFile`, so the reset is **by construction**; no scheduled job.
- Re-ingesting the SAME filename (duplicate batch / re-sync) keeps the record — same
  pay period, rates stay set.
- Partial saves merge: saving PHP writes `php`/`by`/`at` and preserves `cop`, and vice
  versa. `by` = session email of the last save; `at` = ISO timestamp.
- Writers: the four existing Step-2 save paths (PHP Enter / PHP Apply & Save / COP
  Enter / COP Apply & Save). Each validates `> 0`, writes the cycle record AND the
  matching global key, and keeps the existing audit-log calls.
- Parser: pure `parseCycleFxRecord(value: string | null)` in
  `src/lib/payroll/wizard-setup-steps.ts` → `{ php, cop, by, at }` with 0/null-safe
  defaults; malformed JSON ⇒ null (treated as absent).
- Rename landmine (accepted): `renameHubstaffSourceFile` moves only the `final_pay`
  key today; a renamed cycle orphans its fx record exactly like the additions blob.
  Same accepted behavior, documented here.

## Wizard Step 2 behavior

- On `calcSourceFile` change, load the cycle record (raw — never through the
  `effective*` fallbacks). Absent ⇒ both inputs display **0** with an amber
  "Not set for this cycle" hint on each card, plus a muted reference line showing the
  current global value ("Global: ₱58.90 / $1") so the accountant knows the ballpark.
- `usdToPhpRate` / `usdToCopRate` component state now carry the CYCLE values (0 until
  set). Everything already wired to them follows automatically:
  - USD/COP display columns must guard division: rate ≤ 0 renders "—" (no
    Infinity/NaN). Audit each `÷ usdToPhpRate` / `× usdToCop` site in
    PayrollWizard.tsx.
  - Notes-bridge conversion (`adjustmentToPhp`) already returns null at rate ≤ 0 —
    USD/COP board notes stay un-applied (and the checklist Notes row stays amber)
    until rates are set. Correct under this model; no change.
  - `publishFinalPaySnapshot` writes `fx_rate` = cycle `php` when > 0, else the
    global effective rate — staged employee-facing paystubs never see 0.
- Replay: both rate cards become **read-only** while `isReplay` (house convention;
  today they edit the globals even from a replay, which this closes). A replayed
  pre-feature cycle (no record) shows the global effective values with a muted
  "historical — no cycle record" note, still read-only.
- **Removed** (shipped earlier today, superseded): the "Confirm for this week" button,
  `stampFxConfirmed`, the fx marker-load effect + `fxConfirmedAt`/`fxConfirming`
  state, `fxConfirmedSettingKey` / `parseFxConfirmedMarker` / `FX_CONFIRMED_SETTING_PREFIX`
  and their tests. Existing `payroll.wizard.fx_confirmed.*` rows in app_settings stay
  as inert orphans (precedent: old per-week keys are never cleaned).
- Untouched: the orphanage confirm-none marker and button; the Step-1 CSV modal.

## Readiness "USD rate confirmed" row

`WizardSetupInput.fxMarker` is replaced by `fx: { php: number; cop: number; by:
string | null; at: string | null } | null`:

| State | Status | Detail |
|---|---|---|
| read failed (degradedKeys has 'fx') | pending | "Couldn't read the cycle rates" |
| no matched upload for the expected week | attention | "Waiting for this week's CSV" |
| record absent, or both 0 | attention | "Rates at 0 — set on Step 2" |
| exactly one of php/cop is 0 | attention | "COP still 0 — Step 2" / "PHP still 0 — Step 2" |
| php > 0 and cop > 0 | done | "₱58.9 · COP 4,050 / $1 · lenny@… · Aug 3" |

Server side, `buildWizardSetup` swaps the week-marker read for
`payroll.wizard.fx.<matchedSourceFile>` (only when a matched upload exists — batched
into the existing `getAppSettings` call). Label stays "USD rate confirmed", stepNo "2".
Pre-feature historical cycles have no record and read amber in past-week views —
accepted.

## Dispatch hard gate (Step 8) + Validation note (Step 7)

- The "Lock in Values & Send to Payment Dispatch" button is `disabled` while
  `usdToPhpRate <= 0 || usdToCopRate <= 0`, with a visible line: "Set this cycle's
  USD → PHP and USD → COP rates on Step 2 first." A defensive check inside the click
  handler toasts the same message (belt and braces).
- Step 7 Validation renders the same condition as a blocker line item so it's visible
  before reaching Step 8.
- This is a deliberate exception to the earlier "no new dispatch gates" non-goal —
  Kane's explicit call: a zero rate makes every USD/COP figure in the dispatch payload
  garbage.

## Rollout

First cycle after shipping (including the live one if not yet dispatched): the record
is absent, Step 2 shows 0, the fx row goes amber, and dispatch is gated until the
rates are re-entered once (~10 seconds). This one-time re-entry IS the intended
explicit confirmation; no seed/backfill.

## Testing

- Pure tests (`wizard-setup-steps.test.ts`): `parseCycleFxRecord` (valid, partial,
  malformed, null); fx row derivation for all five table states above.
- No integration test harness exists for PayrollWizard.tsx — the gate, guards, and
  write-through are verified by `npm run lint` + targeted code review + the read-only
  `verify-readiness.mts` run (its Wizard-setup block shows the fx row states).
- Update `docs/features/payroll-readiness.md` (fx row semantics + key) and the
  Step 2 mention in the wizard-setup spec.

## Non-goals

- No change to the global keys' consumers, the `effective*` fallbacks, or
  OFFICIAL_* defaults.
- No cleanup/migration of orphaned `payroll.wizard.fx_confirmed.*` rows.
- No renameHubstaffSourceFile extension (fx record orphans on rename like the
  additions blob — accepted).
- No changes to the orphanage marker, CSV modal, week-scoped roster, or score.
