import "server-only";

import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";

/**
 * Emails Accounting the moment a one-off Urgent Payment is filed from the
 * People tab (POST /api/people/pay) and lands in Payment Dispatch → Urgent.
 *
 * The n8n workflow owns the recipients (carla@ / claire@ / lennyt@simple.biz)
 * and the full email copy (references/n8n/urgent-payment-alert.workflow.json)
 * — all we send is WHAT was filed, so the webhook can't be turned into an
 * arbitrary mailer. Strictly best-effort: a webhook hiccup must never fail the
 * payment request itself.
 *
 * Uses its own webhook (slug `urgent_payment_notify`) configured in Admin ->
 * Webhooks or via N8N_URGENT_PAYMENT_NOTIFY_WEBHOOK_URL. With nothing
 * configured this no-ops.
 */
export const URGENT_PAYMENT_NOTIFY_SLUG = "urgent_payment_notify";

export interface UrgentPaymentAlertPayload {
  full_name: string;
  work_email: string;
  department?: string | null;
  amount_php: number;
  note?: string | null;
  requested_by?: string | null;
}

export async function sendUrgentPaymentAlert(
  payload: UrgentPaymentAlertPayload,
): Promise<{ ok: boolean }> {
  const webhook = await resolveWebhookUrl(URGENT_PAYMENT_NOTIFY_SLUG, {
    envVars: ["N8N_URGENT_PAYMENT_NOTIFY_WEBHOOK_URL"],
  });
  if (!webhook) return { ok: false };

  // Optional shared-secret header — only sent when configured. Pair it with
  // the matching REQUIRED_SECRET in the n8n "Build Alert Emails" node to lock
  // the webhook so only this server can trigger the alert.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.N8N_URGENT_PAYMENT_NOTIFY_SECRET?.trim();
  if (secret) headers["x-webhook-secret"] = secret;

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "urgent_payment.requested",
        full_name: payload.full_name,
        work_email: payload.work_email,
        department: payload.department ?? null,
        amount_php: payload.amount_php,
        note: payload.note ?? null,
        requested_by: payload.requested_by ?? null,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
