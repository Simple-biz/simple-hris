# Webhook automations — the editable mimicry of what an n8n automation will send

Admin → Webhooks carries an **Open automation** button on any webhook card whose slug has an
automation descriptor. It opens the automation as it will fire: **who** it mails (the role's
holders, as adjusted here), **what** it sends (the exact payload, attachments listed by name)
and the **one thing that fires it**. Recipients and extra top-level payload keys are editable
and saved onto the slug's `webhooks.config` entry; the week's facts are not editable, by
construction. A **Send test run** button mails the signed-in admin only, from a fictional week.
Shipped 2026-09-04. First and only automation: `payment_cycle_complete`.

Built because the celebration email's audience was "everyone holding the accounting role" with
no way to say "not Carla any more, but her replacement" without touching roles — and because
that same automation had fired falsely twice and Kane wanted to see, in one place, exactly what
fires it and what goes out.

## Key files

| Piece | File |
| --- | --- |
| Entry schema, override rules, protected keys, descriptors (pure) + tests | [`src/lib/webhooks/webhook-config.ts`](../../src/lib/webhooks/webhook-config.ts) · `.test.ts` |
| URL + override resolution by slug | [`src/lib/webhooks/resolve-webhook.ts`](../../src/lib/webhooks/resolve-webhook.ts) (`resolveWebhookDelivery`) |
| Admin route — preview / save / test run | [`app/api/admin/webhooks/automation/route.ts`](../../app/api/admin/webhooks/automation/route.ts) |
| The dialog | [`src/components/admin/WebhookAutomationDialog.tsx`](../../src/components/admin/WebhookAutomationDialog.tsx) |
| The button + entry type | [`src/components/admin/AdminWebhooks.tsx`](../../src/components/admin/AdminWebhooks.tsx) |
| Fictional record + paid rows for test runs | [`src/lib/webhooks/automation-fixtures.ts`](../../src/lib/webhooks/automation-fixtures.ts) |
| Sample payload shown in View | [`src/lib/webhooks/sample-payloads.ts`](../../src/lib/webhooks/sample-payloads.ts) |
| The automation this was built for | [cycle-closeout.md § Celebration email](./cycle-closeout.md#celebration-email--one-trigger-fired-by-the-close-itself-2026-09-04) |

## Where the config lives — and who may write it

Nothing new is stored. The `webhooks.config` JSON array (one `app_settings` row) has always
held `{ slug, url, active, … }` per webhook; two **optional** fields join each entry:

```jsonc
{
  "slug": "payment_cycle_complete",
  "url": "https://…/webhook/payment-cycle-complete",
  "active": true,
  "recipients": { "mode": "role", "add": ["maya@simple.biz"], "remove": ["carla@simple.biz"], "custom": [] },
  "payload_overrides": { "note": "Great week" }
}
```

`webhooks.config` is **admin-only to write** (`app/api/app-settings/route.ts` — a webhook URL
carrying employee PII must not be pointable by a non-admin) and this route inherits that:
every method calls `requireAdminSession()`. The dialog saves through `PUT
/api/admin/webhooks/automation`, **not** through the page's generic Save. The page's Save still
writes the whole array (URLs, labels, toggles) — which is why `AdminWebhooks.tsx` carries the
two automation fields on its entry type and mirrors a dialog save into local state: a Save from
the page must write the automation fields back unchanged, never drop them.

Readers that only want the URL (`resolveWebhookUrl`) ignore the two fields entirely. They were
unaffected by this change and a test pins that a legacy entry parses with null overrides.

## Recipients — role mode is the default, and why

| Mode | Effective audience | When to use |
|---|---|---|
| `role` (default) | the role's current holders **minus** `remove` **plus** `add` | the everyday case — Carla resigns: remove her, add her replacement. Revoking a role still removes a person automatically; the editor is for exceptions. |
| `custom` | exactly the `custom` list | when the audience should stop tracking the role at all. A revoked role no longer removes anyone; a new hire must be typed in. The dialog says so. |

Rules (each pinned in `webhook-config.test.ts`):

- **Remove wins over add.** An address listed in both is never mailed.
- **Emails are normalized** (trimmed, lowercased, validated) on save and again at send, so a
  stored `CLAIRE@…` cannot duplicate `claire@…`.
- **An override resolving to zero recipients is a refusal, not an empty send** — and, for the
  celebration, it happens **before** the once-per-cycle claim, so a bad edit cannot burn the
  week's one shot (`cycle-complete-notify.ts`, same rule the pre-checks always had).
- Role holders removed here still appear in the dialog, struck through with a **removed** chip
  and a restore button — a removal is visible, never silent.

## Payload overrides — the facts are protected

`payload_overrides` is a JSON object whose top-level keys are **shallow-merged into** the
payload the code builds. It exists so an admin can add a `note`, a `cc`, a `subject_hint` —
anything the n8n workflow chooses to read — without a deploy.

It cannot change what happened. `PROTECTED_PAYLOAD_KEYS` — `event`, `trigger`, `celebrate`,
`cycle`, `stats`, `recipients`, `attachments`, `attachments_error`, `sent_by`, `test` — are
**refused by name on save** (the dialog shows the server's errors) **and stripped again at
send** (`mergePayloadOverrides`), and `parseWebhookConfig` drops them when reading a stored
row. So a hand-edited `app_settings` value cannot make the email lie either. This is the same
honesty rule the celebration has carried since 2026-08-14 (`unpaid_count` is never massaged),
extended to the editor. **Do not add a protected key to the editable set to make a request
work** — the answer is a new non-protected key the workflow reads.

## The preview is the payload

The dialog's "Effective payload" block is not a description. The route builds the real payload
with `buildCycleCompletePayload` from a fictional record, the dialog merges the draft
recipients and overrides into it client-side with the same pure functions the server uses at
send time, and shows the result. Attachments appear with their metadata and `content_base64`
elided. If the preview and production ever disagree, one of them stopped using the shared
functions — fix that, not the preview.

## Test runs go to the admin only

`POST /api/admin/webhooks/automation` builds the production payload from
`sampleCycleCloseoutRecord()` (fictional people, `TEST RUN · Jul 19 – 25, 2026`), attaches the
three real files built from it, sets `test: true`, and sends it to **the signed-in admin's
email only** — never the recipients in the dialog, never a real week. The n8n template prefixes
the subject with `[TEST RUN]` and adds a banner. Audit action `webhook.test_run`. The old card
"Test" button still sends a bare ping and is still useful for "does the URL reach n8n?"; the
workflow's Code node rejects a ping for having no recipients, which is expected.

## Adding a second automation

Absent from `WEBHOOK_AUTOMATIONS` = no button. Adding a slug is a feature, not a config change:
the descriptor (title, the one trigger sentence, audience, attachment names) **plus** a preview
and test-run branch in the admin route for that slug's payload builder, **plus** the consumer
reading `resolveWebhookDelivery` instead of `resolveWebhookUrl`, plus a section here.

## Deploy notes

**No migration.** Two optional fields on an existing JSON value in `app_settings`; one new
audit action family (`webhook.automation_updated`, `webhook.test_run`).

**n8n — PENDING Kane:** the updated
[payment-cycle-complete-celebration.workflow.json](../../references/n8n/payment-cycle-complete-celebration.workflow.json)
reads `attachments`, `celebrate` and `test`. Until it is imported the live workflow ignores
those fields and sends exactly the email it always has (the new payload is a superset). Import
steps are in [cycle-closeout.md § Deploy notes](./cycle-closeout.md#deploy-notes).
