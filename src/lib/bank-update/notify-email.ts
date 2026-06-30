import "server-only";

import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";

/**
 * Emails the payroll team whenever an employee self-updates their bank/payout
 * details via the public /update-bank-info link.
 *
 * SECURITY: this email carries only WHO changed WHAT FIELDS (names) — never the
 * actual account numbers / SWIFT / values. The payroll team reviews the real
 * (audited) values in the People tab.
 *
 * Uses its own n8n webhook (slug `bank_update_notify`) so it can be a separate
 * automation from the OTP-code email. Configure it in Admin -> Webhooks or via
 * N8N_BANK_UPDATE_NOTIFY_WEBHOOK_URL. With nothing configured this no-ops.
 */
export const BANK_UPDATE_NOTIFY_SLUG = "bank_update_notify";
const BANK_UPDATE_NOTIFY_LEGACY_KEY = "hr.bank_update_notify_webhook_url";

/** Recipient — defaults to payroll@simple.biz, overridable via env. */
function notifyRecipient(): string {
  return process.env.BANK_UPDATE_NOTIFY_EMAIL?.trim() || "payroll@simple.biz";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "alt_account_number" -> "Alt Account Number" */
function humanizeField(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderNotifyHtml(rows: [string, string][], fields: string[]): string {
  const tr = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px;color:#71717a;font-size:13px;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 12px;font-size:13px;font-weight:600;color:#18181b">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  const chips = fields
    .map(
      (f) =>
        `<span style="display:inline-block;margin:0 4px 4px 0;padding:2px 8px;border-radius:999px;background:#eef2ff;color:#3730a3;font-size:12px">${escapeHtml(humanizeField(f))}</span>`,
    )
    .join("");
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f5;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #e4e4e7;overflow:hidden">
    <tr><td style="padding:22px 24px 6px">
      <p style="margin:0 0 4px;font-size:16px;font-weight:700">Bank details updated</p>
      <p style="margin:0 0 16px;font-size:13px;color:#71717a">An employee updated their payout details via the external self-service link.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #f1f1f4;border-radius:10px;border-collapse:separate">${tr}</table>
      <p style="margin:16px 0 6px;font-size:13px;color:#71717a">Fields changed</p>
      <div>${chips || '<span style="font-size:13px;color:#a1a1aa">—</span>'}</div>
      <p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#a1a1aa">For security, the actual account numbers aren't included here — review the full, audited values in the People tab (Accounting / CEO).</p>
    </td></tr>
    <tr><td style="padding:14px 24px 22px;border-top:1px solid #f4f4f5"><p style="margin:0;font-size:12px;color:#a1a1aa">Simple.biz HRIS — automated alert</p></td></tr>
  </table>
</body></html>`;
}

export async function sendBankUpdatePayrollEmail(params: {
  employeeName: string | null;
  workEmail: string;
  fields: string[];
  processor: string | null;
  createdNew: boolean;
}): Promise<{ ok: boolean }> {
  const webhook = await resolveWebhookUrl(BANK_UPDATE_NOTIFY_SLUG, {
    legacyKey: BANK_UPDATE_NOTIFY_LEGACY_KEY,
    envVars: ["N8N_BANK_UPDATE_NOTIFY_WEBHOOK_URL"],
  });
  if (!webhook) return { ok: false };

  const to = notifyRecipient();
  const who = params.employeeName
    ? `${params.employeeName} (${params.workEmail})`
    : params.workEmail;
  const fieldLabels = params.fields.map(humanizeField);
  const rows: [string, string][] = [
    ["Employee", who],
    ["Payment method", params.processor || "—"],
    ["Change", params.createdNew ? "First-time payout setup" : "Updated existing details"],
  ];
  const subject = `Bank details updated — ${params.employeeName || params.workEmail}`;
  const body = `${who} updated their bank & payout details via the external link.\n\nPayment method: ${params.processor || "—"}\nFields changed: ${fieldLabels.join(", ") || "—"}\n\nFor security, account numbers aren't included — review them in the People tab (Accounting / CEO).`;

  const payload = {
    to,
    subject,
    body,
    html: renderNotifyHtml(rows, params.fields),
    event: "bank_update.saved",
    employee_name: params.employeeName,
    work_email: params.workEmail,
    processor: params.processor,
    fields: params.fields,
    created_new: params.createdNew,
    sent_by: "system",
  };

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
