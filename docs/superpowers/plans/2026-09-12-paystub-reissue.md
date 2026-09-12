# Paystub reissue — ask before re-sending, and say which issue it is

**Approved 2026-09-12.** Kane: *"this will not resend the automation to send a new
Paystub right? … we should have a new feature that would ask the User if she wants
to send a new paystub or not … there should be an attempt in the paystub that would
say attempt #2 or something better than attempt … Now on the employee dashboard
there should be that as well."*

Answers to the brief's questions:

| Q | Answer |
| --- | --- |
| Q1 prompt default | **Recommendation taken** — the prompt appears ONLY when a stub already went for this (cycle, person), and defaults to **DON'T SEND** |
| Q2 the word | **Amended** — the two-word system. `Reissued` when the figures match, `Amended` when they moved |
| Q3 the 117 existing | **Label retroactively** |

## The premise it corrects

`app/api/payment-dispatches/route.ts:409` fires `forwardPaystubDispatch` whenever a
`paid` row lands with a staged stub. **There is no already-sent guard.** So
undo → Mark Paid again sends a second live pay statement. Meanwhile the in-app
"Salary Paid" notification IS de-duped on `(recipient, source_file)` — so the
employee receives a duplicate document and NO notification about it. Backwards.

## Measured before building (read-only, 2026-09-12)

14,033 `paystub_dispatch_queue` rows. `send_count`: 0 → 6,551 · 1 → 7,363 ·
**2 → 116** · 3 → 1 · 7 → 1 · 19 → 1. The 7 and 19 are `kaner@` test rows and are
**not** an employee incident — do not cite them as one. Real duplicate sends to real
employees: **117** (116 twice, `aileenm@` three times).

`send_count` already exists and is already incremented
(`paystub-dispatch-queue.ts:481`), and **no UI reads it**. `PaystubQueueListItem`
already selects it; `useDispatchQueue` maps only `sentAt`.

## The vocabulary rule

**Never "attempt".** An attempt implies the previous one failed; in the dominant
case the first email arrived correctly and was merely superseded. Telling an
employee "Attempt 2" says their payroll is broken when it is not.

| Figures vs the previously EMAILED total | Word |
| --- | --- |
| unchanged | **Reissued** |
| changed | **Amended** — the only case where the employee must re-read it |
| issue > 1 but no previous snapshot (the 117) | **no word — "Issue 2" alone** |

The third row is the retroactive case. We know the count is real but have no
per-issue amount, so calling it Reissued *or* Amended would be a guess. It gets the
number and nothing more — Kane's ask ("attempt #2 or something better") is satisfied
by the number; the word is only used where it is earned.

## Tasks

### 1 — Data
- [ ] `references/sql/create/2026-09-12_paystub_issues.sql` — one row per send:
      `(cycle_source_file, recipient_email, issue_no)` unique, `issued_at`,
      `issued_by`, `amount_php/_usd` (**the total actually emailed** — this is the
      snapshot that makes the NEXT issue's Reissued-vs-Amended decidable),
      `previous_amount_php`, `kind`, `reason`, `source` (`mark_paid` | `resend`).
      **No `BEGIN`/`COMMIT`** — the apply script owns the transaction, or the dry
      run commits ([[gift-receipts-ledger]]).
- [ ] `scripts/apply-paystub-issues-migration.mts` — `--dry` default, `--apply` gate.
- [ ] **No backfill of fabricated rows.** Issues before today have a count and no
      history; the UI derives their label from `send_count` alone.

### 2 — Pure logic, tested
- [ ] `src/lib/payroll/paystub-issue.ts` + `.test.ts`
      `classifyIssue()` → `original | reissued | amended | unrecorded`.
      `issueChipText()` / `issueNote()`. Money compared at **0.01 tolerance**, the
      same epsilon the route's own reconciliation uses (`route.ts:437`).
      `shouldPromptBeforeSend()` — the Q1 rule in one tested place.

### 3 — Routes
- [ ] `app/api/payment-dispatches/route.ts` — honour `send_paystub` from the body.
      **A re-pay does not send unless the body says so**; a first send is unchanged.
      Record the issue row, pass the chip into `emailOptions`, audit the decision.
- [ ] `app/api/dispatch-paystubs/route.ts` — the Excluded-tab re-send shares the
      counter and the label, or the two paths would disagree about what issue it is.

### 4 — Email + UI
- [ ] `src/lib/payroll/paystub-email-html.ts` — `PayStubEmailOptions` gains the
      issue; render the chip on the statement.
- [ ] `src/components/payroll-clerk/MarkPaidDialog.tsx` — the prompt, shown only
      when `paystubSentAt` is set, defaulting to off.
- [ ] `useDispatchQueue.ts` — map `sendCount` through (already selected server-side).
- [ ] `employee-paystubs.ts` + the employee pay-stub list/modal — the same chip.

### 5 — Verify
- [ ] `node --test` on the new module · `tsc --noEmit` (**not `next build`** — a dev
      server shares `.next/`).
