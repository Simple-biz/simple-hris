# People → Offboarded search tab + one-offs in processor buckets

Approved brief (2026-09-01): Accounting/CEO People gets a 4th mode "Offboarded" — a
search bar over the whole `offboarded_sheet` ledger (row grain: recycled work emails
show every record), columns Name / Work Email / Personal Email / Start Date / off date,
a bank chip ("Bank on file · <rail>" / "No Bank"), a Pay button (files the existing
one-off `urgent_payment_requests` flow), and Add/Edit bank via the shared SetBankDialog.
One-off pending cards move OUT of Payment Dispatch → Urgent into the matching
processor bucket (Q1: ALL one-offs, incl. People-roster-filed; MESA + orphanage stay
Urgent). Unrouted one-offs sit under "All pending" flagged "No bank" (Q2). Recycled
emails now held by an ACTIVE person: warn-and-allow, warning shown on the row, in
PayDialog, in SetBankDialog, and re-resolved LIVE on the clerk's pending card.

**Non-negotiable:** the one-off dispatch record keeps `cycle_id=NULL` +
`cycle_source_file=urgent_<week>`. Placement is UI-only — the weekly cycle's file name
would corrupt close-out tallies, CSV identity tests, and the paystub week-dedupe.

Measured (scripts/tmp-probe-offboarded-identity.mts, deleted before commit): 4,045
ledger rows · 690 with start_date · 338 dup-email groups · 833 live employee_ids
(735 with payout data) · 288 snapshots · 305 emails recycled to ACTIVE people.

## Tasks

- [ ] 1. `src/lib/people/offboarded-search.ts` — pure helpers + node:test:
      `matchOffboardedRows` (q ≥ 2 chars, case-insensitive substring on name/work
      email, result cap) and `foldBankStatus` (live employee_ids → `ok` +
      locking `bankProcessor`; snapshot-only → `missing_has_snapshot` + non-locking
      `bankPrefill`; neither → `missing` — mirrors offboarded-payroll-candidates.ts).
- [ ] 2. `app/api/people/offboarded/route.ts` — `requireRateVisibilitySession`
      (mirrors /api/people). `?q=` → listOffboardedSheetRows (already paged) →
      pure match → enrich ONLY the matches: employee_ids (fetchPayoutIdsByEmail),
      legacy Bank Preferred, offboard snapshots (getAppSettings bulk), active-roster
      collision (active_employees Work Email → holder name). Returns rows +
      bank chip fields + SetBankDialog prefill + `activeHolder`.
- [ ] 3. Extract `SetBankDialog` from PayrollWizardNotesFab.tsx:2557 into
      `src/components/accounting/SetBankDialog.tsx` — no behavior change; FAB imports it.
- [ ] 4. `src/components/people/PeopleOffboarded.tsx` — search-first UI (empty state
      until typed), results table, bank chip, warn badge, Pay + Set bank actions.
      PayDialog stays owned by PeopleTab (it already takes an onPay person); it gains
      an optional warning line. Rows with no work email: Pay disabled with caption.
- [ ] 5. PeopleTab.tsx — 4th mode `offboarded` on the strip (both views per Q2-of-round-2:
      CEO shows it too, canPay already true there; bank edit accounting-only).
- [ ] 6. `GET /api/urgent-payments/dispatches` — add `is_one_off` per row (join
      `urgent_payment_requests.dispatch_id`). UrgentPaymentsQueue: drop the one-off
      pending section + its count contribution; filter `is_one_off` rows out of its
      log views (they now live in the buckets).
- [ ] 7. New `src/components/payroll-clerk/OneOffBucketSection.tsx` — pending one-off
      cards (name, emails, dept, amount ₱/$, note, requested by, processor select
      defaulting to effective rail, live active-collision warning, Send →
      MarkPaidDialog → POST /api/urgent-payments/requests/[id]/dispatch, trash →
      DELETE cancel). PayrollDispatch fetches `/api/urgent-payments/requests`,
      partitions by effective processor (override select included), renders the
      section inside ProcessorQueue via a new optional `extraPendingSection` prop
      (pending view only): bucket tab = its one-offs; "All pending" = all of them,
      unrouted flagged "No bank — set bank details".
- [ ] 8. ProcessorQueue paid/log views — PayrollDispatch merges this week's
      `is_one_off` dispatch rows (by processor) into `paidRecords`; ProcessorQueue
      renders a "One-off" chip when `isUrgentSourceFile(row.cycle_source_file)` and
      routes THAT row's undo through POST /api/urgent-payments/dispatches/undo
      (the regular delete-the-row undo would strand the request — urgent-payments.md).
- [ ] 9. Tests green (`offboarded-search.test.ts`, existing urgent-cycle + dispatch
      tests untouched) · typecheck · `next build` (check for a live dev server first).
- [ ] 10. Docs, same commit: `docs/features/people-offboarded-pay.md` · INDEX.md new row
      (+ Payment Dispatch row cell noting the one-off placement change) · memory
      `people-offboarded-pay-tab` + MEMORY.md pointer · docs/README.md entry.
- [ ] 11. Delete tmp probe script · `git status` · stage by explicit path · commit to main.
