import "server-only";

import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";

/**
 * Emails the red-alarm "add your bank / payout details" alert to employees the
 * People tab flagged as missing banking, when Accounting/CEO clicks Notify.
 *
 * This is the EMAIL side of the Notify button. The button also drops an in-app
 * `bank_info.requested` notification (see app/api/people/request-bank-info) —
 * that part is guaranteed; this email is strictly best-effort so a webhook
 * hiccup never fails the notification.
 *
 * The n8n workflow renders the full HTML itself (references/n8n/
 * bank-info-missing-notify.workflow.json), so all we send is the recipient
 * list — one { email, name } per person. It links them to the public
 * /update-bank-info self-service page.
 *
 * Uses its own webhook (slug `bank_info_notify`) configured in Admin -> Webhooks
 * or via N8N_BANK_INFO_NOTIFY_WEBHOOK_URL. With nothing configured this no-ops.
 */
export const BANK_INFO_NOTIFY_SLUG = "bank_info_notify";

export interface BankInfoNotifyRecipient {
  email: string;
  name?: string | null;
}

export async function sendBankInfoNotifyEmails(
  recipients: BankInfoNotifyRecipient[],
): Promise<{ ok: boolean; sent: number }> {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { ok: false, sent: 0 };
  }

  const webhook = await resolveWebhookUrl(BANK_INFO_NOTIFY_SLUG, {
    envVars: ["N8N_BANK_INFO_NOTIFY_WEBHOOK_URL"],
  });
  if (!webhook) return { ok: false, sent: 0 };

  // Normalise + dedupe by address (keep the first non-empty name), matching the
  // notification path so the email list can't diverge from who got the nudge.
  const seen = new Map<string, string>();
  for (const r of recipients) {
    const email = (r?.email ?? "").trim().toLowerCase();
    if (!email) continue;
    const name = (r?.name ?? "").trim();
    if (!seen.has(email)) seen.set(email, name);
    else if (!seen.get(email) && name) seen.set(email, name);
  }
  if (seen.size === 0) return { ok: false, sent: 0 };

  const clean = Array.from(seen, ([email, name]) => ({ email, name }));

  // Optional shared-secret header — only sent when configured. Pair it with the
  // matching REQUIRED_SECRET in the n8n "Build Recipients" node to lock the
  // webhook so only this server can trigger a bank-update email.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.N8N_BANK_INFO_NOTIFY_SECRET?.trim();
  if (secret) headers["x-webhook-secret"] = secret;

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "bank_info.requested",
        recipients: clean,
        sent_by: "system",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok, sent: clean.length };
  } catch {
    return { ok: false, sent: 0 };
  }
}
