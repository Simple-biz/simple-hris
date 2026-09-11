# Plan — Payroll Cycles month card → "Open" → per-processor payout breakdown

2026-09-11. Approved brief (Q1–Q4 answered by Kane). Kane's ask: *"Monthly Cards should have
an Open button ... this will open the data on how much was paid for each Pay Processor ... the
main point of this is for us to know how successful Payroll Wizard HRIS is and how accurate the
systems we have built. So if it was marked problem it could have been the pay processor itself
that is the problem not HRIS ... Dont forget the smooth animations."*

## Decisions taken

- **Q1 — (a) evidence only, no computed verdict.** The record stores `reason` and `processor`
  and nothing else: no cause, no note, no owner. The modal shows the reason × processor
  cross-tab and a legend explaining what each reason *means*. It does **not** print an
  "attributed to" column, because nobody recorded that fact.
- **Q2 — no roster/department join.** Kane: *"we cant detect it so we just leave it as HRIS
  Problem for now"*. An HSL/department split would need the unpaid payees' emails joined
  against the roster; the close-out record carries no department. So a `problem` counts as an
  **HRIS-side problem by default**, stated in the legend as a convention-until-measured, never
  as a measurement. Capturing a cause code at Problem-time in Payment Dispatch is the
  follow-up that would make this real — filed as an Open item, not built here.
- **Q3 — (b) the button is always present, disabled with the reason on hover** when the month
  has no closed cycle. Today that is every month except August 2026.
- **Q4 — closed cycles only.** Frozen declarations, one source. No live `payment_dispatches`
  path in this modal: mixing frozen and live figures in one table is how the frozen-vs-live
  rule gets broken.

## What the prod probe established (read-only, 2026-09-11)

`scripts/probe-closeout-by-processor.mjs`, over the 3 live close-out records:

- `byProcessor` **is populated on every record** — `{wise, hurupay, wires, higlobe, jeeves}`
  with `{count, usd, php}`, frozen at close time.
- **`Σ byProcessor.usd === paid.paidUSD` and `Σ byProcessor.php === paid.paidPHP`, exactly.**
  The money side reconciles to the cent.
- **`Σ byProcessor.count === paid.dispatchCount` (3,112), NOT `paid.payeeCount` (3,088).**
  The card's headline counts people; `byProcessor` counts payment rows. The 24-row gap is
  people who hold more than one paid row.
- `unpaid.payees[]` carries `processor` **and** `reason`, so the unpaid side is splittable —
  but those rows also carry names and emails, so the split must happen server-side.
- August 2026: 12 pending · 2 problem · 34 threshold. **Both problem rows are on `wires`.**

## Tasks

- [ ] 1. `src/lib/payroll/cycle-closeout.ts` — add `aggregateUnpaidByProcessor()`: pure,
      record → `Record<processorId, {pending, problem, threshold, owedUSD, owedPHP}>`.
      Counts and money only; **no payee ever leaves it**.
- [ ] 2. `src/lib/payroll/cycle-closeout-store.ts` — `toCycleCloseoutSummary()` gains
      `unpaidByProcessor`, computed from the full record **before** `payees` is dropped. One
      read, no second scan, no PII on the wire.
- [ ] 3. `src/lib/admin/cycle-performance.ts` + `.test.ts` — `MonthPerformanceRow.processors[]`
      (pooled over the month's CLOSED cycles) and `.cycleBreakdowns[]` (per closed cycle).
      Carries `paidPayments` (rows) separately from the card's `paid` (people), plus
      `paymentsMinusPayees` so the gap is stated, never hidden.
- [ ] 4. `app/api/admin/diagnostics/cycle-performance/route.ts` — best-effort processor LABEL
      lookup via `readPayProcessorRegistry()`. It THROWS on failure, so it is wrapped: a
      missing label falls back to the raw id and never 500s a screen of correct numbers.
- [ ] 5. `src/components/admin/performance-ui.tsx` — `PerfDetailModal` shell with the four
      dialog fixes (`gap-0`, `max-h`, `shrink-0` chrome, one `min-h-0 flex-1 overflow-y-auto`
      body) + the shared `MiniBar` / disabled-button treatment.
- [ ] 6. `src/components/admin/PayrollCyclePerformance.tsx` — the Open button on each month
      card and the modal body: per-processor rows, reason columns, reconciliation line,
      per-cycle section, legend.
- [ ] 7. Docs: new § in `docs/features/diagnostics-performance-tabs.md`, INDEX row update,
      memory `cycle-processor-breakdown-modal` + MEMORY.md pointer. Typecheck (a `next dev`
      server is live on :3000, so no `next build`). One commit, staged by explicit path.

## The rules this surface carries

1. **Payments ≠ people.** The count column is labelled *payments* and is never divided by
   anything that counts people. No per-processor success rate exists, because paid-payments
   over unpaid-people is a fabricated denominator — the same class of error that made
   `payment_dispatches` poison as a rate source.
2. **The money is the trustworthy half**, and it is asserted: a test pins
   `Σ processors.usd === paid.paidUSD`. Drift means an older builder wrote the record, and the
   modal says so rather than quietly disagreeing with the card it opened from.
3. **No PII leaves the store.** `unpaidByProcessor` is computed where the payees still exist
   and ships counts only — the `listChecklistWeekCounts()` rule, applied to Accounting.
4. **A `problem` is an HRIS problem until something records otherwise** (Kane, Q2). Stated in
   the legend as a default, never rendered as a derived verdict.
5. **Closed cycles only.** Unclosed weeks have no denominator and no frozen processor split.
6. **Accent stays orange**; amber remains warning-only and is used only on the unpaid columns;
   no green anywhere, because a bar here is magnitude, not a verdict.
7. **Motion:** `tabular-nums` everywhere, bars animate `width` in a fixed track from the next
   frame, `motion-reduce:` on everything, and the modal never animates a number that is still
   loading — it opens over data the tab already has.
