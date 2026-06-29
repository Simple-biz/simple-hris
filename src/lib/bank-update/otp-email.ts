import "server-only";

import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";

/**
 * Sends the /update-bank-info one-time code to an employee's work inbox.
 *
 * The app has no in-app mailer — all transactional email goes out through an
 * n8n webhook that accepts { to, subject, body, html }. We resolve a dedicated
 * `bank_update_otp` webhook first (configure it in Admin -> Webhooks, or via
 * N8N_OTP_WEBHOOK_URL), then fall back to the existing onboarding webhook which
 * already speaks the same to/subject/body/html contract — so the feature works
 * out of the box and can be split onto its own n8n flow later.
 */
export const OTP_WEBHOOK_SLUG = "bank_update_otp";
const OTP_WEBHOOK_LEGACY_KEY = "hr.otp_webhook_url";
/** Last-resort default: the onboarding n8n flow (accepts to/subject/body/html). */
const OTP_WEBHOOK_DEFAULT = "https://simpledotbiz.app.n8n.cloud/webhook/7cb7afed-ef97-4cb9-92d5-31938695df18";

export function resolveOtpWebhookUrl(): Promise<string | null> {
  return resolveWebhookUrl(OTP_WEBHOOK_SLUG, {
    legacyKey: OTP_WEBHOOK_LEGACY_KEY,
    envVars: ["N8N_OTP_WEBHOOK_URL"],
    defaultUrl: OTP_WEBHOOK_DEFAULT,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderOtpEmailHtml(name: string, code: string): string {
  const greeting = name ? `Hi ${escapeHtml(name.split(/\s+/)[0])},` : "Hi,";
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f5;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #e4e4e7;overflow:hidden">
    <tr><td style="padding:28px 28px 8px">
      <p style="margin:0 0 14px;font-size:15px">${greeting}</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#3f3f46">Use this one-time code to update your bank &amp; payout details:</p>
      <div style="font-size:34px;font-weight:700;letter-spacing:8px;text-align:center;background:#f4f4f5;border-radius:12px;padding:18px 0;color:#111827">${escapeHtml(code)}</div>
      <p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#71717a">This code expires in 10 minutes. If you didn't request it, you can safely ignore this email — your details won't change.</p>
    </td></tr>
    <tr><td style="padding:16px 28px 24px;border-top:1px solid #f4f4f5">
      <p style="margin:0;font-size:12px;color:#a1a1aa">— The Simple.biz Team</p>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Fire the OTP email. Returns { ok } — callers should treat a false as a soft
 * failure (the code row already exists; the employee can request another).
 * Throws only when no webhook is configured at all (a deployment misconfig).
 */
export async function sendBankUpdateOtpEmail(
  workEmail: string,
  name: string,
  code: string,
): Promise<{ ok: boolean }> {
  const webhookUrl = await resolveOtpWebhookUrl();
  if (!webhookUrl) {
    throw new Error(
      "No OTP email webhook configured. Set the `bank_update_otp` webhook in Admin -> Webhooks (or N8N_OTP_WEBHOOK_URL).",
    );
  }

  const greetingName = name ? name.split(/\s+/)[0] : "";
  const payload = {
    to: workEmail,
    recipient_name: name,
    otp_code: code,
    subject: "Your Simple.biz bank-update code",
    body: `Hi${greetingName ? ` ${greetingName}` : ""},\n\nUse this one-time code to update your bank & payout details:\n\n${code}\n\nThis code expires in 10 minutes. If you didn't request it, you can ignore this email.\n\n— The Simple.biz Team`,
    html: renderOtpEmailHtml(name, code),
    sent_by: "system",
  };

  try {
    const res = await fetch(webhookUrl, {
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
