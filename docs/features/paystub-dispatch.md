# Paystub Dispatch (n8n Integration)

End-to-end pipeline for sending weekly paystubs from the HRIS to employees' personal emails.

> **Changed (per-employee dispatch).** Paystubs are **no longer batch-emailed from the
> wizard**. The PayrollWizard's Dispatch step now **"Lock in Values & Send to Payment
> Dispatch"** — it *stages* each employee's authoritative paystub payload to the
> `paystub_dispatch_queue` table (no emails). The n8n paystub webhook then fires **one
> employee at a time**, server-side, when the payroll clerk (Lenny) marks that person
> **Paid** in Payment Dispatch. This spreads sends across the day (kinder to Gmail rate
> limits) and guarantees the emailed numbers exactly match what the wizard computed.

## Architecture

```
PayrollWizard (Dispatch step) — "Lock in Values & Send to Payment Dispatch"
        │
        │  POST /api/paystub-dispatch-queue  { source_file, pay_period, entries[] }
        ▼
paystub_dispatch_queue  (one row per (cycle, employee); payable + excluded)
        │
        │   …later, per employee…
        ▼
Payment Dispatch — Lenny clicks "Mark paid" (status='paid')
        │
        │  POST /api/payment-dispatches   (logs the payment)
        │     └─ server looks up the staged row by (cycle_source_file, recipient_email)
        │        and calls forwardPaystubDispatch({ pay_period, employees:[payload], cycle })
        ▼
Next.js → n8n webhook  (forwardPaystubDispatch, reads N8N_DISPATCH_WEBHOOK_URL server-only)
        │
        ├─ Webhook node
        ├─ Split Out (fieldsToSplitOut: "employees")   ← 1-element array = single paystub
        ├─ Loop Over Items (batchSize: 1)
        ├─ Gmail Send Email node — a PIPE: {{ $json.paystub_html }}
        └─ Respond to Webhook  { total, succeeded, failed, failed_emails }
```

The webhook URL is **kept server-side** in `N8N_DISPATCH_WEBHOOK_URL`. The browser never
sees it — both `/api/dispatch-paystubs` (manual/preview/re-send) and the per-employee send
inside `/api/payment-dispatches` forward through the shared `forwardPaystubDispatch` helper
(`src/lib/payroll/paystub-dispatch.ts`).

### Staging table — `paystub_dispatch_queue`

Migration #72: `references/seed_paystub_dispatch_queue.sql` (idempotent). **APPLIED** —
verified against production 2026-08-11 by `scripts/audit-pending-migrations.mts`
(9,815 rows). One row per
`UNIQUE (cycle_source_file, recipient_email)`:

- `recipient_email` is the **work** email (the match key against
  `payment_dispatches.recipient_email`); `personal_email` is where the paystub is mailed. A
  `BEFORE INSERT/UPDATE` trigger (`normalize_email_column`) lowercases/trims `recipient_email`,
  and a `paystub_queue_touch_updated_at` trigger bumps `updated_at` on every UPDATE.
- `payload` (JSONB) — the exact per-employee object the old batch posted to n8n. Staged for
  everyone resolved this cycle, **including** the excluded set (so they can be paid + emailed
  later from the Excluded tab). `pay_period` (JSONB) holds the top-level n8n pay-period block.
- `amount_php` / `amount_usd` — denormalized amounts so the Excluded tab + arrears rollup can
  show what's owed without unpacking `payload`.
- `excluded` / `exclude_reason` — `true` + `'do_not_pay'` when accounting ticked **Exclude**
  in the wizard's Validation step. Routes them to Payment Dispatch → Excluded.
- `sent_at` / `sent_by` / `send_count` / `last_error` — paystub send tracking (stamped by the
  mark-paid send path; survives a re-stage because those columns are omitted from the upsert).
- `locked_at` / `locked_by` — when the wizard locked + staged this cycle.

The migration also **re-asserts `app_settings` in the `supabase_realtime` publication** so the
[realtime dispatch lock](#lock--unlock--realtime-gate) is guaranteed live even if migration #12
was skipped.

Staging is **replace-for-cycle** (`upsertPaystubDispatchQueue`): a re-lock upserts the new set
(`ON CONFLICT (cycle_source_file, recipient_email)`) and prunes people no longer in the run —
deleting only the stale set with `sent_at IS NULL`, in 30-email batches to stay under the URL
length cap — but **never deletes a row whose paystub already went out** (`sent_at` set).

### Wizard Validation — "do not pay" exclusions

The Validation step (step 7) has a per-row **Exclude** tickbox (everyone defaults to Pay).
The set persists per pay-period at `app_settings` key `payroll.wizard.exclusions.<sourceFile>`.
Excluded people are dropped from the payable dispatch set (grand totals count payable only)
and staged as `excluded=true`, so they appear in Payment Dispatch → **Excluded** for
reconciliation. Lenny can still pay them from there once cleared — which logs the dispatch and
sends their staged paystub.

### Lock / unlock — realtime gate

Payment Dispatch shows **no queue data until accounting LOCKS the cycle**, and the lock is an
explicit, realtime, reversible flag:

- A per-cycle flag lives in `app_settings` under `payroll.dispatch_lock.<sourceFile>` (JSON
  `{ locked, lockedAt, lockedBy }`). `app_settings` is in the Supabase Realtime publication, so
  changes propagate live to every open dashboard — same mechanism as the dispute-pause lock.
- The wizard's **"Lock in Values & Send to Payment Dispatch"** stages the payloads **and** sets
  the flag `true`. The Dispatch step then shows a **"Locked — Payment Dispatch is live"** banner
  with an **Unlock** button; Unlock sets the flag `false` and **Payment Dispatch empties in real
  time**. Hook: `useWizardDispatchLock(sourceFile)` (`src/hooks/useWizardDispatchLock.ts`),
  modeled on `useDispatchLock`; only payroll/admin (elevated) can toggle, the clerk only reads.
- **While the cycle is locked, the primary button is DISABLED** (2026-09-03, Kane: "make sure
  this button is greyed out already"). It reads **"Locked in & sent to Payment Dispatch"** with a
  check icon, the banner names who locked it and when (`lockedBy` / `lockedAt`), and a line under
  the button says re-sending would overwrite paystubs the Dispatch office may already have paid.
  **Unlock → change → lock again is the only way to re-stage** — the same "unlock and re-lock"
  path every other doc names; clicking Lock while locked is no longer a re-lock. The button is
  also disabled while the flag is still hydrating ("Checking lock status…"), so a fast click
  cannot re-stage a cycle another tab locked, and the click handler re-checks both (the flag is
  carried by a 30s poll, not Realtime — [[dispatch-wizard-values-precedence]]). Precedence
  `dispatching → replay → lock-loading → locked → fx-missing → ready` is the pure, unit-tested
  `resolveDispatchButtonState` (`src/lib/payroll-wizard/dispatch-button-state.ts`); `disabled`
  and the label come from the same call so they cannot disagree. Why this is a tightening:
  `upsertPaystubDispatchQueue` re-stages `amount_php`/`payload` onto rows already **paid**
  ([[paystub-staged-snapshot-stale]], 2026-08-26 correction), so an accidental second click on a
  live cycle could make an emailed payload unrecoverable.
- `useDispatchQueue` derives `wizardReady` from this flag (an **absent flag = not locked**); when
  false it empties rows/excluded/paid and the UI shows a big **"Payroll Wizard isn't ready yet"**
  note (Accounting embed + standalone clerk page). The dispatch surfaces also subscribe to the
  flag and `refresh()` on change, so a lock/unlock appears/clears the queue within ~a second.
- **Fail-open**: only a *fetch error* leaves it ready, so a transient hiccup never blanks a
  genuinely-locked run. Reports / Urgent (MESA) / Orphanage tabs are independent and not gated.

### Master-list filter

Payment Dispatch only shows people who are on the **Global Master List** to begin with.
`computeCurrentPay()` returns `masterEmails` (every work/personal/alternate email in
`active_employees`, lowercased); `useDispatchQueue` filters both the pending and excluded
lists to those. Stale / off-boarded / never-mastered rates rows no longer appear. Fail-open:
if the master set is unavailable the queue isn't filtered (never blanks the whole queue).

### Excluded tab — cross-cycle arrears ledger

The Excluded tab is the reconciliation hub for held ("do not pay") people. It shows **what we
owe** even if they're not paid this week, and **accumulates across cycles**:

- `GET /api/paystub-dispatch-queue/arrears` (`listExcludedArrears()`) returns, per employee,
  every `excluded=true` staged cycle that is **not yet settled**, summed into a running
  `{ totalPhp, totalUsd, cycles[] }`. "Settled" = a `status='paid'` `payment_dispatches` row
  exists for that `(cycle_source_file, email)` — money actually moved, not just the email.
- The Excluded tab shows a header **"Owed ₱X (US$Y)"** total, and per held person their
  cumulative pending with an expandable **per-cycle breakdown** (each week + amount + send
  status). People owed from prior held cycles who aren't held this cycle still surface (so
  back-owed money never disappears), unless they're already payable in the pending queue.
- Each row shows the person's **preferred bank / processor**, and a **bank filter rail**
  (scoped to this tab only) lets accounting narrow the list by processor (or "No bank").
- **"Settle ₱X"** pays the full balance in one action: `PayrollDispatch.handleConfirmPaid`
  loops the unpaid cycles and POSTs one `/api/payment-dispatches` per cycle (same txn / bank /
  date, each cycle's own amount). Each POST fires that cycle's staged paystub server-side, syncs
  that cycle's `disbursement_records`, and audits it — so one settlement = a paystub per cycle,
  per-cycle books stay accurate, and the arrears clears on the next load.

### Audit trail

Everything lands in the Admin Audit log (`audit_log`): `paystubs.staged` (on lock+stage,
including the `excluded_emails` set held that cycle), `payment.dispatched` (per payment),
and `paystub.sent` / `paystub.send_failed` (per paystub). The per-cycle Audit panel surfaces
the same trail per cycle.

### Settle robustness + idempotency

The settle loop never aborts the whole run on one failed cycle: each cycle is posted
independently, results are tallied, the queue is reconciled from the server (`refresh()`), and
the toast reports `paid/total` with any failures. Because a successful payment drops its cycle
from arrears, a retry only re-runs the still-unpaid cycles — paid cycles never re-pay/re-email.
Within a single dialog the `submitting` flag blocks double-submits.

> **Optional follow-up (not done):** there's no DB unique constraint on `payment_dispatches`, so
> a pathological retry-before-refresh could in principle duplicate a cycle's payment. A partial
> unique index on `(cycle_source_file, lower(recipient_email), transaction_id, bank_used,
> sent_date)` + upsert in `insertPaymentDispatch` would make it bulletproof, but changes the
> existing insert semantics (which intentionally allows re-pays after an Undo), so it's deferred.

### Why server-side, and why it can't misfire on MESA

The single send lives inside `POST /api/payment-dispatches` (only on `status='paid'`), so it
covers every weekly-queue caller (`PayrollDispatch`, standalone `PayrollClerkApp`, and the
Excluded-tab "Pay now") with one code path. MESA disbursements (`/api/mesa-requests/{id}/dispatch`)
and orphanage budgets (`/api/orphanage-dispatches`) go through their **own** routes and never
hit this handler, so they can't trigger a salary paystub. The send is best-effort: a failed or
absent staged payload never fails the payment record — it's stamped on the queue row and the
clerk gets a warning toast (re-send via the Excluded tab).

## Environment variables

`.env` / `.env.local`:

```
N8N_DISPATCH_WEBHOOK_URL_TEST="https://<workspace>.app.n8n.cloud/webhook-test/confirm-dispatch"
N8N_DISPATCH_WEBHOOK_URL_PROD="https://<workspace>.app.n8n.cloud/webhook/confirm-dispatch"
# Active URL read by the API route. Point at TEST or PROD.
N8N_DISPATCH_WEBHOOK_URL="https://<workspace>.app.n8n.cloud/webhook-test/confirm-dispatch"
```

The **test** URL only fires while "Listen for test event" is active in the n8n editor — it captures one request then stops. For real dispatches, activate the workflow and point `N8N_DISPATCH_WEBHOOK_URL` at the `/webhook/` (production) URL. Restart the dev server after env changes.

## API routes

### Staging — `POST /api/paystub-dispatch-queue` (primary)

`app/api/paystub-dispatch-queue/route.ts`. The wizard's "Lock in Values & Send to Payment
Dispatch" posts `{ source_file, pay_period, entries[] }` here.

- Auth: `requireElevatedSession()` (payroll/admin) — same gate as the wizard's other writes.
  Lenny's narrower `payment_dispatch` grant is separate.
- `entries` filtered to those with a non-empty `recipient_email`, then upserted via
  `upsertPaystubDispatchQueue` (replace-for-cycle; see [Staging table](#staging-table--paystub_dispatch_queue)).
- Writes a `paystubs.staged` audit row (`{ staged, payable, excluded, excluded_emails[≤200] }`).
- Returns `{ staged, excluded, error }`.
- `GET /api/paystub-dispatch-queue?source_file=<file>` (view-gated) returns the lightweight
  list (no `payload` / bank creds) that `useDispatchQueue` uses to route excluded people.
- `GET /api/paystub-dispatch-queue/arrears` (view-gated) returns the cross-cycle owed rollup
  (see [Excluded tab](#excluded-tab--cross-cycle-arrears-ledger)).

> **Migration #72 (`paystub_dispatch_queue`) is APPLIED** — verified against production 2026-08-11 by `scripts/audit-pending-migrations.mts`
> (9,815 rows). This doc claimed PENDING long after it had run.

### Per-employee send — inside `POST /api/payment-dispatches`

When Lenny marks a salary dispatch **Paid** (`status='paid'` with a `cycle_source_file`), the
route looks up the staged row by `(cycle_source_file, recipient_email)`, runs it through
`getFreshPaystubEntry` (see next section) so the emailed figures reflect the latest wizard
snapshot, **reconciles the resulting total against the money actually paid**, persists the
chosen payload back onto the queue row, and — if a `payload` exists — calls
`forwardPaystubDispatch` for just that person. Best-effort: the result is
stamped on the queue row (`markPaystubSent` / `markPaystubSendError`) and returned as
`{ paystub: { staged, sent, error } }`; a send failure never fails the payment record.

### Paystub freshness — snapshot-over-staged merge

**The problem.** The staged `payload` is captured at lock time, but payments can be
priced **live** afterward (a rate change, an orphanage-pay edit, a late adjustment).
A 2026-07 incident emailed one employee ₱16,989.59 while paying ₱23,379.59, and
understated another's stub after a `175→225` rate change landed post-lock — the
**money was correct, the stubs were stale**.

**The fix** (`src/lib/payroll/paystub-fresh.ts`). The single source of truth is the
wizard's `payroll.wizard.final_pay.<file>` snapshot (which now carries
`regularRate` / `otRate` / `adjustmentNote`). `mergeSnapshotIntoStaged` (pure) +
`getFreshPaystubEntry` merge the snapshot figures **over** the staged
`paystub_dispatch_queue.payload`, but only when:

- the snapshot's `updated_at` is **newer than** the row's `locked_at`,
- the row is **itemized** (post-2026-07-18 payload shape),
- the match is by **work-email key only** — personal emails are shared/recycled, a
  cross-person risk, and
- the row is **not `excluded`** (settled-pay staged amounts win).

**At mark-paid**, the route **always** reconciles the stub total against
`row.amount_php` — even when the merge no-oped, to catch a queue priced off a
failed snapshot fetch: it emails the merged payload if it matches the money, the
staged one if THAT matches, else the merged payload plus a `paystub.amount_mismatch`
signal (toast + audit fields `stub_total_php` / `amount_php_paid` /
`amount_mismatch`). The chosen payload is persisted onto the queue row
(`refreshPaystubQueuePayload`) **before** n8n is called, and paid rows are then
**frozen as-paid** everywhere.

**Viewers** render **merged for unpaid, staged for paid** (Accounting + Employee
routes; the employee `?summary=1` / `?all=1` batch-merges). The wizard's
`publishFinalPaySnapshot` is **gated fail-closed** on `additionsHydratedFor ===
calcSourceFile` so a mid-load session can't publish zeroed additions.

**Known residual:** a stale wizard session re-publishing the snapshot can still
poison **unpaid**-row previews (clobber-on-write, no cross-session sync); the
mark-paid money reconciliation catches it before anything is emailed or frozen.

### Legacy batch — `app/api/dispatch-paystubs/route.ts` (no callers)

The old batch route is retained **only** for manual / preview / re-send and has **zero
callers in the app** — the wizard no longer hits it. It was given a `requireElevatedSession()`
gate (otherwise any authenticated user could fire arbitrary paystub emails through the
webhook). Behavior when called directly:

- Validates a `paystub_dispatch` webhook is configured (Admin → Webhooks or
  `N8N_DISPATCH_WEBHOOK_URL`); 500 if not.
- Parses body as JSON (400 on invalid), forwards via `forwardPaystubDispatch`.
- On non-2xx from n8n: 502 with `{ error, detail }`. On success: `{ ok: true, n8n: <parsed> }`.

## Webhook payload

Built in `dispatchData` (a `useMemo` in `PayrollWizard.tsx`) and posted as:

```jsonc
{
  "pay_period": {
    "currency": "PHP",
    "hubstaff_source_file": "simple-biz_daily_report_2026-04-05_to_2026-04-11.csv",
    "week": { "start": "2026-04-05", "end": "2026-04-11" },
    "pab_evaluation": {
      "month_label": "April 2026",
      "range_start": "2026-04-06",
      "range_end": "2026-05-01"
    }
  },
  "employees": [
    {
      "name": "Jane Dela Cruz",
      "email": "jane@work.example.com",
      "personal_email": "jane@gmail.com",
      "pay_period": { /* same shape as top-level, duplicated per row */ },
      "department_key": "site_building",
      "department_name": "Site Building",
      "hours": { "total": 42.5, "regular": 40, "ot": 2.5 },
      // HSL rows only — Sat+Sun carve-out of hours/pay_php (see "Weekend Hours (HSL)").
      // Null for every other department and when the upload had no daily columns.
      "weekend": {
        "hours": { "regular": 2, "ot": 0 },
        "pay_php": { "regular": 530, "ot": 0 },
        "premium_php_per_hour": 15
      },
      // Mid-week rate change only (a transfer / dated raise landing INSIDE the pay
      // week) — see "Mid-week proration". Null for single-rate weeks.
      "proration": {
        "effective_date": "2026-04-08",
        "old_rates_php": { "regular": 175, "ot": 262.5 },
        "new_rates_php": { "regular": 250, "ot": 375 },
        "segments": {
          "regular": [
            { "rate_php": 175, "hours": 16, "pay_php": 2800 },
            { "rate_php": 250, "hours": 24, "pay_php": 6000 }
          ],
          "ot": [{ "rate_php": 375, "hours": 2.5, "pay_php": 937.5 }],
          "weekend_regular": [],
          "weekend_ot": []
        }
      },
      "rates_php": { "regular": 250, "ot": 375 },
      "pay_php": {
        "regular": 10000,
        "ot": 937.5,
        "initial": 10937.5,
        "bonuses_total": 1850,
        "perfect_attendance_bonus": 0,
        "tech_bonus": 1850,
        "other_bonuses": 0,
        "final": 12787.5
      }
    }
  ]
}
```

### How each field is derived

| Field | Source |
|---|---|
| `pay_period.hubstaff_source_file` | `calcSourceFile` (selected Hubstaff CSV). |
| `pay_period.week` | `parseDateRangeFromFilename(calcSourceFile)` → `{ start, end }`. Falls back to Mon–Sun of the latest parseable date column if the filename doesn't match `YYYY-MM-DD_to_YYYY-MM-DD`. ISO-formatted. |
| `pay_period.pab_evaluation` | `pabMonthRange` — the PAB month inferred for the current UI context (see `BUSINESS_LOGIC.md#PAB month period`). |
| `personal_email` | Resolved per-row by `resolvePersonalEmail`: (1) rate row keyed by Hubstaff work email, (2) `global_master_list` match on `work_email`, (3) `global_master_list` name match via `normalizeNameTokens`. Rows without a resolvable personal email are **skipped** with a toast warning. |
| `department_key/name` | `employeeDepts[email]` → `DEPARTMENTS.find(...)`. |
| `hours.*` | From `effectiveCalcResults[].totalHours/regularHours/otHours`. |
| `rates_php.*` | From `effectiveCalcResults[].regularRate/otRate`. |
| `pay_php.regular/ot/initial` | From `effectiveCalcResults[]`. |
| `pay_php.perfect_attendance_bonus` | `isFinalPabWeek && toggles.perfect_attendance ? 5000 : 0`. Only attaches on the final weekly paystub of the PAB month. |
| `pay_php.tech_bonus` | `(isTechBonusWeek \|\| toggles.tech_bonus) && hasThirtyDays ? 1850 : 0`. Only on the paycheck whose salary date falls in the **3rd full Mon–Sun week** of its month (week 1 = first Mon–Sun whose Monday ≥ the 1st; week 3 = +14d) and only after 30 days of service. This lands tech bonus two weeks out from PAB. |
| `pay_php.other_bonuses` | `bonusTotals[email] − toggledPab − toggledTech`. Department-specific bonuses (collections tiers, per-ticket, etc.). |
| `pay_php.bonuses_total` | Recomposed: `perfect_attendance_bonus + tech_bonus + other_bonuses`. |
| `pay_php.final` | `initial + bonuses_total`. |

## Weekend Hours (HSL) — 2026-07-30

HSL (`hogan_smith_law`) works a 7-day week, so its paystubs itemize **Weekend Hours** under
Earnings. The `weekend` payload block carves the Sat+Sun portion OUT of the existing figures —
`hours.*` and `pay_php.regular/ot` stay the FULL week totals, so nothing that sums payloads
changed. Weekend pay = weekend hours × (base rate + ₱15/h premium); on a mid-week rate change
the wizard's proration accumulates the weekend money per day at each day's real rate.

**2026-08-07 (Kane): the weekend OVERTIME rate is gone.** A weekend hour past the chronological
40h cap is plain overtime — priced at the regular OT rate, no +15 — and it belongs to the
Overtime line, not the Weekend line. The +15 premium is scoped to weekend hours WITHIN the cap.
Newly staged payloads therefore always carry `weekend.hours.ot = 0` / `weekend.pay_php.ot = 0`;
the OT half of the block's shape survives because payloads staged before 2026-08-07 carry a real
weekend-OT carve (priced at `otRate + 15`) and must keep rendering exactly as staged. The three
engines are in lockstep: the wizard calc (`weekendPremiumByEmail`, regular bucket only),
`computeProratedRowPay` (current-pay.ts), and `proratePayForMidPeriodChange`
(prorate-mid-period.ts, whose `weekend.ot*`/`segments.weekendOt` are structurally empty now).

Renderers split the earnings rows only when the block is present (`weekend: null`, or a payload
staged before 2026-07-30, renders the classic two lines). **2026-08-07 (Kane's call): the two
weekend DISPLAY rows merged into one** — the statement shows a single **Weekend Hours** line and
"Overtime" is the only OT-labelled row. The payload block keeps the regular/OT split (the buckets
pay at different rates), and the wire/snapshot shape is unchanged:

| Line | Hours | Amount |
|---|---|---|
| Regular Hours | `hours.regular − weekend.hours.regular` | `pay_php.regular − weekend.pay_php.regular` |
| Overtime | `hours.ot − weekend.hours.ot` | `pay_php.ot − weekend.pay_php.ot` |
| Weekend Hours | `weekend.hours.regular + weekend.hours.ot` | `weekend.pay_php.regular + weekend.pay_php.ot` |

Weekday lines are derived by **subtraction**, so the three lines always sum exactly back to the
original two (rounding residue lands on the weekday line, never the total). Because a pre-2026-08-07
payload's two buckets pay at different premium-inclusive rates (regular at `base + 15`, OT at
`otRate + 15` — new payloads only ever fill the regular bucket),
the merged line's detail cell renders from `PayStubView.weekendBasis`: one entry → the classic
`H × ₱R`; two+ → total hours over a per-rate list (`2.00h @ ₱240.00 · 2.00h @ ₱352.50`), the
`MultiRateDetail` component / `multiRateDetail` email transcription. On a prorated week the basis
comes from the proration block's per-day weekend segments, and the line chips ONLY when a bucket
genuinely spanned the dated change (`ProrationView.weekend`) — a regular-rate segment beside an
OT-rate segment is the ordinary bucket mix, never a chip. `findRateConsistencyIssues` still
validates each bucket's arithmetic separately (a shortfall in one bucket must not hide behind a
surplus in the other) but reports both under the single `weekend` line id.

**Mid-week transfer INTO HSL — day-scoped weekend treatment (2026-07-30).** A transfer applies its
department label the moment it is released, but the Weekend Hours treatment follows the transfer's
**effective date** (`resolveHslWeekScope` in `hsl-week-model.ts`, fed by
`fetchHslTransferEffectiveByEmail` / `GET /api/payroll/hsl-transfers-bulk` over
`department_transfer_requests`):

- effective **inside** the pay week → that week already gets Weekend Hours, but only weekend days
  **on/after** the effective date earn the +₱15/h premium and appear in the weekend carve-out; a
  Sat/Sun worked before the transfer is an old-department day — plain rate, Regular line;
- effective **after** the week ends (label moved early) → no weekend treatment that week at all;
- effective on/before the week start, or no transfer on record → fully HSL, unchanged.

The rule runs identically in the wizard (`payDaysByEmail` → `weekendPremiumByEmail` →
`proratePayForMidPeriodChange`'s `hslFrom`), the dispatch compute (`computeProratedRowPay`'s
`hslFromDate`), and the disbursement-reports seeding path. Two adjacent fixes shipped with it:
the server engines now classify HSL via `normalizeDeptToKey` (previously an exact `"hsl"` string —
`hsl:*` sub-teams and `Hogan Smith Law` labels were silently paid WITHOUT the premium server-side
while the wizard paid it), and both `fetchAllRateHistory` and `/api/payroll/rate-history-bulk` now
paginate (the un-paged reads silently truncated at PostgREST's 1000-row cap once
`employee_rate_history` passed 9,000 rows, dropping old baseline rows from proration).

Where it shows (all driven by `PayStubView`'s `hasWeekend`/`weekday*`/`weekend*` fields):

- **Shared statement** (`PayStubStatement.tsx`) → Employee Dashboard modal, Employee Profile
  Pay Stubs tab, Salary-Paid notification, and Payment Dispatch's Accounting stub viewer.
- **Wizard Paystubs preview** (its own inline markup, same split).
- **Employee exports** (`paystub-export.ts`): XLSX carries merged Weekend Hours / Weekend Pay
  columns (both buckets — the per-bucket split collapsed 2026-08-07); the PDF's `Weekend` column
  shows the same merged figure. Regular/Overtime columns hold the weekday portion so a row still
  sums across to Net.
- **n8n email** — see below.

Freshness plumbing: `publishFinalPaySnapshot` writes `weekendRegularHours/OtHours/RegularPay/
OtPay` per employee (all-null = no block); `mergeSnapshotIntoStaged` rebuilds the payload's
`weekend` block from those fields whenever it merges newer figures, keeps the staged block
untouched under an old-shape snapshot, and nulls a stale block when the snapshot says the row
has none. The employee route's snapshot **fast path** rebuilds the split for never-locked weeks;
the `computeCurrentPay` slow path doesn't attempt it (those weeks predate the feature).

**n8n**: superseded — see [Statement rendering moved into the app](#statement-rendering-moved-into-the-app--2026-08-06).
The weekend rows reach the email because the app renders the whole document; there are no
`weekend_*` template vars to keep in sync any more.

## Mid-week proration — 2026-07-30

A department transfer (or any dated rate change) landing INSIDE the pay week pays a line at two
rates. The wizard's Step-2 calc already prorated the money per day (`proratePayForMidPeriodChange`,
extracted to `src/lib/payroll/prorate-mid-period.ts` and unit-tested); paystubs now EXPLAIN it. The
payload's `proration` block carries the effective date, both rate pairs, and per-rate **segments**
(hours + money each distinct rate actually paid — full-week `regular`/`ot`, plus the Sat+Sun
carve-out per rate for HSL). Affected lines keep their exact row — **never an extra row**:

- an amber **"Prorated" chip** joins the line label (same amber as the wizard's Step-2 badge);
- the Hours × Rate cell shows **`₱old → ₱new`** (previous rate muted, current emphasized — no
  strikethrough, both rates genuinely paid part of the week);
- a per-rate basis line follows in the same cell — `16.25h @ ₱175.00 · 23.75h @ ₱225.00 —
  effective Jul 22` — so the amount stays explicable arithmetic.

A line paid at ONE rate renders classic (e.g. OT that accrued entirely past the change date), as
does every payload with `proration: null`/absent — statements staged before the block existed are
byte-identical. Derivation lives in `paystub-view.ts` (`parseProrationBlock` →
`deriveProrationFields`): with an HSL weekend block the Regular/Overtime basis is weekday-scoped
(full segments minus the weekend carve-out, per rate) and the weekend lines' basis rates are
premium-inclusive, mirroring the row structure exactly.

**Individual Payment Catalog rates and the catalog-consistency rule (2026-07-30).** An
employee-scope catalog structure used to flatten the whole period (both engines bypassed per-day
history entirely), which silenced proration for nearly everyone once the catalog became the rate
source of truth. New rule, identical in BOTH engines (`historyMatchesCatalogAsOf` in
`rate-history-resolve.ts`, applied by the wizard's `proratePayForMidPeriodChange` and Dispatch's
`computeProratedRowPay` + the disbursement-reports seeding path): a catalog-managed person
prorates through their dated history **when the history is catalog-consistent** — the history rate
resolved as of their last worked day equals the structure (PHP structures only; the pay-structures
route writes a dated history row on every save, so a match proves the history is catalog-authored).
Any disagreement — stale structure, stale history, non-PHP currency — fails closed to the
flat-at-catalog week, so a superseded rate can never resurrect. Audit who splits vs. who conflicts
for a given week with `scripts/audit-catalog-history-conflicts.mjs`; conflicts need Accounting to
align the structure (or delete the bogus history row), after which the week prorates on re-lock.

**Ruling 2026-08-18 (Kane — "doc stands"): mid-week effective dates are real, and changed weeks
price at 2dp.** Three consequences, shipped together after 23 Lead Gen → HSL transfers
(eff 08-13/08-14) silently flattened to one rate:

1. **`insertRateHistoryRow` persists `effective_from` verbatim.** It used to snap every date back
   to the pay week's Sunday (`pay-week-effective-date.ts`, now **deleted**) on the theory that rate
   changes are week-grained — which rewrote the transfer dates Accounting had correctly typed to
   the week start and erased the proration this whole section exists to explain. A whole-week
   change is still expressible: enter it effective on the week's start date.
2. **A genuinely changed week prices every leg at 2dp HOURS × rate** (`priceChangedWeek2dp` in
   `prorate-mid-period.ts`, shared verbatim by the wizard's `proratePayForMidPeriodChange` and
   Dispatch's `computeProratedRowPay`): the per-rate basis line the statement prints multiplies out
   to the money exactly, and line totals are the sums of the displayed legs. Constant-rate weeks
   are untouched (HSL single-rate weeks already priced through `computeHoganWeekPay`). Expect the
   2dp segment HOURS to sum up to 0.01h off the raw headline total — the money is leg-exact.
3. **HSL overtime on a changed week counts ALL hours toward the 40h threshold** — pre-transfer
   days included — derived from the rounded totals like `computeHoganWeekPay` and attributed
   newest-rate-first (past-cap hours are chronologically the last hours of the week). The Hogan
   sheet's AK/AL transition columns exclude old-rate hours from its OT threshold; that reading was
   **rejected** — HRIS deliberately pays more than the sheet on transition weeks.

Same commit closed the same-date duplicate hole: both rate-history writers
(`pay-structures/route.ts`, `update-employee-rates/route.ts`) used to supersede only rows with
`effective_from >= today`, so a BACK-DATED re-save stacked same-date duplicates the resolver
ordered arbitrarily (cheskac@ held ₱355/₱175/₱355 all eff 2026-08-09). Both now also delete the
row on the SAME effective date — one row per (email, effective_from).

Where it shows (all via `PayStubView.proration`): the shared **`PayStubStatement`** (chip + detail
components exported for reuse), the **wizard Paystubs preview** (same components, same derivation),
and the **employee route's snapshot fast path** (`buildView`). Freshness plumbing mirrors the
weekend block: `publishFinalPaySnapshot` writes `proration` per employee (null = no change),
`mergeSnapshotIntoStaged` moves the block WITH the figures it explains (old-shape snapshot → staged
block kept; `null` → stale block cleared; jsonb key reordering ignored by the field-wise compare).

**n8n**: superseded — see [Statement rendering moved into the app](#statement-rendering-moved-into-the-app--2026-08-06).
The chip and the dual-rate detail cell are emitted by `paystub-email-html.ts`; no template vars.

## Mid-week transfer disclosure — 2026-08-25

A department transfer moves the person's **label the moment it is released**; the effective
date is only the anchor payroll prices by (`department-transfers.md` §2). So a week whose
effective date fell *inside* it printed the destination department and nothing else — the
statement read as though the person had been on that team all week. This is the department
counterpart to the proration chip: the money already explained itself, the department did not.

Under the Department line, a transferred week now reads:

> **Department**  Hogan Smith Law
> *Lead Gen to HSL*

Scale, measured on `department_transfer_requests` 2026-08-25: **277 of 281** dated transfers
are effective on a non-Sunday, i.e. mid-week. This is the common case, not an edge case.

### The payload block

`DispatchEmployee.department_transfer` (`PayrollWizard.tsx`), a sibling of `weekend` /
`proration` / `hogan_sheet`:

```jsonc
"department_transfer": {
  "legs": [
    { "from": "Lead Gen", "to": "hsl:intake_specialist", "effective_date": "2026-08-13" }
  ]
}
```

`from` / `to` are the **raw** transfer cells; the display form is derived, never stored — so a
sub-team rename cannot strand nine thousand frozen strings. Null for a quiet week and absent on
every payload staged before 2026-08-25: **those statements render byte-identical**, the same
contract the proration block carries.

**Not derived from `proration`.** *"A transfer is a relabel, only a rate change prorates"*
(`department-transfers.md`:280). raymandc@ and janrielr@ moved into HSL and back out inside the
2026-08-09 week with no rate on either side, so they carry no proration block at all — and they
are precisely the people this discloses. The source is `department_transfer_requests`.

**Staged, not derived at render time.** A paid stub is frozen as-paid; a transfer released next
month must not rewrite a statement already sitting in someone's inbox. The consequence is stated
plainly: **stubs already paid never gain the label**, including the documented 2026-08-09
round-trip weeks. Backfilling would mutate a legal pay record.

### `applied` only — deliberately narrower than the weekend-premium map

`buildTransferLegsByEmail` (`src/lib/payroll/department-transfer-legs.ts`) counts `applied`
rows **only**, where `buildHslTransferEffectiveMap` counts `applied` *and* `approved`. The two
gates answer different questions and must not be unified:

| Map | Question | Gate |
|---|---|---|
| `buildHslTransferEffectiveMap` | when did HSL work start? | `applied` + `approved` — the effective date is true whether or not the master row was ever written |
| `buildTransferLegsByEmail` | why does the Department line say what it says? | `applied` — the label only moves when `applyApprovedTransfer` writes `global_master_list."Department"` |

A row stuck at `approved` is one whose apply **failed**. Measured 2026-08-25: 276 `applied`,
**6 `approved` with a null `applied_at`** — every one still sitting in its old department.
Disclosing those would print "Lead Gen to HSL" under a Department line that still reads Lead Gen.

The second difference: this map keeps **every** move, including intra-HSL sub-team reshuffles.
The premium map skips those because a reshuffle is not an *arrival*; disclosure is a different
question. (Note the resulting inconsistency-by-construction: the bulk sub-department assignment
scripts wrote **zero** transfer rows, so those relabels are invisible here and always will be.)

### Where the data comes from

`GET /api/payroll/hsl-transfers-bulk` now does **one** paginated read of
`department_transfer_requests` (`fetchDepartmentTransferRows`) and returns **two** derived maps —
`effectiveByEmail` (unchanged) and `legsByEmail`. One read, so the week a stub discloses and the
week whose weekend premium it day-scopes can never come from different snapshots. The route keeps
its `requireRateVisibilitySession()` gate, which is also why every employee-facing surface reads
the label off the **staged payload** rather than fetching it.

The wizard bridges the map across master-list aliases exactly as it does the effective dates —
but as a **union**, not a latest-wins collapse: a person's legs are a list, and five people-weeks
in production hold two. The memo is in `dispatchData`'s dependency array; without it every payload
would stage against the empty pre-fetch map and the disclosure would silently vanish.

### The label

`formatTransferLabel` — both sides through `formatDeptLabel`, per `hsl-subdepartments.md` §12
(*"the paystub statement, its email and its export"*). A raw `hsl:<key>` can never reach it, and
that is pinned by test rather than by the source-scan guard, which does not reach this code.

| Week | Prints |
|---|---|
| one move | `Lead Gen to HSL` |
| a round trip (legs chain) | `Lead Gen to HSL to Lead Gen` |
| legs that do not chain | `Client VA to Lead Gen · HSL — Filing Specialist to Lead Gen` |

Chaining is decided on the **displayed** label, so it can only ever collapse two names a reader
sees as the same word — `HSL` followed by `HSL — Intake Specialist` stays two legs. hansc@'s
2026-08-16 week is the real non-chaining case; joining it would invent a move that never happened.

> **OPEN — Kane's call, one line to change either way.** The Department line resolves through
> `employeeDepts` → `DEPARTMENTS`, which collapses every `hsl:*` cell to the parent name **Hogan
> Smith Law**. The label's `to` side is the raw transfer cell through `formatDeptLabel`, so it
> prints **HSL — Intake Specialist**. A transferred HSL person's stub therefore carries two names
> for one department. Shipped as Kane specified it (*"it should say Lead Gen to HSL"*), which is
> also the more informative side — the sub-team is the part you cannot see anywhere else on the
> document. The alternative is to resolve both sides through the same `DEPARTMENTS` path, giving
> `Lead Gen to Hogan Smith Law` — one vocabulary per document, and intra-HSL reshuffles would
> then vanish on their own (both sides resolve to the same name).

### Where it shows

All via `PayStubView.departmentTransfer`, which carries the **already-formatted** `label` plus
the raw `legs`. Putting the derivation on the view is the fix for the failure this area suffered
twice (weekend rows and the proration chip both shipped in-app while the email stayed stale): the
component and its email transcription print one string, and a parity test pins it.

- **Shared statement** (`PayStubStatement.tsx`) → Employee Dashboard modal, Employee Profile
  Pay Stubs tab, the Salary-Paid notification, and Payment Dispatch's Accounting stub viewer.
- **Emailed statement** (`paystub-email-html.ts`) — escaped, same 11px muted treatment.
- **Wizard Step-8 preview** — renders `PayStubStatement`, so free.
- **Employee exports** (`paystub-export.ts`): XLSX gets a fixed **Department Change** column; the
  PDF gets an `optional` one, which the measured-layout filter drops entirely for anyone who never
  moved. When present it is the only wide left-aligned text column in a money table — the layout
  answers by stepping the body font down and ellipsizing at the floor, so it can shrink the sheet
  but never overlap a column. Truncating a department name on a pay record is the worse trade.
  The export's **header** is a different question and answers it differently — it names the
  CURRENT department, see [Exported stubs name the CURRENT department](#exported-stubs-name-the-current-department--2026-08-26).

Freshness plumbing mirrors the other blocks: `publishFinalPaySnapshot` writes `departmentTransfer`
per employee, and `mergeSnapshotIntoStaged` applies the same tri-state (`undefined` = older
snapshot, keep staged; `null` = no move this week, clear a stale block; object = replace). One
difference matters: this is the **only** block that explains no money, so it can be the sole thing
that differs between a snapshot and the staged payload — `transferChanged` counts into `changed`
on its own, or a transfer released after the lock could never reach an unpaid stub.
`sameTransferBlock` compares a sorted set of `date|from|to` keys, so neither jsonb key reordering
nor leg order forces an endless refresh, and an empty leg list compares equal to an absent block.

**Not covered, on purpose:** the employee route's `computeCurrentPay` **reconstruction** path gets
no label — the same precedent the weekend block set for pre-feature weeks. That path also stamps
**today's** department onto every reconstructed week, so adding a disclosure on top of an already
ahistorical Department line would explain the wrong thing.

## Exported stubs name the CURRENT department — 2026-08-26

Kane: *"when someone exports their PDF Paystubs whether approved by accounting or not it should
have the latest Department."* The document header of the Pay Stubs **PDF and XLSX** now names the
department the roster holds **today**, on every week the export covers — paid, staged, or
reconstructed — marked `(current)`:

> Employee: Jean Auditor · HSL — Filing Specialist (current)

**Why this does not contradict "a paid stub is frozen."** What is frozen is the **money** and the
per-week record — the payload is never rewritten and the per-week rows are untouched. A person's
department is a fact about *them*, not about that week: a transfer moves the label the moment it is
released (`department-transfers.md` §2), so an export run today that headed itself with a
department they left in July would simply be wrong about them now. The in-week moves keep being
explained where they belong — the per-week **Department Change** column, unchanged.

**One resolution, one place.** `GET /api/employee/paystub` (single-week **and** `?all=1`) and
`GET /api/accounting/paystub` both return `currentDepartment` off the master record they already
read (`getEmployeeMasterRecord`, which is active-rows-only and orders by `last_seen_upload_id`, so
a duplicated identity resolves to the newest upload's row). Every export caller passes **that**:
`PayStubModal`'s single-week download (which previously passed the week's frozen
`paystub.department` — the one genuinely stale header), the Pay Stubs tab's PDF + XLSX, and
`RequestDocumentsTab`'s signing packet. Three call sites, one server-side resolution.

**The fallback is a state, not a mask.** `resolveExportDepartment` (`paystub-export.ts`, pure +
tested) takes `currentDepartment` first; a **null** one is real — an off-boarded person has no
active master row at all — and it then falls back to the **newest week's** own department and
deliberately does **not** print `(current)`. A blank or `—` on either side is not a department.
Both sides go through `formatDeptLabel`, so a raw `hsl:*` key can never reach a header
(`hsl-subdepartments.md` §12); a test pins that.

**Deliberately unchanged:** the in-app `PayStubStatement` Department line and the emailed
statement still show the week's own department. Those are the statement as issued; the export
header is a document about the person. `?summary=1` gains no field — it drives the list, not an
export.

## Native COP line for Colombian payees — 2026-07-30

Colombian staff ride the **PHP** rails (no COP Pay Structure exists for them), so their
statements used to show only pesos. The paystub readers now resolve a display-only
`countryCurrency` marker from the hire's **submitted** onboarding `country` —
`resolveCountryCurrencyForEmails` + `getUsdToCopRate` in
[`src/lib/payroll/cop-country.ts`](../../src/lib/payroll/cop-country.ts) — and
`paystub-view.ts` derives a native-COP equivalent from the PHP figures at the *same* rate
`buildFxRates` gives the dispatch queue. The PHP arithmetic on the stub is untouched, so
every line still reconciles. Never trust `invite_country` for this (documented misclicks).
Full rule: [cop-country-payees.md](./cop-country-payees.md).

## Rate snapshots toggle (Dispatch step) — 2026-07-30

A pill with a switch labeled **Rate snapshots** sits beside the *Lock in Values & Send to
Payment Dispatch* button. It persists per browser (`localStorage`), so it survives payroll
runs. With it on, opening any paystub from **Preview Emails → View** slides two floating
comparison cards out from behind the statement (staggered, 0.5s, the wizard's own
cubic-bezier):

| Card | Shows |
|---|---|
| **Left — "People Tab · Banking Info"** | the person's rate resolved with the **exact precedence the People tab uses** (catalog individual → rates sheet → dept base) in native currency with a source chip, plus their masked payout details fetched live from the same `/api/people/[email]` endpoint the People drawer uses — processor, and **only the chosen rail's fields** (bank/holder/account/routing/SWIFT for wires/jeeves/wise; the processor-specific fields otherwise), including alternative-slot handling |
| **Right — "Payment Catalog"** | the structure covering that person — individual structure with assigned-to/email/department/last-updated metadata, or the department base (labeled **"Fallback only"** when a higher-precedence rate actually pays them), or a "Not in the catalog" empty state |

Both cards carry a **verdict chip** comparing the source's PHP-equivalent against the rate
the stub actually pays — green *"Matches the paystub rate"* / amber *"Differs"* — plus a
footer stating what the stub pays. A **prorated** week says *"stub prorates a mid-week
change"* instead of raising a false alarm; non-PHP rates show their ≈₱ equivalent.

> **Two implementation constraints that will break if changed:**
>
> 1. The cards are rendered as **children of the dialog popup, positioned outside its box** —
>    *not* portals. Base UI's dismiss boundary plus the app's stacking contexts mean a
>    portaled card is either dismissed on click or trapped under other chrome; as popup
>    children they stay scrollable and clickable without ever closing the paystub.
> 2. They render only at viewports **≥1180px**. Narrower windows show a
>    *"Rate snapshots need a wider window"* hint in the preview header instead.
>
> The People-tab rate is mirrored **client-side from the RAW sheet index**, not from the
> catalog-overlaid `ratesByEmail` — otherwise both cards would show the catalog number and
> the comparison would be vacuous.

## Gating summary (dispatch-time)

- **Final PAB week**: `week.end >= pabMonthRange.end` where `pabMonthRange` is **derived from the dispatch week's own Monday** (not from merged uploads' mode month).
- **3rd-paycheck tech week**: `week.start` falls within the 3rd calendar week of the dispatch week's PAB month. Week 1 = Mon–Sun week containing the 1st of the month.
- **30 days of service**: `week.start >= (start_date + 30 days)`. `start_date` is looked up from `masterEmployees` keyed by work email + personal email.

See `BUSINESS_LOGIC.md#Technology Bonus` and `#Weekly gating for monthly bonuses` for the full business rules.

## Preview Paystubs modal

The Dispatch step's "Preview Paystubs" button opens a modal built from the same `dispatchData` rows that will be posted. Two views:

1. **List view**: searchable (filter by name, work email, personal email, or department), one row per employee — name + department chip + **work email**, the whole row being the "View" target.
2. **Detail view**: the shared `PayStubStatement`, the very component the employee sees in their Pay Stubs modal, rendered from `mapPayloadToPayStub(row)`. "← All recipients" returns to the list.

State: `previewPaystubsOpen`, `previewSelectedEmail`, `previewSearch`, `previewTab`, `previewDept`, `previewPage`. All reset on modal close.

### Work email is DISPLAYED; personal email is SEARCHED — 2026-09-01

The row's second line is the **work email** (`DispatchEmployee.email`), not the personal
address. The work email is the identity a payroll clerk can recognise and cross-check
against the roster, the People tab, and the Payment Catalog; a bare gmail address is not.
It is also already this row's identity key everywhere else in the flow —
`recipient_email` on the staged entry, `previewSelectedEmail`, and the
`/api/people/[email]` banking lookup behind the rate-snapshot cards all key on it.

The personal address stays **searchable** (`filteredPaystubs` still matches
`e.personal_email`) so pasting a gmail out of an inbox still finds the person. It is no
longer displayed.

> **The delivery address is still the personal one.** The n8n paystub workflow mails to
> `personal_email` and silently *skips* a recipient it cannot mail (see "A zero `failed`
> is NOT delivery either" in `app/api/payment-dispatches/route.ts`). Preview Emails is a
> **content** preview — read the statement, confirm the money — not a delivery-address
> audit. Missing personal emails are surfaced where they are actionable: the
> *Lock in Values & Send to Payment Dispatch* button raises a
> "N payable employees without a personal email" warning, and Payroll Readiness blocks
> on it. Do not "fix" this by putting the personal email back on the row.

### Wizard-theme chrome — 2026-09-01

The modal wears the Payroll Wizard's own vocabulary rather than generic dialog chrome:
the indigo→violet→fuchsia gradient chip with its `ring-1 ring-inset ring-white/25`
(identical construction to the wizard title chip and the progress-bar fill), the
white→indigo→white header and footer bands, the wizard's `animate-ping` live dot (amber,
reading "Not sent yet"), mono numerals for counts and pagination, and a segmented control
whose active pill is a shared `layoutId="preview-tab-indicator"` element so it slides
between tabs the way the stepper's `layoutId="active-indicator"` does. Every animation is
gated on the component's existing `reduceMotion`. The detail view's chrome stays
paper-light in both themes because the pane below it is a document.

Two structural fixes landed with it, both instances of the documented `p-0` dialog trap
(`docs/design/responsive-design.md` § "Dialogs and modals"): the popup now passes
**`gap-0`** (the shared `DialogContent` is `grid gap-4`, so the flush sections were
separated by three 16px seams showing the popup's own orange/blue gradient through) and a
real **height cap** (`max-h-[calc(100dvh-1.5rem)] sm:max-h-[90dvh]`; the base primitive
has none, so a full recipient list on a short window was clipped at both ends with its
pager unreachable). The list body is `min-h-0 flex-1 overflow-y-auto` between `shrink-0`
chrome.

## Statement rendering moved into the app — 2026-08-06

The emailed statement is now **rendered by the HRIS** and posted to n8n as a finished document.

**Why.** The HTML used to live inside the n8n Gmail node, hand-written against a flat `pay_vars`
Set node. Every statement change therefore needed a matching hand-edit in n8n, and twice it didn't
happen: both the HSL **weekend rows** (2026-07-30) and the **proration chip** shipped with a
"re-import the live n8n instance" note in this document that was never actioned. Employees were
reading one breakdown in their Pay Stubs tab and a different one in their inbox — for the same
payment. A pay document that contradicts itself is not a cosmetic bug, and no process fix was going
to hold, because the failure mode was silent.

**How it works now.**

| Piece | Where |
|---|---|
| The view (one source of truth) | `mapPayloadToPayStub` → `PayStubView` in `src/lib/payroll/paystub-view.ts` |
| In-app statement | `src/components/paystub/PayStubStatement.tsx` |
| Wizard Step-8 preview | **renders `PayStubStatement`** — no longer a hand-copied duplicate |
| Emailed statement | `src/lib/payroll/paystub-email-html.ts` (`renderPayStubEmailHtml`) |
| n8n | pipes `{{ $json.paystub_html }}` into Gmail |

`forwardPaystubDispatch` decorates every employee item with `paystub_subject` + `paystub_html`
before posting. It does this in the shared helper rather than at each call site, so a future sender
cannot forget to render the document. The mark-paid path passes its **reconciled** view (the one
whose total matches the money the row just recorded, plus `amount_cop` for Colombian payees) via
`views[]`; anything else is derived from the payload itself.

**Line visibility** is decided once, in `paystub-view.ts`, and obeyed by all three surfaces:

- **Weekend Hours** (one merged row since 2026-08-07 — both pay buckets, per-rate basis) — only
  when `hasWeekend` (HSL/Hogan weeks carrying a Sat+Sun carve-out). Non-HSL statements have no
  weekend row at all.
- **Orphanage** — only when there is money on it (`showsOrphanageLine`). It used to print `₱0.00`
  on everyone's statement.
- **Everything else** — Regular, Overtime, Tech, Attendance, Performance, Adjustment and the MESA
  pair — always renders, `₱0.00` included, so the breakdown reconciles to Net the same way on every
  document.

**Editing the statement.** Change `PayStubStatement.tsx` and `paystub-email-html.ts` together; the
component is the reference and the renderer is its email-safe transcription (tables + inline styles,
since email clients have no flexbox). `src/lib/payroll/paystub-email-html.test.ts` pins the parts
that drifted before. **Do not paste HTML back into the n8n Gmail node** — that is the exact
regression this replaced.

## n8n workflow

Import-ready JSON: `references/n8n/paystub-dispatch.workflow.json`. Nodes:

- **Webhook** (`POST /confirm-dispatch`): receives `{ pay_period, cycle, employees[] }`.
- **Split Out** (`fieldsToSplitOut: body.employees`): one item per employee.
- **Batch 100 Recipients** (`splitInBatches`, reset false): the send loop.
- **If**: skips an item with no valid `personal_email`, no `pay_period.week`, **or no
  `paystub_html`** — a payload from an older HRIS build is skipped, never mailed blank.
- **Normalize Email** (`includeOtherFields: true`). The old `pay_vars` Set node is **gone** — it
  existed only to feed the template.
- **Wait 600ms**: throttles below Gmail's ~2 sends/sec per-user API cap.
- **Send PayStub** (Gmail): `subject` = `{{ $json.paystub_subject }}`,
  `message` = `{{ $json.paystub_html }}`. `onError: continueErrorOutput`.
- **Aggregate → Build Summary Report → Respond to Webhook**:
  `{ total, succeeded, failed, skipped, failed_emails }`. The HRIS reads `succeeded`, `failed` and
  `failed_emails` — **keep all three field names**.

### Two traps in the summary node

Both were live bugs; the reference JSON has them fixed, so don't hand-edit them back out.

1. **Guard every cross-node reference with `.isExecuted`.** When all items are skipped,
   `Send PayStub1` never runs, and a bare `$items('Send PayStub1')` aborts the whole response with
   *"An expression references this node, but the node is unexecuted."* Week dates come straight off
   the webhook body for the same reason — it is the one node guaranteed to have executed.
2. **Skipped items count into `failed`.** Someone skipped did not get their paystub. The HRIS
   derives `delivered` from the summary, and a run reporting `{succeeded: 0, failed: 0}` used to
   score as delivered — stamping "paystub sent" on a row that was never emailed. `failed_emails`
   carries `Skipped — <reason>`, which is what lands in the queue row's `last_error`.

The app enforces the same rule independently (`/api/payment-dispatches`): a summary that reports a
`succeeded` count must report **at least one** success, or the send is recorded as failed. A
summary with no `succeeded` field at all (an older workflow) still falls back to HTTP-ok.

`docs/features/paystub.html` is retained as a static design reference only; it is not the source of
any sent email.

### Known limits

- **Gmail consumer**: ~500/day, ~2/sec per-user API cap → `FAILED_PRECONDITION` on burst sends. Not viable for 1,000-employee runs.
- **Gmail Workspace**: ~2,000/day. Marginal for 1,000 runs, still rate-limited per-second.
- **Recommended for production volume**: Resend Pro ($20/mo, 50k/mo, 100 req/sec batch API), SES, or SendGrid. Switch the Gmail node for the provider's node; `pay_vars` mappings stay the same.

### Resilience checklist (in-workflow)

- Toggle **Continue on Fail** on the Send Email node.
- Enable **Retry on Fail** (Max Tries 5, Wait 2000 ms) for transient API errors.
- Route failures to a `failed_dispatches` Set/Sheet node capturing `{ personal_email, name, itemIndex, error, timestamp }`.
- Add a filter before Send Email requiring `personal_email` to match an email regex after trim+lowercase.

## UI signals in the HRIS

- **n8n pill** on the Dispatch step: small pink badge reading "Paystubs send 1-by-1 from Payment Dispatch · n8n on Mark Paid" with an n8n favicon, linking to the n8n Cloud workspace. Signals that emails fire per-person from Payment Dispatch (not in a batch here).
- **Running red-light animation**: while `isDispatching === true` the Dispatch panel gets a conic-gradient red light running around its edges (1.6s per rotation). Button disables and label changes to "Sending to Dispatch…". Controlled by the `dispatch-running-light` CSS class embedded alongside the JSX (inline `<style>` for scoped keyframes).

## Client-side lock-and-stage flow

The Dispatch step's primary button is **"Lock in Values & Send to Payment Dispatch"** (its
`onClick`, ~`PayrollWizard.tsx:10689`). It **stages** — it does **not** email:

```
"Lock in Values & Send to Payment Dispatch" onClick
 ├─ isReplay → error toast (past periods are view-only); bail.
 ├─ No calcSourceFile → error toast; bail.
 ├─ Read dispatchData { rows, excludedRows, missing, payPeriodPayload }.
 ├─ Empty rows + excludedRows → "Nothing to send" toast; bail.
 ├─ missing.length > 0 → warning toast (≤5 names without a personal email — no paystub emailed).
 ├─ Build `entries` = payable rows (excluded:false) + excludedRows (excluded:true, exclude_reason),
 │   each with recipient_email, personal_email, name, department_key, amount_php, amount_usd
 │   (PHP/usdToPhpRate), and the full `payload`.
 ├─ setIsDispatching(true)  → red-light animation + disabled button.
 ├─ POST /api/paystub-dispatch-queue { source_file, pay_period, entries }
 │    ├─ !res.ok || data.error → error toast "Send to Payment Dispatch failed"; bail.
 │    └─ ok →
 │         ├─ dispatchValuesLock.setLocked(true)   (flip the realtime lock → Dispatch goes live; best-effort)
 │         ├─ success toast (N payable staged · M excluded)
 │         ├─ publishFinalPaySnapshot()  + broadcastSave()
 │         ├─ setReportSnapshot(...) + setReportsTab('salaries')
 │         └─ setCurrentStep(9)   (advance to the Report step)
 └─ finally → setIsDispatching(false)
```

The Dispatch panel still shows the **running red-light animation** while `isDispatching`
(button label → "Sending to Dispatch…"). Below the staging button, a realtime lock card
(`dispatchValuesLock`, see [Lock / unlock](#lock--unlock--realtime-gate)) shows
**"Locked — Payment Dispatch is live for this cycle"** + an **Unlock** button when locked, or
an amber "Unlocked — Payment Dispatch stays empty…" note otherwise.

## Recovered-week snapshots, engine memo and early prune — 2026-09-03

Kane: *"It takes like a long time to load though especially the paystubs."* Measured
read-only against the live database: 28 upload weeks, of which **14 (Mar–early May 2026)
had neither a wizard `final_pay` snapshot nor a staged payload**. For each of those the
employee `?summary=1` route ran the whole-company engine (`computeCurrentPay`, ~6.6 s,
~740 people), six at a time, on every open by every employee — ~15–20 s before the list
painted — and the answer is identical for every viewer. Duplicate-week files (a backfill
re-upload, a 4-week `time-activity-report`) each cost a run and were then discarded by
the one-row-per-week dedupe.

### The key decision: a paystub-ONLY key, never `payroll.wizard.final_pay.*`

`payroll.wizard.final_pay.<file>` means *"the exact net pay the wizard computed on the day
= what Payment Dispatch paid out"*. Payment Dispatch **prices** from it
(`useDispatchQueue`), the wizard **replays** from it, the Overview trusts it as take-home.
An engine run made today from today's rates table is none of those things
(`rate-updated-at-not-evidence`: the sheet silently re-prices history), so the recovered
figures are persisted under **`paystub.recovered.<file>`** instead, and that key has
exactly one reader: the recovery tiers of `app/api/employee/paystub/route.ts`. It is
consulted only when a week has no wizard snapshot and no staged payload, and it carries
the same figures those viewers already saw.

Shared pure module: `src/lib/payroll/paystub-recovered.ts`.

| Invariant | Enforced by |
|---|---|
| Snapshot is stamped with the Hubstaff **`upload_id`**; trusted only while stored AND current batch ids are both present and equal. Unstamped or unknown batch → `stale` → engine (today's behaviour, fail closed). | `readRecoveredSnapshot` (+ test) |
| Whole-company, whole-week: a **match without the caller** = "not in this week" (the engine's own verdict). `recoveredWeekClosed` is set and the route must **not** re-run the engine. | `loadRecoveryForWeeks` → `reconstructStubForWeek` early return |
| `buildRecoveredEntry` mirrors the route's engine-only branch line for line and emits an **itemized** `WizardFinalPayEntry`, so the route renders it through the same fast path a wizard snapshot takes. The backfill script and the route call the one function. | `paystub-recovered.test.ts` |
| Adjustment / Orphanage overlay gated on `hasRate`, performance 0, MESA disbursement 0 — as the wizard drops them for no-rate people. | same test |
| Never written under the wizard prefix. | script asserts the prefix before every upsert |

### Recovery tiers, batched

`loadRecoveryForWeeks(files, emails, uploadIdByFile)` makes **one** `app_settings`
`.in()` read for three keys × N weeks — wizard `final_pay`, `paystub.recovered`, and the
`additions` blob — and returns a `WeekDiscretionary` per week with `source: "wizard" |
"recovered" | null`. Precedence is never mixed: a wizard snapshot for the caller wins; else
a matching recovered snapshot; else nothing (engine). `reconstructStubForWeek` now takes
`disc` and `uploadId` as parameters and does **no reads of its own**; the single-week
modal, the summary list and the all-weeks export all go through the same loader.

### Engine memo

`src/lib/payroll/engine-week-memo.ts`: per-process memo of `computeCurrentPay` results
keyed by `(sourceFile, uploadId)`, **5-minute TTL**, rejections evicted, unknown batch → no
key → no memo. Only the engine path uses it; staged payloads and wizard snapshots are never
memoized (a re-lock can change them). It bounds how long a viewer of an **unpublished**
week — one the wizard has not yet snapshotted — can lag a rates/hours edit.

### Prune before the engine

`dropDominatedCandidates` (`paystub-week-dedupe.ts`) removes non-staged files the final
`dedupeOneRowPerWeek` would discard anyway: those beaten or tied by a staged incumbent for
the same Sunday-anchored week, and all but the winner among candidates for one week. Same
`beats` precedence (paid > staged > newest upload), ties to the incumbent / first
occurrence, non-week shapes (>9-day aggregates, unparseable) pass through. A test pins
`dedupe(prune(candidates))` ≡ `dedupe(candidates)`. The final dedupe still runs as the
guardrail.

### Backfill

`scripts/backfill-paystub-recovered-snapshots.mts` — dry run by default (prints the
plan, builds every snapshot, writes nothing); `--apply` first writes a SELECT backup of
all existing `paystub.recovered.*` rows to `references/backups/`, then upserts;
`--force` recomputes weeks whose snapshot is already current; `--file <name>` narrows.
Reversal = delete the written keys (the backup names them). A re-upload of a week already
invalidates its snapshot by batch id; re-run the script to refresh it.

**Client half** (Profile): the identity fetch is one wave instead of three serial hops, and
the Profile + Pay Stubs summary are wired into the reload cache — see
`employee-dashboard-cache.md`. **Still open:** `/api/employees?email=` pages the whole
active roster to find one person (needs the employee-ID serial rule — its own pass); the
FX key is fetched twice per Profile load. Flipping `SHOW_UNPAID_STAGED_PAYSTUBS` to false at
launch disables the whole recovery path, this key included.

## References

- Recovered snapshots: `src/lib/payroll/paystub-recovered.ts` · `paystub-recovery.ts` (`loadRecoveryForWeeks`) · `engine-week-memo.ts` · `scripts/backfill-paystub-recovered-snapshots.mts`.
- Migration: `references/seed_paystub_dispatch_queue.sql` (`paystub_dispatch_queue` — **APPLIED**, migration #72, verified 2026-08-11).
- Workflow JSON: `references/n8n_paystub_dispatch.json`.
- Business rules: `Documentation/BUSINESS_LOGIC.md`.
- Routes: `app/api/paystub-dispatch-queue/route.ts` (+ `arrears/`), `app/api/payment-dispatches/route.ts` (per-employee send on Mark Paid), `app/api/dispatch-paystubs/route.ts` (legacy batch, no callers).
- Shared send helper: `src/lib/payroll/paystub-dispatch.ts` (`forwardPaystubDispatch`).
- Mid-week transfer disclosure: `src/lib/payroll/department-transfer-legs.ts` (`buildTransferLegsByEmail`, `transferBlockForWeek`, `formatTransferLabel`) + `src/lib/payroll/hsl-transfer-effective.ts` (`fetchDepartmentTransferRows`).
- Paystub freshness: `src/lib/payroll/paystub-fresh.ts` (`mergeSnapshotIntoStaged`, `getFreshPaystubEntry`, `refreshPaystubQueuePayload`).
- Queue data access: `src/lib/supabase/paystub-dispatch-queue.ts` (`upsertPaystubDispatchQueue`, `getPaystubDispatchEntry`, `listExcludedArrears`, `markPaystubSent` / `markPaystubSendError`).
- Realtime lock hook: `src/hooks/useWizardDispatchLock.ts`.
- Clerk-side queue: `src/components/payroll-clerk/useDispatchQueue.ts` + `ExcludedQueue.tsx`.
- Wizard: `src/components/PayrollWizard.tsx` (`dispatchData` useMemo + Dispatch step JSX + Preview modal).
