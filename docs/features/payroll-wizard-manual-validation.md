# Payroll Wizard — Manual Validation (MV)

An **MV** tickbox beside Exclude on the Payroll Wizard's Validation step (7). Ticking it
records that a named human opened one person's pay for one cycle, checked it by hand, and
vouched for it — with a timestamp and an optional note. When the clerk later opens **Mark
as Paid** in Payment Dispatch, that vouch is shown to her before she sends the money.

The same table also opens **full screen** (a portal, not a route), and the Validation step's
expanded row now always accounts for the **Adjustment** figure instead of hiding it when zero.

Shipped **2026-08-21**. Source: `src/lib/payroll/manual-validation.ts`,
`app/api/payroll-wizard/manual-validation/route.ts`,
`src/components/payroll/ValidationBreakdownTable.tsx`,
`src/components/payroll/ValidationFullScreen.tsx`.

## Key files

| Piece | File |
| --- | --- |
| Pure module (key, parse, merge, lookups) + tests | `src/lib/payroll/manual-validation.ts` · `.test.ts` |
| API (read + compare-and-swap write) | `app/api/payroll-wizard/manual-validation/route.ts` |
| Conditional `app_settings` writer | `src/lib/supabase/app-settings.ts` (`casUpdateAppSetting`) |
| The MV cell, note prompt, and column arithmetic | `src/components/payroll/ValidationBreakdownTable.tsx` |
| Full-screen mirror | `src/components/payroll/ValidationFullScreen.tsx` |
| Dispatch-side read (one impl, two call sites) | `src/components/payroll/useManualValidations.ts` |
| Mark Paid banner (display-only prop) | `src/components/payroll-clerk/MarkPaidDialog.tsx` |
| View Paystub band (display-only prop) | `src/components/paystub/PayStubModal.tsx` |
| Wizard wiring (state, load, toggle, full-screen) | `src/components/PayrollWizard.tsx` |

## It is NOT a column on `payment_dispatches`

The obvious home is wrong, and measurement is why. `payment_dispatches` is an **outcome
ledger**: on 2026-08-21 all **6,932** rows were terminal (`paid` 6,880 · `threshold` 44 ·
`problem` 8) and **not one lacked a `sent_date`**, because a row is inserted only when money
has already moved. MV is ticked on the **Validation** step (id 6 since HSL and Additions merged
2026-08-28; 7 before), *before* dispatch — so at tick time **there is no
row to write to**. A column there could only be filled after the fact, which inverts the
whole point: the clerk needs to see the vouch *before* she pays.

Its `note` column is also already taken — 2,523 rows carry text, including SQL-backfill
provenance. Reusing it would put two vocabularies in one column.

## Storage: one `app_settings` row per cycle

`payroll.wizard.mv.<sourceFile>` → JSON object of `lowercased work email → {by, at, note}`.

This mirrors `payroll.wizard.exclusions.<sourceFile>`, the store behind the Exclude checkbox
MV sits beside, so the two controls on the same row share one persistence model and one week
scope. Scale is proven: `payroll.wizard.final_pay.<sourceFile>` already holds **1.25 MB** in
this column, and the largest cycle (1,068 payees) puts MV near ~130 KB.

**No migration.** No DDL, no new table, no PENDING deploy step.

### Absence is the unticked state

There is exactly one representation of "not validated": **the key is absent**. Un-ticking
`DELETE`s the key rather than storing a falsy record. Never introduce a `validated: false`
entry — two representations of the same state is how a count starts disagreeing with a
checkbox.

## The two parse paths are deliberately asymmetric

Reading for display is **tolerant**: `parseManualValidationMap` drops entries it cannot
understand and reports how many, so one corrupt record cannot blank a cycle's validations on
screen.

Writing is **not** tolerant. `mergeIntoRawMvBlob` merges into the *raw* parsed object and
**refuses** (`ok: false` → HTTP 409) when the stored value is present but unparseable. A
tolerant write would round-trip an unreadable blob through `{}` and destroy every validation
in it — the same class of bug `getAppSettingStrict` exists to prevent. Merging raw also
preserves keys a future version adds, so an older deploy cannot strip them.

A failed **read** likewise never blanks state — not in the route (500, not an empty map), not
in the wizard's load effect, not in `useManualValidations`. Rendering every row unticked would
invite re-doing recorded work, and re-ticking overwrites the original validator's name.

## Concurrent clerks cannot silently overwrite each other

This is the reason the write does not go through the generic `/api/app-settings` POST.

That route is last-write-wins, which is fine for a scalar and **destructive for a map**: two
clerks who each read `{}`, add their own person and save leave only the second person's entry,
with no error on either side. *That is still true of `payroll.wizard.exclusions` today.*

MV writes instead take a **compare-and-swap** (`casUpdateAppSetting`): read `{value,
updatedAt}`, merge one key, write only if `updated_at` has not moved. A conflict is a normal
outcome and is **retried** (bounded at `MAX_CAS_ATTEMPTS = 5`), then reported as 409 rather
than forced. Forcing the write there would be the exact lost update the route exists to
prevent — do not "fix" a 409 by dropping the predicate.

`expectedUpdatedAt: null` means "the key was absent when I read it" and takes a plain
`INSERT`, so a racing creator trips the primary key (`23505`, reported as a conflict) instead
of losing their write.

## Attribution the client cannot forge

`by` is `authz.sessionEmail` and `at` is stamped **in the route**. Neither is accepted from the
request body. A client-supplied validator would let someone vouch in another person's name; a
client-supplied timestamp would let them backdate their own vouching — and that attribution is
the entire value of the record.

Every write also inserts an `audit_log` row
(`accounting.payroll_wizard.manual_validation.set` / `.cleared`). Writes through the generic
app-settings route are **not** audited (it audits only admin-only, sensitive and dispatch-lock
keys), so an accountability record stored that way would leave no trace of who set it.

Gates mirror the sibling wizard routes exactly: `requireFeatureAccess('accounting',
'payroll_wizard', 'view')` to read, `requireFeatureEdit('accounting', 'payroll_wizard')` to
write.

## The note is optional, and the UI must keep it optional

Kane's rule: ticking **asks** for a note but never requires one. So the prompt has **two**
ways out that both validate — **Save** and **Skip** — and only one that does not (Cancel).
Never gate Save on non-empty text; there must be no state where the operator is stuck.
Un-ticking is immediate and prompts for nothing: withdrawing a vouch should not be behind a
form.

The popover is absolutely positioned **inside the cell**, not portalled, because the table body
is the scroll container — a portalled panel would stay put while its row scrolled away.

## There is no "validate all" tickbox

Exclude has a master checkbox in its header; MV deliberately does not. "I validated everyone
at once" is precisely the claim this column exists to make impossible. The header carries a
`validated/total` count instead, and the full-screen rail dots a department only when every one
of its rows is ticked.

## Mark as Paid shows it, and can never write it

`MarkPaidDialog` takes an optional **display-only** `validation` prop. It never enters
`MarkPaidPayload` (11 flat scalars, untouched) and nothing in the dialog writes it, so the
dialog cannot manufacture a vouch. The banner sits **outside** the form's `max-h-[44vh]` scroll
pane so it cannot scroll out of sight, and is **emerald, not amber** — amber is this app's
warning colour and a completed check is not a warning.

**It renders only when a validation exists.** There is deliberately no "not validated" state:
MV is a spot-check, not a required step, so rendering its absence would put a warning on almost
every payment and train the clerk to ignore the band.

### The lookup key is `row.id`, never `row.email`

`QueueRow.id` is the **work** email — the key the wizard's staged values are matched on.
`QueueRow.email` is the payout address, and personal addresses are **shared and recycled** in
the master list (`useDispatchQueue.ts` carries its own warning about this: an alias match
"could pay one person another person's figures"). Keying MV on `.email` could therefore surface
a validation belonging to a **different person**. There is **no fallback** — showing nothing is
correct; showing someone else's vouch is not.

Both Mark Paid surfaces read through the one `useManualValidations` hook. They are not given
their own fetches because they **already** disagree about what they POST (the standalone
`/payroll-clerk` app omits `amount_cop` and `system_bonus_*`), and one display string is not
worth a third place to diverge. The View Paystub band added later reads the **same** hook
instance already mounted in `PayrollDispatch` — a display site, not a third fetch.

Urgent one-off payouts pass **nothing**: they have no wizard cycle behind them (`cycle_id` is
null) and so cannot have been validated in one.

## View Paystub shows it too (2026-08-27)

Payment Dispatch's **View** opens `PayStubModal`, and the vouch now rides in there
alongside the dispatch log, in a right-hand accounting rail: MV band on top ("who signed
off on this figure"), the log underneath ("what then happened to it"). Same emerald band,
same copy, same display-only contract as Mark Paid — `PayStubModal` takes an optional
`validation` prop, never fetches, and has no control that could write one.

The rail is `xl:absolute xl:left-full`, out of flow, so the statement keeps the full 560px
shell and stays centred in the viewport; below `xl` there is no room beside a centred
statement and the rail stacks underneath. It renders **nothing** when it would be empty, so
an employee-facing mount of the same modal is byte-identical to before.

`PayrollDispatch` carries `workEmail` (`row.id`) on its `viewPaystub` state **separately
from** `email` (the payout address the statement is fetched by) — the modal is opened by
one and the MV is keyed by the other, and collapsing them into one field is the alias bug
in §"The lookup key is `row.id`". Both View handlers (the Pending worksheet and the
Excluded tab) set it; the hook is scoped to `period.sourceFile`, the same week the
statement opens on, so the vouch always belongs to the cycle on screen.

**`PaidRecordsPanel`'s View is deliberately excluded.** Its rows are `payment_dispatches`
records, which carry only `recipient_email` — the payout address. Rule 1 forbids keying MV
on it and forbids a fallback, so that surface shows nothing rather than a vouch that might
belong to someone else. It would also need the record's own `cycle_source_file`, not the
tab's current week. Giving it MV means resolving a work email per record first.

## Adjustment is read-only, and now always shown

The Validation table has carried an **Adj** column all along, and it is live — 290 people had a
non-zero adjustment in the 2026-08-09 cycle, 1,009 across all snapshots. It is sourced from the
staged dispatch payload, which the **Payroll Notes** board feeds via the adjustment bridge
(`payroll-wizard-notes.md`). The Validation step **displays** it; the Notes board is where it is set.

What changed: the expanded row used to list Adjustment **only when non-zero**, so for the ~710
people at ₱0 the line was simply missing. It is now listed **unconditionally** — labelled
"none on the Notes board" at zero, "from the Notes board" otherwise. It is the one figure an
operator opens the panel to confirm the *absence* of, and "no adjustment" and "an adjustment I
can't see" look identical when the line is absent.

## Full screen is a portal, not a route

The rows are `PayrollBreakdown[]` derived inside `PayrollWizard.tsx`'s React memory from the
loaded Hubstaff upload plus the live staged dispatch payloads. **No endpoint returns them.** A
separate page could only re-derive from `/api/payroll-current-pay` — a second pay
implementation, free to disagree with the wizard on the one screen whose job is certifying that
the wizard is right — or read `payroll.wizard.final_pay.<file>`, which is withheld pre-lock and
so shows nothing during the week you would actually be validating.

`ValidationFullScreen` is handed the **same `filteredRows` array** and the same handlers as the
inline table, and renders the **same** `ValidationBreakdownTable`. It mirrors by construction;
there is no predicate in it that could drift. Modelled on the KPI calculator's `focus` mode
(`DeptBonusCalculator.tsx`), the repo's only other full-screen workspace overlay: same SSR
`mounted` guard, same body scroll-lock (restoring the previous value, not assuming the default),
same Escape-to-close.

Its only extra prop is `fillHeight`, which drops the table's `min(62vh, …)` cap — the inline
step sits in a scrolling page, the overlay in a `min-h-0 flex-1` box.

## Column arithmetic

Adding MV moved `cols` from **14 → 15** (base) and **17 → 18** (HSL); the last group header span
from 2 → 3 (Gross · Excl · MV); and the footer's `colSpan={cols - 2}` → `cols - 3` plus one
extra cell. Table min-widths grew ~64px with the new column. If these drift apart the expanded
row and subtotal footer under-span and the table visibly misaligns — the comment above `cols`
carries the sums; keep it in step with any column change.

## Replay is read-only

Replaying a past week passes `onToggleValidated: undefined`, which renders the column read-only:
who validated that week is history. The route would refuse the write in any case, so the guard
is belt-and-braces rather than the only barrier.

## Deploy notes

**No migration.** No DDL, no new table, no env var, no n8n import, no cron.

Verification at ship: `npx tsc --noEmit` clean for every touched file (the only errors are
stale `.next/types/validator.ts` references to the retired Pay Cycle Reports routes, an
artifact of the running dev server); `npm test` **1381/1382**, the single failure being the
pre-existing `executive_assistants` assertion in `kpi-calculator-depts.test.ts` already tracked
in memory, which imports nothing this change touches.

`next build` was **not** run — a `next dev` server was live on :3000 and they share `.next/`.
