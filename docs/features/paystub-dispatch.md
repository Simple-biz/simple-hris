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
        ├─ Set node "pay_vars" (maps webhook fields → template names)
        ├─ Gmail / Resend Send Email node (renders HTML paystub)
        └─ Respond to Webhook  { status, sent }
```

The webhook URL is **kept server-side** in `N8N_DISPATCH_WEBHOOK_URL`. The browser never
sees it — both `/api/dispatch-paystubs` (manual/preview/re-send) and the per-employee send
inside `/api/payment-dispatches` forward through the shared `forwardPaystubDispatch` helper
(`src/lib/payroll/paystub-dispatch.ts`).

### Staging table — `paystub_dispatch_queue`

Migration #72: `references/seed_paystub_dispatch_queue.sql` (idempotent). **PENDING** — until
it's run, the wizard's "Lock & Send" 500s. One row per
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

> **Migration #72 (`paystub_dispatch_queue`) is PENDING.** Until it's run in the Supabase
> SQL editor, "Lock & Send" **500s** (the table doesn't exist).

### Per-employee send — inside `POST /api/payment-dispatches`

When Lenny marks a salary dispatch **Paid** (`status='paid'` with a `cycle_source_file`), the
route looks up the staged row by `(cycle_source_file, recipient_email)` and — if a `payload`
exists — calls `forwardPaystubDispatch` for just that person. Best-effort: the result is
stamped on the queue row (`markPaystubSent` / `markPaystubSendError`) and returned as
`{ paystub: { staged, sent, error } }`; a send failure never fails the payment record.

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

## Gating summary (dispatch-time)

- **Final PAB week**: `week.end >= pabMonthRange.end` where `pabMonthRange` is **derived from the dispatch week's own Monday** (not from merged uploads' mode month).
- **3rd-paycheck tech week**: `week.start` falls within the 3rd calendar week of the dispatch week's PAB month. Week 1 = Mon–Sun week containing the 1st of the month.
- **30 days of service**: `week.start >= (start_date + 30 days)`. `start_date` is looked up from `masterEmployees` keyed by work email + personal email.

See `BUSINESS_LOGIC.md#Technology Bonus` and `#Weekly gating for monthly bonuses` for the full business rules.

## Preview Paystubs modal

The Dispatch step's "Preview Paystubs" button opens a modal built from the same `dispatchData` rows that will be posted. Two views:

1. **List view**: searchable (filter by name, work email, or personal email), one row per employee (name + personal email + "View" action).
2. **Detail view**: orange/white/blue diagonal-gradient paystub mirroring the email template (header, recipient, earnings, bonuses, total, logo footer). Fits one viewport without scrolling. "← Back" returns to the list.

State: `previewPaystubsOpen`, `previewSelectedEmail`, `previewSearch`. All reset on modal close.

## n8n workflow

Template JSON lives at `references/n8n_paystub_dispatch.json`. Key nodes:

- **Webhook** (`POST /confirm-dispatch`): receives the payload.
- **Split Out** (`fieldsToSplitOut: employees`): fans out to one item per employee.
- **Loop Over Items** (batchSize 1): iterates per employee.
- **Set "pay_vars"** (replaces an older Google-Sheets-driven `prep sheet variables`): maps webhook fields to template-friendly names (e.g., `mf_hours`, `mf_rate`, `week_human`, `total_pay_php`).
- **Send Email** (Gmail node in the current test workflow; swap to Resend/SES for production volume): renders the HTML paystub template.
- **Wait 600ms**: throttles below Gmail's ~2 sends/sec per-user API cap.
- **Respond to Webhook**: `{ status, sent }`.

### HTML template

The paystub body uses inline-styled tables for email-client compatibility. Diagonal `linear-gradient(to top right, …)` (blue → white → orange) on the page background, header band, section accent bars, card backgrounds, and total bar. Logo + "© Simple · Confidential" in a centered footer row. All data comes from `$('pay_vars').item.json.*`. Fits a ~500px card width.

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

## References

- Migration: `references/seed_paystub_dispatch_queue.sql` (`paystub_dispatch_queue` — **PENDING**, migration #72).
- Workflow JSON: `references/n8n_paystub_dispatch.json`.
- Business rules: `Documentation/BUSINESS_LOGIC.md`.
- Routes: `app/api/paystub-dispatch-queue/route.ts` (+ `arrears/`), `app/api/payment-dispatches/route.ts` (per-employee send on Mark Paid), `app/api/dispatch-paystubs/route.ts` (legacy batch, no callers).
- Shared send helper: `src/lib/payroll/paystub-dispatch.ts` (`forwardPaystubDispatch`).
- Queue data access: `src/lib/supabase/paystub-dispatch-queue.ts` (`upsertPaystubDispatchQueue`, `getPaystubDispatchEntry`, `listExcludedArrears`, `markPaystubSent` / `markPaystubSendError`).
- Realtime lock hook: `src/hooks/useWizardDispatchLock.ts`.
- Clerk-side queue: `src/components/payroll-clerk/useDispatchQueue.ts` + `ExcludedQueue.tsx`.
- Wizard: `src/components/PayrollWizard.tsx` (`dispatchData` useMemo + Dispatch step JSX + Preview modal).
