# COE request → email notification (n8n), recipient editable in Admin

**Brief:** in-session 2026-10-05. Kane: *"Create me an n8n automation that would notify -
jakec@simple.biz if there is a COE request also in admin dashboard make sure we can change the
recipient after"*. Built under the 2026-09-26 blueprint rule: recommendations taken (CHOSEN 1–5),
no NEEDS.

**What was found first:** Admin → Webhooks already has a per-slug recipient editor ("Open
automation", `docs/features/webhook-automations.md`) with exactly one automation,
`payment_cycle_complete`. That doc's § *Adding a second automation* is the checklist this plan
follows: descriptor + preview/test branch in the admin route + a consumer that reads
`resolveWebhookDelivery` + a doc section.

## Task 1 — the pure payload

- [x] `src/lib/documents/coe-request-notify-payload.ts` — `COE_REQUEST_NOTIFY_SLUG`,
  `COE_REQUEST_DEFAULT_RECIPIENTS` (jakec@), `COE_REQUEST_TRIGGER`, `buildCoeRequestPayload`.
  It carries no pay figures: `period_label` is never read.
- [x] `src/lib/documents/coe-request-notify-payload.test.ts` — the shape, no rate/period_label even
  when the row has one, the Manila stamp, recipients normalized, `test` only when set.

## Task 2 — the descriptor learns its own wording

- [x] `src/lib/webhooks/webhook-config.ts` — the descriptor gains `copy` (default-source chip, mode
  label, mode hint, fixed-list warning, empty note, preview label, test-sent note). Both
  descriptors carry it, and the celebration's strings are the ones the dialog hard-coded before.
  `request` joins `PROTECTED_PAYLOAD_KEYS`.
- [x] `webhook-config.test.ts` — the descriptor test names both automations; `request` is protected.

## Task 3 — the server notifier

- [x] `src/lib/documents/coe-request-notify.ts` — `resolveCoeRequestDelivery`,
  `listCoeRequestDefaultRecipients` (name looked up for the default, best-effort),
  `postCoeRequestWebhook`, `notifyCoeRequested(row)`: resolve → audience → POST → audit. Never
  throws. No URL means no audit row.

## Task 4 — the trigger

- [x] `app/api/employee/documents/route.ts` — after a COE row is created,
  `after(() => notifyCoeRequested(row))`. Other document types and Generate COE do not fire it.

## Task 5 — the admin route serves two automations

- [x] `app/api/admin/webhooks/automation/route.ts` — a per-slug runtime (delivery, defaults, preview
  base payload, test payload, post). GET/PUT/POST are otherwise unchanged.

## Task 6 — UI + registries

- [x] `WebhookAutomationDialog.tsx` — wording from `descriptor.copy`; the attachments box is hidden
  when there are none.
- [x] `AdminWebhooks.tsx` — a `coe_request_notify` KNOWN_SLUGS card.
- [x] `sample-payloads.ts` — the View sample. `automation-fixtures.ts` — `sampleCoeRequestRow`.
- [x] `src/lib/audit/registry.ts` — the `webhook.` family note names `coe_request_notify`.

## Task 7 — n8n

- [x] `references/n8n/coe-request-notify.workflow.json` — Webhook → Build COE Emails (secret gate,
  recipients from the payload, escape everything, `[TEST RUN]` banner) → Respond → Gmail.

## Task 8 — docs + commit

- [x] `docs/features/coe-request-notify.md`, INDEX row, `webhook-automations.md` § second
  automation, `documents-tab.md` § Notifications pointer, `system-architecture.md` slug list,
  memory + MEMORY.md, Open items line for the PENDING n8n import.
