/**
 * "New MESA request" email — the pure half (docs/features/mesa-request-notify.md).
 *
 * A member files an opt-out, disbursement or return from Employee → MESA →
 * Request; the HRIS POSTs this payload to the n8n workflow
 * (references/n8n/mesa-request-notify.workflow.json), which emails each
 * recipient "a MESA request is waiting in Accounting → MESA → Requests".
 *
 * The default audience is two fixed addresses (tickets board, 2026-10-05:
 * carla@simple.biz and april@simple.biz), changed from Admin → Webhooks →
 * "MESA Request → Notify" → Open automation. Nothing here reads a role.
 *
 * NO AMOUNT, NO REASON, NO EXPLANATION. A disbursement's explanation is often
 * medical, and the amount is the member's own savings; both stay behind the
 * `mesa` grant on the Requests tab. The email says WHO filed WHAT KIND of
 * request and WHEN, and links to the HRIS. Do not add them to make the email
 * "more useful" — the recipient list is admin-editable and need not hold the
 * grant (the same rule as docs/features/coe-request-notify.md § No pay figures).
 *
 * Pure: no I/O. The server notifier (`request-notify.ts`) and the Admin
 * preview/test run both build through `buildMesaRequestPayload`.
 */

import { normalizeEmail, type WebhookRecipient } from '@/lib/webhooks/webhook-config';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';

export const MESA_REQUEST_NOTIFY_SLUG = 'mesa_request_notify';

/** What fires it — the one call site (app/api/mesa-requests/route.ts POST). */
export const MESA_REQUEST_TRIGGER = 'employee_mesa_request';

/** The code default (tickets board, 2026-10-05). The Admin editor adjusts it. */
export const MESA_REQUEST_DEFAULT_RECIPIENTS: readonly WebhookRecipient[] = [
  { email: 'carla@simple.biz', name: null },
  { email: 'april@simple.biz', name: null },
];

/**
 * The request types Accounting reviews, and so the only ones mailed. `opt_in`
 * is retired (joining is the FPU pipeline, HR's) and never reaches Accounting.
 */
export const MESA_NOTIFY_REQUEST_TYPES = ['opt_out', 'disbursement', 'return'] as const;
export type MesaNotifyRequestType = (typeof MESA_NOTIFY_REQUEST_TYPES)[number];

export function isMesaNotifyRequestType(t: unknown): t is MesaNotifyRequestType {
  return typeof t === 'string' && (MESA_NOTIFY_REQUEST_TYPES as readonly string[]).includes(t);
}

const REQUEST_LABELS: Record<MesaNotifyRequestType, string> = {
  opt_out: 'Opt-out',
  disbursement: 'Disbursement',
  return: 'Return',
};

/** The row fields the payload may read. Amount, reason and explanation are deliberately absent. */
export interface MesaRequestNotifyRow {
  id: string;
  work_email: string;
  full_name: string | null;
  department: string | null;
  request_type: MesaNotifyRequestType;
  created_at: string;
}

export interface MesaRequestPayloadInput {
  row: MesaRequestNotifyRow;
  recipients: readonly WebhookRecipient[];
  /** Set on an Admin test run; the workflow labels the subject. */
  test?: boolean;
}

function manilaDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Manila',
  });
}

/** The payload, built from the request row and nothing else. */
export function buildMesaRequestPayload(input: MesaRequestPayloadInput): Record<string, unknown> {
  const { row } = input;
  const recipients: { email: string; name: string | null }[] = [];
  const seen = new Set<string>();
  for (const r of input.recipients) {
    const email = normalizeEmail(r.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    recipients.push({ email, name: r.name ?? null });
  }
  const department = row.department?.trim() || null;
  return {
    event: 'mesa.requested',
    trigger: MESA_REQUEST_TRIGGER,
    request: {
      id: row.id,
      request_type: row.request_type,
      request_label: REQUEST_LABELS[row.request_type],
      employee_name: row.full_name?.trim() || null,
      employee_email: row.work_email,
      department: department ? formatDeptLabel(department) || department : null,
      requested_at: row.created_at,
      requested_at_manila: manilaDateTime(row.created_at),
    },
    recipients,
    sent_by: 'system',
    ...(input.test ? { test: true } : {}),
  };
}
