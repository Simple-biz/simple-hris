# MESA request notify — an email via n8n when a member files a MESA request

When a member files an **opt-out, disbursement or return** from Employee → MESA → Request, the HRIS
POSTs the request to an n8n workflow. The workflow emails each recipient that a request is waiting
in **Accounting → MESA → Requests**. Gmail sends it from the **hris@simple.biz** account attached
to the workflow. The recipients default to **carla@simple.biz** and **april@simple.biz** (tickets
board, 2026-10-05, Urgent; Kane: *"Those emails will be VIA n8n"*). An admin changes them in
**Admin → Webhooks & Integrations → Webhooks → "MESA Request → Notify Accounting (n8n)" → Open
automation**, with no deploy. This is the third automation on the editor in
[webhook-automations.md](./webhook-automations.md), built on the COE pattern in
[coe-request-notify.md](./coe-request-notify.md). Shipped 2026-10-05, session `5975ee4c`.

## Key files

| Piece | File |
| --- | --- |
| Slug, default recipients, mailed types, payload builder (pure) + tests | [`src/lib/mesa/request-notify-payload.ts`](../../src/lib/mesa/request-notify-payload.ts) · `.test.ts` |
| Resolve → audience → POST → audit (server) | [`src/lib/mesa/request-notify.ts`](../../src/lib/mesa/request-notify.ts) (`notifyMesaRequested`) |
| The one call site | [`app/api/mesa-requests/route.ts`](../../app/api/mesa-requests/route.ts) POST (`after(() => notifyMesaRequested(notifyRow))`) |
| Descriptor + editor wording | [`src/lib/webhooks/webhook-config.ts`](../../src/lib/webhooks/webhook-config.ts) (`WEBHOOK_AUTOMATIONS.mesa_request_notify`) |
| Preview + test run | [`app/api/admin/webhooks/automation/route.ts`](../../app/api/admin/webhooks/automation/route.ts) (`RUNTIMES`) |
| Fictional request for the test run | [`src/lib/webhooks/automation-fixtures.ts`](../../src/lib/webhooks/automation-fixtures.ts) (`sampleMesaRequestRow`) |
| Admin card | [`src/components/admin/AdminWebhooks.tsx`](../../src/components/admin/AdminWebhooks.tsx) (`KNOWN_SLUGS`) |
| n8n workflow | [`references/n8n/mesa-request-notify.workflow.json`](../../references/n8n/mesa-request-notify.workflow.json) |

## One trigger: a member-filed request Accounting reviews

`notifyMesaRequested` has exactly one caller: `POST /api/mesa-requests`. It runs after the row was
inserted and runs inside `after()`, so the platform cannot freeze the function before the POST
reaches n8n. A source-scan test pins both points.

- **Mailed:** `opt_out`, `disbursement`, `return` (`MESA_NOTIFY_REQUEST_TYPES`). These are the types
  Accounting reviews.
- **Never mailed:** `opt_in` (retired 2026-09-16; joining is the FPU class pipeline, HR's).
- **Never mailed:** anything Accounting does to a request (approve, deny, revoke, archive, a date
  edit). `PATCH /api/mesa-requests/[id]` does not import the notifier, and a test fails if it does.
- **Never mailed:** a refused submit. A disbursement over the balance (400), an unverifiable balance
  (503) or a return with no amount (400) inserts no row, so nothing is waiting.

Every request sends its own email. A member who files twice produces two emails, each about a real
queue row.

## No amount, no reason, no explanation

The payload carries `request: { id, request_type, request_label, employee_name, employee_email,
department, requested_at, requested_at_manila }`, plus `recipients`, `event` (`mesa.requested`),
`trigger`, `sent_by` and `test` on a test run. It never carries:

- **`amount_needed`.** That is the member's own savings, and the figure stays behind the `mesa` grant.
- **`disbursement_reason` and `explanation`.** A disbursement's explanation is often medical
  ("hospital bill for my daughter").

The recipient list is admin-editable, and the person on it need not hold the `mesa` grant, the same
rule as the COE email's "no pay figures". `request-notify-payload.test.ts` fails if the amount, the
reason, the explanation or a `₱` reaches the payload. The workflow test also fails if the n8n file
reads them. **Do not add them to make the email "more useful".** The reviewer reads all of it,
with the member's balance, in the HRIS.

A department key is sent as its label (`hsl:case_managers` → `HSL — Case Managers`), never the slug.

## Recipients: fixed defaults, edited in Admin

`MESA_REQUEST_DEFAULT_RECIPIENTS = [carla@simple.biz, april@simple.biz]`. Kane, 2026-10-05: *"make
sure that in ADMIN we can edit the recipients"*.

**To change who is mailed:** Admin → Webhooks & Integrations → Webhooks → **MESA Request → Notify
Accounting (n8n)** → **Open automation** → Recipients → **Save**. The card and its Open automation
button are there even before a URL is pasted, and a save made then is kept on the slug's entry
(inactive) and applies as soon as the URL is switched on. Saving is admin-only
(`requireAdminSession`) and audited `webhook.automation_updated`.

**The Admin card is the ONLY URL source — there is no env fallback.** `resolveWebhookDelivery`
applies the saved recipients only when the URL comes from that same `webhooks.config` entry; a URL
from an env var carries no overrides, so the email would go to carla@ + april@ while the editor
showed the edited list. `resolveMesaRequestDelivery` therefore passes no `envVars`, and a test fails
if one is added. The COE and celebration automations still have an env fallback with this gap (Open
items 352); the editor now says so whenever it is in play (*"Your edits here are not applied yet"*).

The editor works exactly as it does for the COE email:

- The first mode reads **Default ± changes**. "Remove" crosses a default out (it stays visible,
  struck through, with a restore button), and "add" mails extra people. **Fixed list** replaces the
  defaults outright.
- Revoking someone's Accounting role does **not** stop their email. Only the editor does.
- **Zero effective recipients is a refusal, not an empty send.** The request still lands in the
  queue; only the email is skipped, and the skip is logged as `no_recipients`.

## Audit: every attempted send, never the unwired case

`webhook.mesa_request_notify` (actor `MESA Request Notify` / `System`, resource `mesa_requests`,
`resource_id` = the request id, with `request_type`) is written for each POST (`ok`, `status`,
`detail`, `to[]`, `payload_overrides_rejected`) and for the `no_recipients` refusal. **No URL
configured writes nothing**, so before the workflow is imported there is no audit noise per request.
The notifier never throws and never fails the submit.

## The n8n workflow

Webhook `mesa-request-notify` → **Build MESA Emails** (Code) → Respond → **Send MESA Alert (Gmail ·
hris@simple.biz)** (one item per recipient, `onError: continueRegularOutput`).

- Recipients come from the payload. They are validated, deduped and capped at 300. Subject and body
  are fixed in the Code node, and every value is HTML-escaped.
- It refuses any `event` other than `mesa.requested`, and it refuses an empty recipient list. The
  card's generic **Test** ping therefore fails, which is expected. Use **Open automation → Send test
  run to me** instead.
- `test: true` adds a `[TEST RUN]` subject prefix and an amber banner.
- Optional lock: `REQUIRED_SECRET` in the Code node plus HRIS env `N8N_MESA_REQUEST_NOTIFY_SECRET`
  (sent as `x-webhook-secret`).

The Code node was run locally on 2026-10-05 against a sample payload. It fanned out 2 items from 3
recipients, the duplicate dropped, `<b>` was escaped, and a wrong event and an empty list were each
refused. It had not run inside n8n then. On 2026-10-06 the workflow was measured imported and active
(below), but **no run inside n8n has been observed yet**.

## Deploy notes

**No migration.** The editor writes two optional fields onto the slug's `webhooks.config` entry.

**Steps 1–2 DONE, measured read-only 2026-10-06** (session `adf12936`, Open item 350): `mesa_request_notify`
is active with an n8n cloud URL in `webhooks.config` (saved 2026-10-05 18:21Z). **Step 3 is still PENDING:** no
Send test run and no member filing had been observed. The steps, as written for Kane:

1. n8n: import [`references/n8n/mesa-request-notify.workflow.json`](../../references/n8n/mesa-request-notify.workflow.json).
   Attach the **hris@simple.biz** Gmail OAuth2 credential to **Send MESA Alert (Gmail · hris@simple.biz)**;
   that account is the sender. Then Activate.
2. HRIS: Admin → Webhooks & Integrations → Webhooks → **MESA Request → Notify Accounting (n8n)**.
   Paste the production webhook URL, toggle Active, then Save. **There is no env fallback**: the card
   is the only place the URL may come from, so the recipients edited there are the ones mailed.
3. Check it: open the card's **Open automation**. carla@ and april@ should be listed under "default".
   Click **Send test run to me**; a `[TEST RUN]` email should arrive from hris@simple.biz.

Measure step 2 by reading `webhooks.config` for `active` **and** `url`, never by the slug's presence.
See memory `tickets-update-notifications` for what happens otherwise.
