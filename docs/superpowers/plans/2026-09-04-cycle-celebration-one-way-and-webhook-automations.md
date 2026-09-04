# Plan — One-way cycle celebration · reports attached · Admin → Webhooks automation editor

2026-09-04. Approved brief (Q1–Q5 all on the recommended arm). Trigger: two accidental
`fully_paid` firings in production (2026-08-18 jakec@ 1/1; 2026-09-02 lenny@ 20/20 on a
1,053-row week, no lock flip). Kane: "this automation only triggers one way — stop
processing + close payroll cycle from the UI."

## Tasks

- [x] 1. `src/lib/webhooks/webhook-config.ts` + `.test.ts` — pure: entry schema with optional
      `recipients` / `payload_overrides`, `applyRecipientOverride`, `mergePayloadOverrides`
      (PROTECTED_KEYS), `validateAutomationConfig`.
- [x] 2. `src/lib/webhooks/resolve-webhook.ts` — `resolveWebhookDelivery(slug)`.
- [x] 3. `src/lib/payroll/cycle-complete-trigger.ts` + tests — ONE trigger (`cycle_closed`);
      both claim keys; tests refuse any other label.
- [x] 4. `src/lib/payroll/cycle-close-report-export.ts` + tests — `buildFinalCloseoutWorkbook`.
- [x] 5. `src/lib/payroll/cycle-close-report-pdf.ts` + `.test.ts` — server-only pdf-lib FINAL report.
- [x] 6. `src/lib/payroll/cycle-close-attachments.ts` — record + paged paid rows → 3 files, base64,
      size cap, never throws.
- [x] 7. `src/lib/payroll/cycle-complete-notify.ts` — `celebrateClosedCycle(record, actor)`.
- [x] 8. `app/api/payment-dispatches/cycle-closeout/route.ts` — fresh INSERT → `after()` celebrate.
- [x] 9. `src/lib/payroll/cycle-closeout-store.ts` — reopen deletes `cycle_report_sent.<file>`.
- [x] 10. DELETE `app/api/payment-dispatches/cycle-complete/route.ts`; strip the client trigger
      code from `PayrollDispatch.tsx`; route-access test.
- [x] 11. `app/api/admin/webhooks/automation/route.ts` — admin GET preview / POST test run.
- [x] 12. `src/lib/webhooks/sample-payloads.ts` — new sample shape.
- [x] 13. `src/components/admin/WebhookAutomationDialog.tsx` + button in `AdminWebhooks.tsx`.
- [x] 14. `references/n8n/payment-cycle-complete-celebration.workflow.json` — attachments,
      `celebrate:false` branch.
- [x] 15. Docs: `docs/features/webhook-automations.md`, rewrite cycle-closeout.md § Celebration,
      payment-dispatch.md §12.7, INDEX rows, memory. Typecheck + full `npm test`. One commit.

## Decisions taken

- **Server-fired, inside the close.** The only code path that can POST the webhook is the
  close-out route after its own INSERT succeeded. No client endpoint remains.
- **Every number from the record.** `paid_count = record.paid.payeeCount`,
  `unpaid_count = record.unpaid.count + truncated`, `total = paid + unpaid`, money from
  `record.paid`. The client sends nothing about counts.
- **Claim inside `after()`**, immediately before the fetch — a killed callback leaves no claim.
- **Reports have their own once-key** (`dispatch.cycle_report_sent.<file>`), freed on reopen, so a
  re-close after a reopen still mails the new record (`celebrate:false`).
- **Overrides never touch the facts** — PROTECTED_KEYS refused on save and stripped at send.
- **No migration.**

## Out of scope (contract)

Close-out record shape · Stop dialog UI · browser downloads · the reopen's celebration burn ·
`isCycleFullyPaid` and friends (strip + unpaid list still use them) · other webhook slugs ·
queue hydration bugs in §12.7.1 (documented OPEN; no longer able to send anything) · new tables.
