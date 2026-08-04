# Payroll Notes FAB — "Offboarded" Tab

**Date:** 2026-08-04
**Status:** Approved

## Goal

The Payroll Wizard's floating Payroll Notes button
([`PayrollWizardNotesFab.tsx`](../../../src/components/accounting/PayrollWizardNotesFab.tsx))
opens a modal with three tabs today: **Readiness**, **Adjustments and Notes**,
and **Rates**. There is currently no surface anywhere in the app to set a pay
rate or bank details for someone who has just been offboarded — the moment HR
stamps `off_boarded_at`, the person drops out of `active_employees` and every
picker built on it (People tab, Payment Catalog's employee picker), so their
final pay can silently go out short (missing rate) or nowhere (missing/stale
bank). This feature adds a 4th tab, **Offboarded**, listing recently offboarded
people with their rate/bank status and inline "Set rate" / "Set bank" actions,
so their last paycheck can be handled without leaving the wizard.

## Decisions (from brainstorming)

1. **New 4th tab**, not a section bolted onto Readiness or Checklist. Keeps the
   notes table itself untouched and gives this its own clear home, matching how
   Readiness/Rates already get their own tabs.
2. **Listing window: "until final pay is out."** A person stays on the list
   while they still might need a final paycheck, and drops off once that
   paycheck has run — mirroring the aging rule `buildMissingBank` already uses
   for its own leaver handling
   ([`payroll-readiness.ts:1171-1197`](../../../src/lib/payroll/payroll-readiness.ts#L1171-L1197)):
   stays listed while they have hours in the **current** Hubstaff cycle, or
   their departure date is on/after that cycle's pay week; drops off once a
   cycle runs that postdates their departure with no hours for them in it.
3. **List everyone in the window, not just those missing something.** Each row
   carries independent rate/bank status pills (OK / Missing). Gives clerks full
   visibility of who's leaving and doubles as a review checklist — not a pure
   action list.
4. **`temporary_pause` reasons are excluded.** That reason suspends the
   Workspace account but the person is expected back (see
   `temporary_pause` in
   [`offboard-reasons.ts`](../../../src/lib/hr/offboard-reasons.ts)) — they still
   get `off_boarded_at` stamped, but there is no "final pay" for someone who
   hasn't actually left. Showing them here would be actively misleading.
5. **Actions: Set rate + Set bank only.** No "file final payment" button in
   this iteration — the existing Urgent one-off payment flow
   (`People tab → Pay`, or Payment Dispatch → Urgent) already handles filing the
   actual payment once rate/bank are in place; this tab's job is just to make
   sure those two things ARE in place.
6. **Set Bank prefills from the offboard snapshot.** `getOffboardSnapshot()`
   ([`offboard-snapshot.ts`](../../../src/lib/hr/offboard-snapshot.ts)) has
   captured every leaver's bank/routing/processor data, verbatim, at the moment
   of offboard since it was built — and is read by nothing today. This feature
   is its first reader: when a snapshot exists, its fields seed the Set Bank
   form instead of starting blank, so the clerk sees exactly what was on file
   and can confirm or correct it.
7. **Reuse existing dialogs and data, don't fork them.** `SetRateDialog` /
   `SetBankDialog` already exist in this file for the Readiness tab's
   missing-rate/missing-bank rows and already save through the real Payment
   Catalog / `employee_ids` write paths — this feature feeds them a different
   input list, not a new save path. Likewise the person list is built on
   `listRecentlyOffboardedPeople()`
   ([`recently-offboarded.ts`](../../../src/lib/roster/recently-offboarded.ts)),
   an existing, already-hardened function (active-roster exclusion, dupe-row
   guards, Hubstaff-email bridging) currently wired only into the KPI
   bonus-calculator "Offboarded" pickers.

## Implementation

### Data: extend `listRecentlyOffboardedPeople`

Add one additive field to `RecentlyOffboardedPerson`
([`recently-offboarded.ts:44-65`](../../../src/lib/roster/recently-offboarded.ts#L44-L65)):

```ts
export interface RecentlyOffboardedPerson {
  // ...existing fields...
  /** Raw off_boarded_reason from the stamped global_master_list row, when
   *  known. Null for flavor-4 (fell off the sheet unstamped) or when no
   *  contributing source carried a reason. */
  off_boarded_reason: string | null;
}
```

Populate it by adding `off_boarded_reason` to the `global_master_list` select
([line 165](../../../src/lib/roster/recently-offboarded.ts#L165)), carrying it
through `Cand` (line 91-98), the flavor 1/3 push (line 331), the merge step's
null-coalescing (line 382-387, add
`g.off_boarded_reason = g.off_boarded_reason ?? c.off_boarded_reason`), and the
final `people.push` (line 456-464). Existing callers (`HslBonusCalculator.tsx`,
`DeptBonusCalculator.tsx`, `gml-status.ts`, `transfer-candidates/route.ts`) are
unaffected — they simply ignore the new field.

### New route: `GET /api/payroll-wizard/offboarded`

Mirrors the existing `/api/payroll-wizard/readiness` route/pattern already used
by `PayrollReadinessGlance`. Server-side:

1. Call `listRecentlyOffboardedPeople(90)`, filter out
   `off_boarded_reason === 'temporary_pause'`.
2. Resolve the current cycle's pay week + the set of normalized emails with
   hours in its Hubstaff file (the same inputs `buildMissingBank` takes as
   `weekStart`/`payrollEmails` — sourced the same way
   `listPayrollWorkerOptions` already does via `fetchHubstaffRowsOrdered`).
3. Apply the aging rule per person (decision #2) to drop anyone whose final pay
   has already gone out.
4. For each remaining person, resolve:
   - **Rate status** — same Payment Catalog lookup
     `enrichMissingRatesFromMaster` performs
     ([line 622](../../../src/lib/payroll/payroll-readiness.ts#L622)) — `ok` or
     `missing`.
   - **Bank status** — same `isPayoutComplete` check `buildMissingBank`
     performs against their current `employee_ids` row — `ok` or `missing`. If
     `missing`, also check `getOffboardSnapshot(workEmail)`; if a snapshot
     exists, status reads `missing_has_snapshot` so the row can say "prior bank
     on file" instead of a flat "missing."
5. Return `{ people: OffboardedPersonView[], weekLabel, error }`. Best-effort
   per-person enrichment: a rate/bank lookup failure for one person marks their
   status `unknown` rather than failing the whole response.

### UI: the new tab

Add `"offboarded"` to `ModalTab`
([line 217](../../../src/components/accounting/PayrollWizardNotesFab.tsx#L217))
and a fourth entry to the tab-bar array (line 1066-1071), same icon/underline
treatment as the other three (e.g. `UserMinus` icon).

Tab body: fetch the new route on mount / tab-open (same `heardWizard`-grace
pattern the Readiness tab already uses), render one `PersonLine` per person
(the same row primitive the Readiness tab's missing-rate/missing-bank lists
use) showing:

- Name, department
- "Left `<date>` · `<reason label>`" (via `offboardReasonLabel()`)
- A rate-status pill and a bank-status pill (OK / Missing / "prior bank on
  file")
- **Set rate** / **Set bank** buttons, gated by the same `canEdit` prop as
  every other edit action in this component

Clicking **Set rate** calls the existing `setRatePerson(...)` setter with a
`ReadinessMissingRate`-shaped object built from the row (name/email/department)
— `SetRateDialog` needs no changes. Clicking **Set bank** calls
`setBankPerson(...)` with a `ReadinessMissingBank`-shaped object, plus (new)
whatever snapshot prefill was resolved server-side.

Empty state: "No one's recently left — nothing needs final-pay setup."

### `SetBankDialog` extension

Add an optional `prefill` prop
([`SetBankDialog`, line 2461](../../../src/components/accounting/PayrollWizardNotesFab.tsx#L2461)):

```ts
prefill?: {
  processor?: string;
  walletEmail?: string;
  walletName?: string;
  bankName?: string;
  accountHolder?: string;
  accountNumber?: string;
  swiftCode?: string;
};
```

`useState` initializers for `processor`/`walletEmail`/`walletName`/`bankName`/
`accountHolder`/`accountNumber`/`swiftCode` read from `prefill` when provided,
falling back to today's blank defaults otherwise. No change to `locked`
semantics (line 2481) or the save path (line 2492-2561) — prefill only seeds
the form, the clerk can still edit every field before saving, and the existing
Readiness-tab call site simply doesn't pass `prefill` (unaffected).

## Error handling

- `listRecentlyOffboardedPeople` already fails closed on unsafe reads (master
  list, current-upload resolution, Hubstaff files) — returns an empty list plus
  a reported error rather than a wrong-shaped one. The new route surfaces that
  error string in the tab the same way `PayrollReadinessGlance` already
  displays its own `degraded` reasons.
- Per-person rate/bank/snapshot enrichment is best-effort — a failure marks
  that one person's status `unknown`, never blocks or empties the rest of the
  list.
- `SetRateDialog`/`SetBankDialog` save paths and their validation are
  unchanged — only their inputs (and, for bank, the initial field values)
  change.

## Testing

- Unit tests for the reason filter + aging logic: `temporary_pause` excluded;
  a person with hours in the current cycle stays listed; a person whose
  departure predates the current cycle with no hours in it drops off; a person
  who left during/after the current cycle's week stays listed regardless of
  hours.
- Unit test confirming the `off_boarded_reason` addition to
  `listRecentlyOffboardedPeople` doesn't change any existing field's value or
  ordering for its current callers.
- Read-only diagnostic script `scripts/verify-recently-offboarded-tab.mts`
  (matching this codebase's `diagnose-*`/`verify-*` convention) — runs the new
  route's logic against live data and prints who'd show up, their statuses, and
  flags any `temporary_pause` leakage, for a pre-ship sanity check.
- Typecheck + `next build`.
- Manual: open the Payroll Wizard, open the new Offboarded tab, confirm a real
  recently-offboarded test record appears with correct status pills; open Set
  rate and Set bank and confirm they save; confirm a person with a snapshot
  shows prefilled bank fields and one without starts blank; confirm a
  `temporary_pause` person never appears.

## Out of scope

- No "file final payment" action in this tab (decision #5) — the existing
  Urgent one-off payment flow stays the way to actually send money.
- No change to `SetRateDialog`, to the Readiness tab's existing missing-rate/
  missing-bank lists, or to `buildMissingBank`/`buildMissingRates` themselves.
- No change to the Worker picker in the Adjustments and Notes tab
  (`listPayrollWorkerOptions` stays CSV-only, per the 2026-07-17 decision) —
  this tab is a separate surface, not a reversal of that change.
- No new database table or migration.
