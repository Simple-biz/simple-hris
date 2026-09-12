import 'server-only';

import { resolveWebhookUrl } from '@/lib/webhooks/resolve-webhook';

/**
 * Sends the /update-gift-address one-time code to an employee's work inbox.
 *
 * The app has no in-app mailer — every transactional email leaves through an
 * **n8n** webhook that accepts `{ to, subject, body, html }`.
 *
 * THIS NEEDS ITS OWN n8n FLOW. It must not reuse `bank_update_otp`: that flow's
 * copy says "bank-update code", so borrowing it would email someone a bank
 * notice for a gift, and any later edit to the bank flow would silently change
 * what gift recipients read. Configure it in **Admin → Webhooks** under the slug
 * `gift_address_otp`, or set `N8N_GIFT_ADDRESS_OTP_WEBHOOK_URL`.
 *
 * With nothing configured this returns null and no mail is sent — the route then
 * 503s in production and prints the code to the server console in dev, so the
 * flow stays testable without n8n.
 */
export const GIFT_ADDRESS_OTP_WEBHOOK_SLUG = 'gift_address_otp';

export function resolveGiftAddressOtpWebhookUrl(): Promise<string | null> {
  return resolveWebhookUrl(GIFT_ADDRESS_OTP_WEBHOOK_SLUG, {
    envVars: ['N8N_GIFT_ADDRESS_OTP_WEBHOOK_URL'],
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Pink/rose to match the gift card on the employee dashboard, not the bank flow's zinc. */
function renderGiftOtpEmailHtml(name: string, code: string): string {
  const greeting = name ? `Hi ${escapeHtml(name.split(/\s+/)[0])},` : 'Hi,';
  return `<!DOCTYPE html><html><body style="margin:0;background:#fdf2f8;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:14px;border:1px solid #fbcfe8;overflow:hidden">
    <tr><td style="background:linear-gradient(135deg,#ec4899,#e11d48);padding:22px 28px;color:#ffffff">
      <p style="margin:0;font-size:17px;font-weight:700">Your tenure gift</p>
      <p style="margin:4px 0 0;font-size:13px;opacity:.9">Let us know where to send it</p>
    </td></tr>
    <tr><td style="padding:26px 28px 8px">
      <p style="margin:0 0 14px;font-size:15px">${greeting}</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#3f3f46">Use this one-time code to confirm it is you, then tell us your delivery address:</p>
      <div style="font-size:34px;font-weight:700;letter-spacing:8px;text-align:center;background:#fdf2f8;border-radius:12px;padding:18px 0;color:#9d174d">${escapeHtml(code)}</div>
      <p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#71717a">This code expires in 10 minutes. If you didn&rsquo;t request it, you can safely ignore this email &mdash; nothing will change.</p>
    </td></tr>
    <tr><td style="padding:16px 28px 24px;border-top:1px solid #fce7f3">
      <p style="margin:0;font-size:12px;color:#a1a1aa">&mdash; The Simple.biz Team</p>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Fire the code email.
 *
 * Returns `{ ok }` — a false is a SOFT failure: the code row already exists and
 * the employee can request another. Throws only when no webhook is configured at
 * all, which is a deployment misconfiguration rather than anything about this
 * particular person, and is therefore safe to report without leaking whether
 * the address belongs to an employee.
 */
export async function sendGiftAddressOtpEmail(
  workEmail: string,
  name: string,
  code: string,
): Promise<{ ok: boolean }> {
  const webhookUrl = await resolveGiftAddressOtpWebhookUrl();
  if (!webhookUrl) {
    throw new Error(
      'No gift-address OTP webhook configured. Set the `gift_address_otp` webhook in Admin → Webhooks (or N8N_GIFT_ADDRESS_OTP_WEBHOOK_URL).',
    );
  }

  const greetingName = name ? name.split(/\s+/)[0] : '';
  const payload = {
    to: workEmail,
    recipient_name: name,
    otp_code: code,
    subject: 'Your Simple.biz tenure gift — confirmation code',
    body: `Hi${greetingName ? ` ${greetingName}` : ''},\n\nUse this one-time code to confirm it is you, then tell us where to send your tenure gift:\n\n${code}\n\nThis code expires in 10 minutes. If you didn't request it, you can ignore this email.\n\n— The Simple.biz Team`,
    html: renderGiftOtpEmailHtml(name, code),
    sent_by: 'system',
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
