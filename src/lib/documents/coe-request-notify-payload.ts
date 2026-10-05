/**
 * "COE requested" email — the pure half (docs/features/coe-request-notify.md).
 *
 * An employee files a Certificate of Engagement request from Profile → Request
 * Documents; the HRIS POSTs this payload to the n8n workflow
 * (references/n8n/coe-request-notify.workflow.json), which emails each recipient
 * "a COE is waiting in Accounting → Documents".
 *
 * The default audience is ONE fixed address (Kane, 2026-10-05: jakec@simple.biz),
 * changed from Admin → Webhooks → "COE Request → Notify" → Open automation —
 * remove/add on top of the default, or a fixed list that replaces it. Nothing
 * here reads a role: losing the accounting role does NOT stop the mail. The
 * editor is the only way to change who gets it.
 *
 * NO PAY FIGURES. The row's `period_label` carries the certified rate
 * ("Engaged since … · ₱225.00/hr") and the stored draft PDF carries every rate
 * and bonus line; both stay behind the Accounting → Documents grant. The email
 * says WHO asked and WHEN, and links to the HRIS. Do not add the label or the
 * PDF to make the email "more useful" — the recipient list is admin-editable and
 * need not hold the Documents grant.
 *
 * Pure: no I/O. The server notifier (`coe-request-notify.ts`) and the Admin
 * preview/test run both build through `buildCoeRequestPayload`, so the preview
 * is the payload.
 */

import { normalizeEmail, type WebhookRecipient } from '@/lib/webhooks/webhook-config';
import { formatDocumentDateTime, type DocumentRequestRow } from './types';

export const COE_REQUEST_NOTIFY_SLUG = 'coe_request_notify';

/** What fires it — the one call site (app/api/employee/documents/route.ts). */
export const COE_REQUEST_TRIGGER = 'employee_coe_request';

/**
 * The code default (Kane, 2026-10-05). The Admin editor adjusts it; it is not a
 * role lookup, so it does not change when someone's grants change.
 */
export const COE_REQUEST_DEFAULT_RECIPIENTS: readonly WebhookRecipient[] = [
  { email: 'jakec@simple.biz', name: null },
];

/** The row fields the payload may read. `period_label` is deliberately absent. */
export type CoeRequestNotifyRow = Pick<
  DocumentRequestRow,
  'id' | 'employee_email' | 'employee_name' | 'note' | 'requested_at'
>;

export interface CoeRequestPayloadInput {
  row: CoeRequestNotifyRow;
  recipients: readonly WebhookRecipient[];
  /** Set on an Admin test run; the workflow labels the subject. */
  test?: boolean;
}

/** The payload, built from the request row and nothing else. */
export function buildCoeRequestPayload(input: CoeRequestPayloadInput): Record<string, unknown> {
  const { row } = input;
  const recipients: { email: string; name: string | null }[] = [];
  const seen = new Set<string>();
  for (const r of input.recipients) {
    const email = normalizeEmail(r.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    recipients.push({ email, name: r.name ?? null });
  }
  return {
    event: 'coe.requested',
    trigger: COE_REQUEST_TRIGGER,
    request: {
      id: row.id,
      document_type: 'coe',
      document_label: 'Certificate of Engagement',
      employee_name: row.employee_name?.trim() || null,
      employee_email: row.employee_email,
      requested_at: row.requested_at,
      requested_at_manila: formatDocumentDateTime(row.requested_at),
      note: row.note?.trim() || null,
    },
    recipients,
    sent_by: 'system',
    ...(input.test ? { test: true } : {}),
  };
}
