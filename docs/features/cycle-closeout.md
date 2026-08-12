# Cycle close-out — declaring a pay week finished, even with money still owed

Payment Dispatch's **Stop processing** dialog carries a **Close the pay cycle** toggle. Flip it
and the dialog becomes **"Close Pay Cycle?"**: stopping also files a permanent close-out record
naming who was paid, through which processor, and — the part nothing else records — which
**payable** people were not paid. Shipped 2026-08-10.

The record's on-screen viewer (a `Closed` badge and panel in Payment Dispatch → Reports) was
removed with that tab on 2026-08-12. The dialog's "Pay cycle already closed" state still reads
the close-out list, and `GET /api/payment-dispatches/cycle-closeout?source_file=` still returns
the full record; a downloadable close-out report generated at Stop time is the replacement
human-readable artifact (next commit after the tab removal).

Built because Accounting needs to end a week that isn't perfect. The Pay Cycle Reports publish
button (retired 2026-08-12, see `documents-tab.md`) refused exactly that case, on purpose.

## Key files

| Piece | File |
| --- | --- |
| Record shape, validator, builder (pure) | [`src/lib/payroll/cycle-closeout.ts`](../../src/lib/payroll/cycle-closeout.ts) |
| Unit tests | [`src/lib/payroll/cycle-closeout.test.ts`](../../src/lib/payroll/cycle-closeout.test.ts) |
| Persistence | [`src/lib/payroll/cycle-closeout-store.ts`](../../src/lib/payroll/cycle-closeout-store.ts) |
| API | [`app/api/payment-dispatches/cycle-closeout/route.ts`](../../app/api/payment-dispatches/cycle-closeout/route.ts) |
| The toggle | [`src/components/payroll/LockToggleConfirmDialog.tsx`](../../src/components/payroll/LockToggleConfirmDialog.tsx) |
| Trigger + unpaid list | [`src/components/payroll-clerk/PayrollDispatch.tsx`](../../src/components/payroll-clerk/PayrollDispatch.tsx) |
| ~~Badge + panel~~ | ~~DispatchReports.tsx~~ — viewer removed with the Reports tab, 2026-08-12 |

## A close-out is the only per-cycle record now (history: the published report)

Until 2026-08-12 two artifacts existed with two different promises: a **published pay-cycle
report** (Accounting → Documents → Reports, gated on the cycle being 100% settled — see the
RETIRED section in `documents-tab.md`) and this close-out. Both report tabs were removed that
day, the publish gate went with its surface, and the close-out became the single per-cycle
record. Its promise is unchanged and still the load-bearing part:

- It says "Accounting stopped here — this is what had gone out, and this is who was still owed".
- It is **allowed to record failure**; there is no completeness gate and there must not be one.
- It never claims a week was settled. Anything rendering it (including the downloadable report)
  must keep the paid-at-close vs unpaid split visible — collapsing them recreates the lie the
  old publish gate existed to prevent.
- Key: `dispatch.cycle_closeout.<source_file>` in `app_settings`. Old published snapshots
  survive as orphaned `documents.pay_cycle_report.*` rows, deliberately left in place.

## What is frozen, and what is not

**Frozen:** the paid totals (`payeeCount` / `dispatchCount` / `paidUSD` / `paidPHP`), the
`byProcessor` split, and the unpaid list. These are what the clerk approved at close time and must
survive a later undo.

**Not copied:** the per-payee *paid* rows. `payment_dispatches` remains the live source for
those — duplicating 800+ rows into a settings value would create a second copy free to disagree
with the first. Any surface that shows live paid rows next to the frozen headline must say out
loud that the live side is recomputed and will differ if anything moved afterwards (the old
Reports-tab panel did; the downloadable report keeps the same disclosure).

## The paid side is server-computed; the unpaid side cannot be

`buildCycleCloseoutRecord` runs the **shared `tallyPaidDispatches`** over the cycle's dispatch
rows, so the frozen headline counts by the exact rule Payment Dispatch's progress strip, the
publish card and the published report all use — distinct employee emails plus one per contractor
invoice, with **superseded markers skipped** (a Not Paid → retry → Paid person is one payment, not
one payment plus one debt). Client numbers are never trusted.

The unpaid list is the opposite and this is deliberate: **"payable but unpaid" is a fact about
Payment Dispatch's client-side queue** — rates × staged paystubs × contractor invoices × the
Excluded carve-out — and no server table reproduces it. `disbursement_records` does not know whom
Accounting excluded. So the list is client-reported, stored under `unpaid.source =
'dispatch_screen'` so no reader mistakes it for server truth, validated at the boundary
(`normalizeReportedUnpaid`), and cross-checked against a server-side `disbursement_records` tally
stored as `records_outstanding`.

**`records_outstanding` is normally LARGER than `unpaid.count` and that is not a bug** — it counts
excluded people too. It is an audit cross-check, never the headline. When its read fails it is
stored as `null`, never as zero.

## "Payable" excludes the Excluded tab

Kane's rule, and the reason the warning count is what it is. Three ways to be payable-and-unpaid,
matching the progress strip's own denominator exactly:

| Reason | Source |
|---|---|
| `pending` | still in the pending queue — never dispatched |
| `problem` | logged Problem: out of the queue, money stuck |
| `threshold` | logged Threshold: deliberately held under the payout minimum |

People in the **Excluded** tab (no bank, no rate, wizard-excluded, USD track) are **never** counted
as unpaid. They were set aside on purpose; calling them "not paid" in a permanent record would turn
a deliberate hold into an apparent failure.

The `problem` / `threshold` sets come from the **same memo** that feeds the progress strip's
`blockedCount` / `heldCount` (`PayrollDispatch.tsx`). Re-deriving them anywhere else would be a
second implementation of the superseded-marker rule, free to drift from the number on screen —
which is why that memo returns its sets alongside its counts.

## Closing is once, and it happens before the lock flips

**Plain INSERT, never upsert.** `app_settings.key` is unique, so the first close of a week wins;
a double-click, two clerks racing, or a later stop all get `already: true` and write nothing. The
dialog reads the existing close-outs on mount and says *"Pay cycle already closed"* with the toggle
locked on and inert. There is no reopen — the record's whole value is that it says what was true
when Accounting stopped.

**The close-out POST runs before `setLocked(false)`.** The record is the un-redoable half: once
processing has stopped, the clerk has no second chance to file it from that dialog. So a failed
write aborts the entire action — processing stays on, the error is loud, and the toast says they
can turn the toggle off and stop plainly. Do not "helpfully" reorder this to stop first.

## No celebration email

The `payment_cycle_complete` confetti webhook is a **separate** trigger that fires when the
progress strip genuinely reaches 100% (`payment-dispatch.md` §12.7). Closing a cycle deliberately
does **not** fire it: congratulating the whole Accounting team over a week closed with people
unpaid would be a lie.

## Nothing is truncated silently

`MAX_STORED_UNPAID` (1000) bounds the stored rows; whatever it drops is counted in
`unpaid.truncated`, entries rejected for having no email are counted in `unpaid.dropped`, and the
panel renders both in an amber notice. The headline count adds `count + truncated` so the number
shown is the number the clerk saw. A silent cut would read as "that's everyone" — the exact lie
this record exists to prevent.

## Permissions

`GET` rides `requireRateVisibilityOrFeatureEdit('accounting', 'payment_dispatch')` — whoever can
see the queue can see whether its week was declared closed. `POST` requires
`requireFeatureEdit('accounting', 'payment_dispatch')`, because closing writes a permanent
declaration. No new permission was introduced. (The retired pay-cycle report rode the
`documents` grant instead — a difference that died with it.)

The toggle is withheld entirely while viewing a **past week** (the Stop button is disabled there
anyway — the processing lock is global, not week-scoped) and when no cycle is loaded.

## Paging

Every read pages via `selectAllPaged` — the cycle's dispatch rows (past 1,000 for a single cycle),
the `disbursement_records` cross-check, and the close-out prefix scan (one row per week, forever).
PostgREST truncates at 1,000 rows even with `.range()`.

## Deploy notes

**No migration.** One `app_settings` row per cycle, keyed `dispatch.cycle_closeout.<source_file>` —
every other fact is derivable, the only new one is the declaration itself, and `app_settings`
needs no DDL. Nothing for Kane to run. No env vars, no n8n import, no cron.

Audit action: `payment_cycle.closed` on resource `app_settings`, written **awaited** — it is the
trail for a declaration that money was left unpaid.
