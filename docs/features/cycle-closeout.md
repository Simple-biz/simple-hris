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
| Celebration — the one trigger, record-derived stats, both claim keys (pure) + tests | [`src/lib/payroll/cycle-complete-trigger.ts`](../../src/lib/payroll/cycle-complete-trigger.ts) · `.test.ts` |
| Celebration — audience, claims, POST, audit (server) | [`src/lib/payroll/cycle-complete-notify.ts`](../../src/lib/payroll/cycle-complete-notify.ts) (`celebrateClosedCycle`) |
| Celebration — the three attached files (CSV/XLSX/PDF) | [`src/lib/payroll/cycle-close-attachments.ts`](../../src/lib/payroll/cycle-close-attachments.ts) · [`cycle-close-report-pdf.ts`](../../src/lib/payroll/cycle-close-report-pdf.ts) · `.test.ts` |
| Celebration — recipients / payload editor | [webhook-automations.md](./webhook-automations.md) |
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

**The server cannot derive the unpaid list, but it can disprove an entry (added 2026-09-02).**
`buildCycleCloseoutRecord` drops any reported-unpaid **employee** whose email has a **paid**
dispatch row in this cycle — the same (kind, email) pass-1 rule `tallyPaidDispatches` uses — and
counts the removals in `unpaid.reconciledPaid`. The case is real and now common: another clerk
pays someone seconds before Stop, the reporting screen has not reloaded, and without this the
record would list the person as unpaid on one line while its own paid tally counted them on the
next. Contractor entries are **never** pruned: an invoice is not identified by email alone, and
a contractor with one paid and one open invoice is legitimately both. The report CSV prints a
NOTICE line whenever `reconciledPaid > 0`; records written before this field parse it as 0.
The Payment Dispatch screen applies the same overlay before it reports (`paidElsewhere`, see
[dispatch-paid-toast.md](./dispatch-paid-toast.md) § "The table never lags the toast"), so the
server prune is the backstop, not the only line.

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

## Celebration email — ONE trigger, fired by the close itself (2026-09-04)

**Closing the cycle is the only thing that sends the `payment_cycle_complete` email, and the
close-out route sends it.** `POST /api/payment-dispatches/cycle-closeout`, after a **fresh**
INSERT (`already: false`), schedules `celebrateClosedCycle(record, actor)` with Next's `after()`
— it runs once the response has gone out. `already: true` fires nothing. There is **no client
endpoint** that can trigger it: `/api/payment-dispatches/cycle-complete` was deleted, and
Payment Dispatch's screen no longer contains any code path that sends a completion report.
Kane, 2026-09-04: *"this automation only triggers one way — stop processing + close payroll
cycle from the UI."*

**Every figure comes from the filed record.** `cycleCompleteStatsFromRecord` reads
`paid_count = record.paid.payeeCount`, `unpaid_count = record.unpaid.count + truncated`,
`total_count = paid + unpaid`, and the money from `record.paid`. Nothing a browser reports can
enter the email. This is what closed the gap below: the record is server-computed on the paid
side and is the clerk's *declared* list on the unpaid side, so a denominator cannot collapse to
"the rows my tab happened to hold".

**The shortfall is still reported, never hidden.** A closed week owing 19 people mails
`unpaid_count: 19`, and the n8n template words the email from that number — *"1,023 paid ·
19 still owed"*, with **100% PAID only when `unpaid_count` is 0**. The template's old habit of
always printing 100% PAID was itself a lie the payload never asked for; the shipped workflow
fixes it. Both `isReportableCycleComplete` refusals stand: nobody paid is never sendable, more
paid than the cycle held is a broken record.

**Three close-out files ride along.** `buildCycleCloseAttachments` renders the FINAL close-out
as CSV, XLSX and PDF — the same builders as the Stop dialog's download
(`cycle-close-report-export.ts`, plus `cycle-close-report-pdf.ts`), fed the record verbatim and
the cycle's paid rows via `selectAllPaged`, bank details last-4 only — and attaches them as
base64 (`attachments[]`). Raw total capped at 8 MB (n8n cloud takes 16 MB bodies; base64 costs
4/3): over the cap the live paid-detail section is dropped first and the email says so in
`attachments_error`. **A report can cost the report, never the email**: the builder never
throws, and a failed build ships `attachments: []` plus the error string.

**Two once-keys, both plain INSERTs on `app_settings` (key = primary key), claimed immediately
before the fetch:**

| Key | Meaning | Burned by reopen? |
|---|---|---|
| `dispatch.cycle_complete_notified.<file>` | the celebration — once per week, EVER | yes — INSERTed `suppressed_by: 'reopen'` (§ Reopening), unchanged |
| `dispatch.cycle_report_sent.<file>` | the files were mailed for this record | no — **DELETED** by reopen, so the re-close mails the new record's files |

A re-close after a reopen therefore sends **`celebrate: false`**: the same payload and files, and
the workflow sends a plain *"Close-out files — <week>"* email instead of confetti. Kane's
2026-08-14 rule that a reopened week never celebrates again is intact; the paperwork still
arrives. Delivery failure releases whichever keys this call inserted, so the next close of the
week can try again. Pre-checks (webhook configured? any recipients?) still run **before** the
claims, so an unwired environment or an empty audience never burns the week's one shot.

**Recipients.** Everyone holding the `accounting` role, revoked excluded — **as adjusted in
Admin → Webhooks → Open automation** (add/remove on top of the role, or a fixed list). See
[webhook-automations.md](./webhook-automations.md). Payload keys that carry the facts are
protected there and cannot be overridden.

**Ordering changed with this, deliberately (Kane, Q5, 2026-09-04).** Until now the email was
fired by the client *after* `setLocked(false)`. Now it follows the **record**, not the lock: the
close-out POST files the record, the response returns, `after()` sends the email while the
client flips the stop. The email may leave a second before the lock does. What has not changed
is what mattered: the record is written first, and neither the email nor the stop can abort or
reorder the other — a slow or dead n8n costs the email and nothing else, and its outcome is
logged (`console.warn`), never surfaced to the clerk. The in-app confetti still fires on the
client on the same trigger (a real close by this click).

**Audit.** `payment_cycle.completed` on `payment_dispatches`, awaited inside the callback,
carrying `via: 'cycle_closeout'`, `celebrate`, every stat, the recipient list, attachment
metadata and any `attachments_error`.

### History — why there used to be two triggers, and why there are none on the client

| Period | Trigger(s) | Ended by |
|---|---|---|
| 2026-07-30 → 08-14 | the strip hitting 100% (`fully_paid`) | — |
| 2026-08-14 → 09-04 | + closing the cycle (`cycle_closed`), client-fired after the stop | this change |
| 2026-09-04 → | the close-out route, server-side, record-derived | — |

The strip's arm fired **falsely twice**, and both times the mechanism was the same: the
browser reported its own denominator and the server validated it for internal consistency.

- **2026-08-18 20:16Z** — jakec@'s tab, Aug 9–15: *"1 of 1 paid"* while 1,026 were staged. A
  wizard unlock/re-lock blanked the queue ([payment-dispatch.md § 12.7.1](./payment-dispatch.md#1271-the-two-false-100-firings-history-of-the-removed-strip-trigger)).
- **2026-09-02 00:34Z** — lenny@'s tab, Aug 23–29 `(1).csv`: *"20 of 20 paid"* while the cycle
  held 1,053 rows. **No lock flip this time** — only 20 dispatch rows existed (all paid, the
  last at 00:09) and the tab held a queue with nothing pending, so `paid === total` was true.
  A second stale-queue path, never diagnosed client-side; it did not need to be. It also wrote
  two `payment_cycle.completed` audit rows seven seconds apart against one claim marker — an
  oddity that stays unexplained and, with the endpoint gone, cannot recur.

**Nothing in the queue's hydration was loosened or fixed to close this.** The client bugs in
§ 12.7.1 are still documented as OPEN; they can now only mis-paint a percentage, never send an
email. Freeing a burned week for a genuine re-send is still the manual script:

```
node --import tsx scripts/clear-cycle-complete-suppression.mts --source-file "<file>.csv" --apply --force-sent
```


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

**n8n — PENDING Kane (2026-09-04):** the celebration reuses the already-active
`payment_cycle_complete` slug (pointing at `…/webhook/payment-cycle-complete`), but the payload
now carries `attachments[]` (CSV/XLSX/PDF as base64), `celebrate` and `test`. The live workflow
ignores those fields until the updated
[payment-cycle-complete-celebration.workflow.json](../../references/n8n/payment-cycle-complete-celebration.workflow.json)
is imported — meanwhile the email sends exactly as before, without files. Import steps: import the
JSON over the existing workflow (same webhook path, so the URL does not change), attach the Gmail
OAuth2 credential to **both** Gmail nodes ("Send Email + Files" and "Send Email, no files"),
activate, then use Admin → Webhooks → Open automation → **Send test run to me** to confirm the
three files arrive. The `Has files?` IF node routes on `Object.keys($binary).length` — if an
n8n version rejects that expression, the fallback is to remove the IF and keep only the
with-files Gmail node (an email with no files would then error on that node and be caught by
`continueRegularOutput`). One new `app_settings` key family: `dispatch.cycle_report_sent.<source_file>`.

Audit action: `payment_cycle.closed` on resource `app_settings`, written **awaited** — it is the
trail for a declaration that money was left unpaid.
