# COE request notify — an email via n8n when an employee asks for a Certificate of Engagement

When an employee files a COE request from Profile → Request Documents, the HRIS POSTs the request to
an n8n workflow. The workflow emails each recipient that a certificate is waiting in Accounting →
Documents. The recipient defaults to **jakec@simple.biz** (Kane, 2026-10-05). An admin changes it in
**Admin → Webhooks & Integrations → Webhooks → "COE Request → Notify (n8n)" → Open automation**,
with no deploy. This is the second automation on the editor in
[webhook-automations.md](./webhook-automations.md). Shipped 2026-10-05, session `d7bac06f`.

## Key files

| Piece | File |
| --- | --- |
| Slug, default recipient, payload builder (pure) + tests | [`src/lib/documents/coe-request-notify-payload.ts`](../../src/lib/documents/coe-request-notify-payload.ts) · `.test.ts` |
| Resolve → audience → POST → audit (server) | [`src/lib/documents/coe-request-notify.ts`](../../src/lib/documents/coe-request-notify.ts) (`notifyCoeRequested`) |
| The one call site | [`app/api/employee/documents/route.ts`](../../app/api/employee/documents/route.ts) (`after(() => notifyCoeRequested(row))`) |
| Descriptor + editor wording | [`src/lib/webhooks/webhook-config.ts`](../../src/lib/webhooks/webhook-config.ts) (`WEBHOOK_AUTOMATIONS.coe_request_notify`) |
| Preview + test run | [`app/api/admin/webhooks/automation/route.ts`](../../app/api/admin/webhooks/automation/route.ts) (`RUNTIMES`) |
| Fictional request for the test run | [`src/lib/webhooks/automation-fixtures.ts`](../../src/lib/webhooks/automation-fixtures.ts) (`sampleCoeRequestRow`) |
| Admin card | [`src/components/admin/AdminWebhooks.tsx`](../../src/components/admin/AdminWebhooks.tsx) (`KNOWN_SLUGS`) |
| n8n workflow | [`references/n8n/coe-request-notify.workflow.json`](../../references/n8n/coe-request-notify.workflow.json) |

## One trigger: an employee-filed COE

`notifyCoeRequested` has exactly one caller: `POST /api/employee/documents`. It runs after a COE row
was created and runs inside `after()`, so the platform cannot freeze the function before the POST
reaches n8n (the same pattern as `cycle-closeout`). A source-scan test pins both points.

These **do not** fire it:

- **Accounting → Documents → Generate COE.** That row is signed in the same click, so nobody is
  waiting on it. Its in-app `documents.requested` ping is suppressed for the same reason
  ([documents-tab.md § Accounting can generate + sign it directly](./documents-tab.md#accounting-can-generate--sign-it-directly)).
- **Pay Stubs, Award-Certificate, Other.** Kane asked for COE only.
- **A blocked COE** (422: no start date, department or rate). No row exists, so there is nothing to sign.

Every request sends its own email. The employee path has no one-pending-COE guard (only the admin
path has one), so an employee who files twice produces two emails, each about a real queue row.
That is intended, not a duplicate bug.

## No pay figures, ever

The payload carries `request: { id, document_type, document_label, employee_name, employee_email,
requested_at, requested_at_manila, note }`, plus `recipients`, `event`, `trigger`, `sent_by` and
`test` on a test run. It never carries:

- **`period_label`.** On a COE row this is `Engaged since … · ₱225.00/hr`, which is the rate.
- **The draft PDF.** It prints every rate and bonus line.

The recipient list is admin-editable, and the person on it need not hold Accounting → Documents.
The rate stays behind that grant. The email says who asked and when, then links to the HRIS.
`coe-request-notify-payload.test.ts` fails if `period_label`, `₱`, the rate or a storage path
reaches the payload. **Do not add them to make the email "more useful".**

The employee's own note is included. They wrote it to Accounting, and it usually says what the
certificate is for. n8n HTML-escapes it.

## Recipients: a fixed default, not a role

`COE_REQUEST_DEFAULT_RECIPIENTS = [jakec@simple.biz]`. This differs from the celebration, whose
default is "everyone holding the accounting role". Consequences:

- **Revoking Jake's accounting role does not stop the email.** Only the editor does.
- The editor's first mode reads **Default ± changes**. "Remove" crosses out jakec@ (it stays visible,
  struck through, with a restore button), and "add" mails extra people. **Fixed list** replaces the
  default outright.
- Every editor rule applies unchanged: remove wins over add, emails are normalized, and a strict
  validation runs on save (`PUT /api/admin/webhooks/automation`, `requireAdminSession`, audited
  `webhook.automation_updated`).
- **Zero effective recipients is a refusal, not an empty send.** The COE request still lands in
  Accounting → Documents with its in-app ping. Only this email is skipped, and the skip is logged.

The name in the editor comes from `employee_ids` (best-effort). It lists jakec@ as "King Gaspar
Calma", so the email greets **"Hi,"** and never a first name.

## Audit: every attempted send, never the unwired case

`webhook.coe_request_notify` (actor `COE Request Notify` / `System`, resource `document_requests`,
`resource_id` = the request id) is written for:

- each POST, with `ok`, `status`, `detail`, `to[]` and `payload_overrides_rejected`;
- the `no_recipients` refusal.

**No URL configured writes nothing.** Before the workflow is imported, a row per COE request would
be pure noise. So "did Jake get it?" has two answers. An audit row means the HRIS tried, and its
`ok` field says whether n8n accepted it. No row means the slug is not wired, or the request was not
an employee COE.

The notifier never throws and never fails the submit. The employee's row is the request; the email
is an extra nudge.

## Payload overrides: `request` is protected

`request` joined `PROTECTED_PAYLOAD_KEYS` (a global list, so this only tightens it). An override can
add a key the workflow reads, such as `cc` or `note_to_handler`. It cannot rewrite who asked or
when. As before, a protected key is refused on save and stripped again at send.

## The n8n workflow

The flow is Webhook `coe-request-notify` → **Build COE Emails** (Code) → Respond → Gmail (one item
per recipient, `onError: continueRegularOutput`).

- **Recipients come from the payload**, validated, deduped and capped at 300. The subject and body
  are fixed in the Code node, so the caller cannot turn the endpoint into a mailer for arbitrary
  content.
- It refuses any `event` other than `coe.requested`, and it refuses an empty recipient list. The
  card's generic **Test** ping therefore fails, which is expected. Use **Open automation → Send test
  run to me** instead.
- `test: true` adds a `[TEST RUN]` subject prefix and an amber banner. A test run uses the fictional
  `sampleCoeRequestRow` and goes to the signed-in admin only.
- Optional lock: `REQUIRED_SECRET` in the Code node plus HRIS env `N8N_COE_REQUEST_NOTIFY_SECRET`
  (sent as `x-webhook-secret`).

## Deploy notes

**No migration.** The editor writes two optional fields onto the slug's existing `webhooks.config`
entry in `app_settings`.

**PENDING Kane (nothing is emailed until all three are done):**

1. n8n: import [`references/n8n/coe-request-notify.workflow.json`](../../references/n8n/coe-request-notify.workflow.json),
   attach the Gmail OAuth2 credential to **Send COE Alert (Gmail)**, then Activate.
2. HRIS: Admin → Webhooks & Integrations → Webhooks → **COE Request → Notify (n8n)**. Paste the
   production webhook URL, toggle Active, then Save. Env fallback: `N8N_COE_REQUEST_NOTIFY_WEBHOOK_URL`.
3. Check it: open the card's **Open automation**. jakec@simple.biz should be listed under "default".
   Click **Send test run to me**, and a `[TEST RUN]` email should arrive in your own inbox.

Optional: `N8N_COE_REQUEST_NOTIFY_SECRET` (Vercel env) paired with `REQUIRED_SECRET` in the Code node.
