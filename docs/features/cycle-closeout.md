# Cycle close-out — declaring a pay week finished, even with money still owed

Payment Dispatch's **Stop processing** dialog carries a **Close the pay cycle** toggle. Flip it
and the dialog becomes **"Close Pay Cycle?"**: stopping also files a permanent close-out record
naming who was paid, through which processor, and — the part nothing else records — which
**payable** people were not paid. Shipped 2026-08-10.

The record's on-screen viewer (a `Closed` badge and panel in Payment Dispatch → Reports) was
removed with that tab on 2026-08-12. The replacement human-readable artifact is the
**downloadable report generated at Stop time** — see § Downloadable report below. The dialog's
"Pay cycle already closed" state still reads the close-out list, and
`GET /api/payment-dispatches/cycle-closeout?source_file=` returns the full record (the
re-download path).

Built because Accounting needs to end a week that isn't perfect. The Pay Cycle Reports publish
button (retired 2026-08-12, see `documents-tab.md`) refused exactly that case, on purpose.

## Key files

| Piece | File |
| --- | --- |
| Record shape, validator, builder (pure) | [`src/lib/payroll/cycle-closeout.ts`](../../src/lib/payroll/cycle-closeout.ts) |
| Unit tests | [`src/lib/payroll/cycle-closeout.test.ts`](../../src/lib/payroll/cycle-closeout.test.ts) |
| Persistence | [`src/lib/payroll/cycle-closeout-store.ts`](../../src/lib/payroll/cycle-closeout-store.ts) |
| API | [`app/api/payment-dispatches/cycle-closeout/route.ts`](../../app/api/payment-dispatches/cycle-closeout/route.ts) |
| The toggle + download checkbox | [`src/components/payroll/LockToggleConfirmDialog.tsx`](../../src/components/payroll/LockToggleConfirmDialog.tsx) |
| Trigger + unpaid list + download wiring | [`src/components/payroll-clerk/PayrollDispatch.tsx`](../../src/components/payroll-clerk/PayrollDispatch.tsx) |
| Report builders (pure) + tests | [`src/lib/payroll/cycle-close-report-export.ts`](../../src/lib/payroll/cycle-close-report-export.ts) · `.test.ts` |
| Celebration gate + claim key (pure, shared with the 100% trigger) + tests | [`src/lib/payroll/cycle-complete-trigger.ts`](../../src/lib/payroll/cycle-complete-trigger.ts) · `.test.ts` |
| Reopen — archive key, role gate (pure) | [`src/lib/payroll/cycle-closeout.ts`](../../src/lib/payroll/cycle-closeout.ts) (`cycleReopenedKey`, `CYCLE_REOPEN_ROLES`) |
| Reopen — the three writes | [`src/lib/payroll/cycle-closeout-store.ts`](../../src/lib/payroll/cycle-closeout-store.ts) (`reopenCycle`) |
| Reopen — API | `DELETE` in [`app/api/payment-dispatches/cycle-closeout/route.ts`](../../app/api/payment-dispatches/cycle-closeout/route.ts) |
| Confetti canvas (shared) | [`components/ui/confetti-burst.tsx`](../../components/ui/confetti-burst.tsx) |
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
locked on and inert. Closing is still once per key — but the key can now be **freed by an explicit
reopen**, which archives the record rather than deleting it (§ Reopening below, added 2026-08-14).
The invariant that matters is unchanged: **no close ever overwrites another's declaration.**

**The close-out POST runs before `setLocked(false)`.** The record is the un-redoable half: once
processing has stopped, the clerk has no second chance to file it from that dialog. So a failed
write aborts the entire action — processing stays on, the error is loud, and the toast says they
can turn the toggle off and stop plainly. Do not "helpfully" reorder this to stop first.

## Reopening a closed cycle (added 2026-08-14)

A week closed by mistake used to be closed forever. It can now be reopened — but the reopen is
built so it does **not** cost the thing a close-out is for.

**The record is archived, never destroyed.** `reopenCycle` copies the stored value **verbatim** to
`dispatch.cycle_reopened.<source_file>.<iso>` and only then deletes the live key. The archived
record still says what was true when Accounting stopped; it simply stops being the current one. The
copy is byte-for-byte rather than re-serialized from a parsed object, so a record written by a
future version cannot silently lose fields on the way to the archive.

**That archive prefix is deliberately outside `dispatch.cycle_closeout.`** — `listCycleCloseouts`
scans `dispatch.cycle_closeout.%`, and an archived record caught by that scan would make Payment
Dispatch believe a reopened week is still closed, which is the exact bug a reopen exists to fix.
A test pins the two prefixes disjoint, modelling SQL `LIKE` properly (`_` is a wildcard, `.` is not).

**A reopen permanently silences the celebration.** It INSERTs the celebration claim
`dispatch.cycle_complete_notified.<source_file>` (marked `suppressed_by: 'reopen'`) if it is not
already there. Both triggers in `payment-dispatch.md` §12.7 check that exact key and go silent on
`23505`, so "the automation must never fire again after a reopen" needs no separate gate and cannot
be forgotten by a future caller. **Consequence, accepted (Kane, 2026-08-14):** a week whose email
never actually delivered — the claim is released on delivery failure — will not get one after a
reopen either. The instruction is unconditional on purpose.

**Write order is chosen so no failure loses a declaration:** burn the claim → archive → delete.
A failed archive aborts before the delete, so the week stays closed and the only casualty is a
burned celebration. A failed delete leaves an orphaned archive row and the week still closed,
reported as an error and never as a successful reopen. A week with no record at all returns
`notFound` (404) and touches nothing.

**Reopening is narrower than closing.** `POST` needs `requireFeatureEdit('accounting',
'payment_dispatch')` — anyone who runs payroll. `DELETE` needs that **and** one of
`CYCLE_REOPEN_ROLES` (`payroll_manager`, `admin`), the same tier `delete-authorization.md` uses for
destructive deletes, checked from the session's roles. The screen's `canReopen` flag decides only
whether to render the control; the route re-checks and is the gate.

**The control is on the screen, not in the Stop dialog.** The dialog's close-out block renders only
on the STOP side, so a button there would be unreachable the moment you have stopped. It sits beside
Start/Stop as a `Closed · Reopen` pill with a two-step confirm, and unlike the close toggle it is
**not lock-bound** — a past week can be reopened while browsing it, because a reopen touches only
the record.

Audit action: `payment_cycle.reopened`, **awaited**, carrying the archive key and the prior record's
closer/totals — after the delete, the log plus the archive row are the trail.

## Downloadable report (added 2026-08-12)

The Stop dialog's close-out block carries a **"Download a report when I stop"** checkbox —
default **ON**, reset each open (Kane: "it should just ask me"). What downloads depends on the
close toggle, and the two artifacts are a discriminated union in
`cycle-close-report-export.ts`, so a premature file structurally cannot wear a FINAL header:

| Close toggle | Artifact | Source of truth |
|---|---|---|
| **ON** (closing) | `cycle-closeout-<label>-FINAL-<local ts>.csv` | The `CycleCloseoutRecord` in the **POST response**, rendered **verbatim** — headline, per-processor split, unpaid list, truncation notice, `records_outstanding` footer. Client tallies cannot enter: the builder takes the whole record object. |
| **OFF** (just stopping) | `cycle-snapshot-<label>-PREMATURE-<local ts>.xlsx` | The live client memos the screen shows (`unpaidPayable`, `status==='paid'` projections, `distinctPaidCount`). Every sheet's first row is a **`NOT YET CLOSED — PREMATURE SNAPSHOT`** banner; the Summary sheet carries a STATUS row; pending amounts carry an **Amount Source** column so a recomputed figure is never laundered into settled truth. |
| inert (already closed) | the FINAL CSV again | `GET ?source_file=` — the **re-download path**. The stop-without-closing flow also runs this GET best-effort first: if a record exists (stale client, another session closed), the FILED record downloads instead of a snapshot. On GET **failure** the outcome splits: when the client's own closed-cycles list already asserts the week is closed, **no file is generated** — a snapshot would wrongly say NOT YET CLOSED — and the error toast carries a working **Retry** (a fresh GET + build); only when the close state is genuinely unknown does the premature label stand (unknown reads as not-closed, same as the dialog). Failure toasts never point at the Stop dialog — it reopens on the Start side once processing has stopped. |

Rules the builders enforce (each pinned by a test in `cycle-close-report-export.test.ts`):

- **Ordering is untouched.** The close-out POST still runs before `setLocked(false)` and still
  aborts the stop on failure. The download is non-throwing (`generateCloseReportSafe`) and the
  premature GET fires **after** the stop went through — a download problem can only ever cost
  the file, never the stop or the record.
- **`already:true` shows the ORIGINAL closer** — the response carries the existing record, so
  the file never claims this click closed the week.
- Paid-detail inputs are `status === 'paid'` **projections** — the raw `paid[]` state carries
  superseded markers that would double-count. Live paid rows appear only under a mandatory
  "live, not part of the frozen record" disclosure, on both artifacts.
- **Bank details are last-4 only** (Kane, 2026-08-12); SWIFT codes and full account numbers
  have no field in the projection types — `QueueRow.details` is not an input of the module.
- Per-processor sections are **sum-preserving**: all six rails (even zero) plus stray keys
  (`unknown`, legacy rails) — never a fixed-key map.
- Null marker amounts stay **blank**, never `0.00`; `records_outstanding: null` renders
  "unavailable", never 0, and always under its "includes Excluded — not the headline" label.
- CSV: UTF-8 BOM, CRLF, RFC 4180, ungrouped 2-dp money, and **formula-injection
  neutralization** (`=`/`+`/`-`/`@` prefixes on text cells go inert) — a class every sibling
  export still carries open.
- Filenames and the words in the files never say "Pay Cycle Report" — that was the retired,
  gated artifact. These say **Cycle Close-Out** / **Cycle Snapshot**.
- No new route, no writes, no webhooks, no audit entry (matching every client-side export
  sibling; the close itself is still audit-logged awaited). The Payroll Wizard's dialog is
  untouched — the new fields live inside the optional `closeOut` prop it never passes. The
  standalone `/payroll-clerk` surface has no Stop dialog, so the feature is
  Payment-Dispatch-embed-only by construction.

## Celebration email — a close with nothing owed fires it (changed 2026-08-14)

**Until 2026-08-14 closing deliberately did not fire the `payment_cycle_complete` confetti
webhook at all.** The reason was sound and still holds: congratulating the whole Accounting team
over a week closed with people unpaid would be a lie. But the rule was written as a blanket "not
from the close", and that left the honest case — a week closed owing *nobody* — depending
entirely on a trigger that is easy to miss. The 100% effect needs a browser open on Payment
Dispatch at the moment the last payment lands, and the webhook already configured; the first
condition failed for months on end (one marker exists in production, for the week of
2026-07-26), and the second was only satisfied when the slug went active.

So the close is now a **second trigger point for the same email** (Kane, 2026-08-14):

- **The close IS the event — unpaid people do not silence it** (Kane, 2026-08-14, superseding the
  same day's first rule: *"I don't care if people were unpaid, if it's closed it's closed"*). The
  shortfall is not hidden to achieve that: the report carries `trigger: 'cycle_closed'` and an
  honest `unpaid_count`, and the server validates **that arm on its own terms**
  (`isReportableCycleComplete`) instead of the strip's `paid === total`.
  **The strip's arm did not weaken** — it still means 100% and still demands equality; that is why
  there are two arms rather than one relaxed rule. Both arms still refuse a report naming **nobody
  paid**, or more paid than the cycle ever held: a congratulations listing zero payees is a bug, not
  a policy. `isCycleFullyPaid` now gates the strip trigger only.
- **Same body, built once.** `buildCycleCompleteBody` in `PayrollDispatch.tsx` serves both, so the
  two can never describe one week two different ways. `total_count` comes from the shared
  `cycleStartedCount`, which is what makes the route's `paid_count === total_count > 0` check
  structurally satisfiable rather than coincidental (pinned in `cycle-complete-trigger.test.ts`).
- **One email per cycle, ever, unchanged.** The server still owns that guarantee via the atomic
  `dispatch.cycle_complete_notified.<source_file>` claim. Whichever trigger fires first wins;
  the other gets `already` and sends nothing. Adding this trigger point cannot double-mail.
- **It runs AFTER the stop, fire-and-forget.** The ordering below is untouched: close-out POST →
  `setLocked(false)` → celebration. A webhook that is slow, down or unconfigured can only cost
  the email — never the record, never the stop. It is not awaited and it raises no toast.
- **An already-closed week does not re-fire it.** The trigger rides `closingCycle`, i.e. a real
  close performed by this click.

What has **not** changed: closing is still gate-free (§ above). The celebration is a consequence of
the close, never a condition on it — a week with 400 unpaid people closes exactly as readily as a
clean one, and now celebrates too.

**In-app confetti rides the same trigger.** A close fires `ConfettiBurst` on the Payment Dispatch
screen, erupting from the Start/Stop cluster, so the confetti and the email always agree about what
just happened. Reduced motion skips the burst entirely (the success toast is the moment), matching
`payroll-readiness.md`'s 100% celebration.

**History, so nobody re-litigates it from the git log:** this section said "no celebration email"
until 2026-08-14 morning, then "only a close owing nobody", then this. The load-bearing rule that
survived all three is the one above about honesty — the email may not *imply* a clean week when the
week was not clean, which is why `unpaid_count` and `trigger` are in the payload rather than a
paid-count massaged up to match the total. The n8n workflow owns the wording and should read those
two fields before congratulating anyone.

### 2026-08-18 — the strip's arm fired on a STALE-EMPTY queue (false 100%)

**A celebration marker is not proof the week finished.** The paragraph above counted
"one marker exists in production, for the week of 2026-07-26" as evidence the strip
trigger almost never fires. There are now **two**, and the second one is a lie: on
2026-08-18 the Aug 9–15 week mailed all 10 accounting holders *"100% PAID · 1 PAYMENT
SENT"* at 20:16:53Z while **1026 people were staged payable** and the clerk was one
payment in. The money was correct — the **denominator** had collapsed.

The cause is entirely client-side and is written up in
[payment-dispatch.md § 12.7.1](./payment-dispatch.md#1271-the-2026-08-18-false-100--trigger-1-fired-on-a-stale-empty-queue-open):
a wizard unlock/re-lock blanked the queue, the `hydrated` guard does not reset on the
silent reload path, and `isCycleFullyPaid` has no cross-check against the cycle's known
headcount — so `{paid:1, total:1, unpaid:0}` was **internally consistent** and
`isReportableCycleComplete` correctly let it through. **Nothing in this file is wrong,
and nothing here should be relaxed to compensate.** The strip's arm demanding
`paid === total` is exactly why the two arms exist; the repair belongs in the queue's
hydration, not in the gate.

What it costs the close-out: the week's **one shot is burned**. The claim key
`dispatch.cycle_complete_notified.<source_file>` now exists with `notified: 10`, so the
genuine completion — including the `cycle_closed` arm when Accounting closes the week —
hits 23505 and stays silent, and the in-app confetti with it. This is the same
once-ever mechanism that makes a reopen permanently silent (§ Reopening), working
exactly as designed on a false input. Freeing a week is deliberate and manual:

```
node --import tsx scripts/clear-cycle-complete-suppression.mts --source-file "<file>.csv" --apply --force-sent
```

It refuses a marker with `notified > 0` unless `--force-sent` says so out loud, because
re-arming a week that really did mail is how you double-congratulate the department.

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
needs no DDL. Nothing for Kane to run. No env vars, no cron. The reopen (2026-08-14) adds one more
key family, `dispatch.cycle_reopened.<source_file>.<iso>`, in the same table — still no DDL.

**n8n:** the close's celebration trigger (2026-08-14) introduces no new endpoint — it reuses the
already-active `payment_cycle_complete` slug (verified active in `webhooks.config` on 2026-08-14,
pointing at `…/webhook/payment-cycle-complete`). Nothing to import for this change.

Audit action: `payment_cycle.closed` on resource `app_settings`, written **awaited** — it is the
trail for a declaration that money was left unpaid.
