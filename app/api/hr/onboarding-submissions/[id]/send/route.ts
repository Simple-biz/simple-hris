import { NextResponse } from "next/server";
import {
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";
import { resolveWebhookUrl } from "@/lib/webhooks/resolve-webhook";
import {
  getHrOnboardingSubmissionById,
  rotateHrOnboardingToken,
} from "@/lib/supabase/hr-onboarding-submissions";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Slug in the Admin -> Webhooks config (webhooks.config). */
export const ONBOARDING_WEBHOOK_SLUG = "onboarding_send";
/** Legacy bare-URL app_settings key, kept as a fallback for un-migrated envs. */
export const ONBOARDING_WEBHOOK_KEY = "hr.onboarding_webhook_url";
/** Hardcoded production default, used last (see resolveWebhookUrl order). */
const ONBOARDING_WEBHOOK_DEFAULT =
  "https://simpledotbiz.app.n8n.cloud/webhook/7cb7afed-ef97-4cb9-92d5-31938695df18";

/**
 * Canonical W-8BEN form, hosted by the IRS. Linking directly means recipients
 * always get the latest revision and we don't have to keep a copy in sync.
 * Both the in-email "Download" link and the `attachments[0].url` shipped to
 * n8n point here, so n8n's HTTP Request node fetches the binary straight
 * from irs.gov when attaching to the outgoing email.
 */
const W8BEN_URL = "https://www.irs.gov/pub/irs-pdf/fw8ben.pdf";

/**
 * POST /api/hr/onboarding-submissions/[id]/send
 *
 * Fires the configured webhook (n8n, Zapier, etc.) with the onboarding-link
 * details. The webhook is responsible for actually delivering the email, so
 * HR doesn't depend on the browser/OS mail client. The URL is resolved from
 * the Admin -> Webhooks config (slug `onboarding_send`), falling back to the
 * legacy `app_settings[hr.onboarding_webhook_url]` key, so it can be rotated
 * without a redeploy.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await context.params;

  const webhookUrl = await resolveWebhookUrl(ONBOARDING_WEBHOOK_SLUG, {
    legacyKey: ONBOARDING_WEBHOOK_KEY,
    defaultUrl: ONBOARDING_WEBHOOK_DEFAULT,
  });
  if (!webhookUrl) {
    return NextResponse.json(
      {
        error:
          "No onboarding webhook configured. Set the `onboarding_send` webhook URL in Admin -> Webhooks (or the legacy `hr.onboarding_webhook_url` app_settings key).",
      },
      { status: 400 },
    );
  }

  const { row, error: fetchErr } = await getHrOnboardingSubmissionById(id);
  if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Recipient sanity check — the webhook needs *something* to send to.
  const recipient = row.invite_personal_email?.trim() || row.email?.trim() || "";
  if (!recipient) {
    return NextResponse.json(
      {
        error:
          "This submission has no recipient email. Edit the row to add invite_personal_email before sending.",
      },
      { status: 400 },
    );
  }

  // Mint a fresh token on every send so each outbound email carries a unique
  // URL — and any prior link for this row becomes a 404. Works for both
  // pending and submitted rows (HR can resend to submitted hires). Archived
  // rows are blocked at the token-rotation step.
  const { token: rotatedToken, error: rotateErr } = await rotateHrOnboardingToken(id);
  if (rotateErr || !rotatedToken) {
    return NextResponse.json(
      { error: rotateErr ?? "Failed to rotate onboarding token" },
      { status: 500 },
    );
  }
  const activeToken = rotatedToken;

  const origin = new URL(req.url).origin;
  const link = `${origin}/onboarding/${activeToken}`;

  // Optional override coming from the modal — HR can tweak the body/subject
  // before sending without us re-rendering the page.
  let overrideSubject: string | undefined;
  let overrideBody: string | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      subject?: string;
      body?: string;
    };
    overrideSubject = body.subject?.trim() || undefined;
    overrideBody = body.body?.trim() || undefined;
  } catch {
    // No JSON body — that's fine, defaults below.
  }

  const firstName = row.invite_name ? row.invite_name.split(/\s+/)[0] : null;
  const greeting = `Hi${firstName ? ` ${firstName}` : ""}`;

  const defaultBody = `${greeting},

Welcome to Simple.biz! Please complete your onboarding form here — it should take about 10 minutes:

${link}

No account needed; the link is private to you.

Let me know if you hit any issues.

— The Simple.biz Team`;

  const w8benUrl = W8BEN_URL;

  const subject = overrideSubject ?? "Welcome to Simple.biz — your onboarding form";
  const plainBody = overrideBody ?? defaultBody;
  const html = renderOnboardingEmailHtml({
    greeting,
    link,
    logoUrl: `${origin}/simple-logo.png`,
    note: row.invite_note,
    department: row.invite_department,
    w8benUrl,
  });

  const payload = {
    submission_id: row.id,
    token: activeToken,
    link,
    sent_by: authz.sessionEmail,
    to: recipient,
    invite_name: row.invite_name,
    invite_department: row.invite_department,
    invite_note: row.invite_note,
    subject,
    /** Plain-text fallback for clients that don't render HTML. */
    body: plainBody,
    /** Pre-rendered HTML — wire this into the Gmail/SMTP node's "HTML" field. */
    html,
    /**
     * Files n8n should attach. In n8n: feed each `url` into an HTTP Request
     * node (response type: file), then pass the binary into the Gmail/SMTP
     * node's "Attachments" field with the matching `filename`. If you'd
     * rather not attach (older n8n versions, big attachments), just drop the
     * field — the HTML body already links to the same URL.
     */
    attachments: [
      {
        url: w8benUrl,
        filename: "FW8BEN.pdf",
        contentType: "application/pdf",
        description:
          "IRS W-8BEN form — required for contract workers outside the US.",
      },
    ],
  };

  let webhookStatus: number | null = null;
  let webhookText: string | null = null;
  let webhookError: string | null = null;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Don't hang the request indefinitely if n8n is down.
      signal: AbortSignal.timeout(15_000),
    });
    webhookStatus = res.status;
    webhookText = await res.text().catch(() => null);
    if (!res.ok) {
      webhookError = `Webhook returned ${res.status}${webhookText ? `: ${webhookText.slice(0, 240)}` : ""}`;
    }
  } catch (e) {
    webhookError =
      e instanceof Error ? e.message : "Webhook request failed (unknown error)";
  }

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: "HR",
    action: "hr.onboarding.send_webhook",
    resource: "hr_onboarding_submissions",
    resource_id: row.id,
    details: {
      to: recipient,
      link,
      webhook_status: webhookStatus,
      webhook_error: webhookError,
    },
  });

  if (webhookError) {
    return NextResponse.json(
      { error: webhookError, webhookStatus },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    webhookStatus,
    to: recipient,
    // Returned so the HR UI can refresh its locally-cached row — the token was
    // just rotated, and any older copy of the URL is now stale.
    token: activeToken,
    link,
  });
}

// ─── HTML email template ──────────────────────────────────────────────────
//
// Designed for compatibility with Gmail / Outlook / Apple Mail — uses inline
// styles and table layout so it survives the usual email-client mangling.
// Brand palette mirrors the Simple logo: deep navy + an orange heart accent
// on warm white.
//
// Design preview: references/onboarding_welcome_email.html (open in browser).
// Keep that file in sync when changing the template here.

const COLORS = {
  navy: "#1e1b4b",
  navyDeep: "#15123b",
  navySoft: "#e0e7ff",
  orange: "#f97316",
  orangeSoft: "#fff7ed",
  cream: "#fafaf7",
  ink: "#1f2937",
  inkMute: "#6b7280",
  ruleLight: "#e5e7eb",
} as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderOnboardingEmailHtml(args: {
  greeting: string;
  link: string;
  logoUrl: string;
  note: string | null;
  department: string | null;
  w8benUrl: string | null;
}): string {
  const { greeting, link, logoUrl, note, department, w8benUrl } = args;
  const safeLink = escapeHtml(link);
  const safeGreeting = escapeHtml(greeting);
  const safeLogo = escapeHtml(logoUrl);
  const safeNote = note ? escapeHtml(note) : null;
  const safeDept = department ? escapeHtml(department) : null;
  const safeW8Ben = w8benUrl ? escapeHtml(w8benUrl) : null;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Welcome to Simple.biz</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.cream};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Helvetica,Arial,sans-serif;color:${COLORS.ink};-webkit-font-smoothing:antialiased;">
  <!-- Hidden preheader (shows in inbox preview, hidden in the email body) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
    ${safeGreeting} — your Simple.biz onboarding form is ready. Takes about 10 minutes.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.cream};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${COLORS.ruleLight};box-shadow:0 4px 14px rgba(30,27,75,0.06);">

          <!-- HEADER — navy band with logo + orange heart sparkle -->
          <tr>
            <td style="background-color:${COLORS.navy};background-image:linear-gradient(135deg,${COLORS.navy} 0%,${COLORS.navyDeep} 100%);padding:36px 36px 28px 36px;text-align:center;color:#ffffff;">
              <img src="${safeLogo}" alt="Simple.biz" width="140" style="display:inline-block;max-width:140px;height:auto;border:0;outline:none;text-decoration:none;background-color:#ffffff;padding:10px 16px;border-radius:12px;" />
              <p style="margin:18px 0 0 0;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:${COLORS.orange};">
                ♥ Welcome to the team
              </p>
              <h1 style="margin:8px 0 0 0;font-size:24px;line-height:1.25;font-weight:700;color:#ffffff;">
                Your onboarding form is ready
              </h1>
              ${
                safeDept
                  ? `<p style="margin:6px 0 0 0;font-size:13px;color:rgba(255,255,255,0.72);">For the <strong style="color:#ffffff;font-weight:600;">${safeDept}</strong> team</p>`
                  : ""
              }
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="padding:32px 36px 8px 36px;">
              <p style="margin:0 0 14px 0;font-size:16px;line-height:1.55;color:${COLORS.ink};">${safeGreeting},</p>
              <p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;color:${COLORS.ink};">
                We're so glad to have you with us. Please take about <strong>10 minutes</strong> to complete the
                onboarding form below so we can set you up properly in our system.
              </p>

              <!-- CTA button (bulletproof table layout — works in Outlook too) -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto 8px auto;">
                <tr>
                  <td align="center" bgcolor="${COLORS.navy}" style="background-color:${COLORS.navy};background-image:linear-gradient(135deg,${COLORS.navy} 0%,${COLORS.navyDeep} 100%);border-radius:10px;">
                    <a href="${safeLink}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;border:1px solid ${COLORS.navyDeep};">
                      Open my onboarding form  →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:18px 0 0 0;font-size:13px;line-height:1.55;color:${COLORS.inkMute};text-align:center;">
                Or paste this URL into your browser:<br />
                <a href="${safeLink}" style="color:${COLORS.navy};word-break:break-all;text-decoration:underline;">${safeLink}</a>
              </p>

              ${
                safeNote
                  ? `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0;">
                <tr>
                  <td style="background-color:${COLORS.orangeSoft};border-left:3px solid ${COLORS.orange};border-radius:8px;padding:14px 16px;">
                    <p style="margin:0 0 4px 0;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.orange};">
                      ♥ Note from HR
                    </p>
                    <p style="margin:0;font-size:14px;line-height:1.5;color:${COLORS.ink};">${safeNote}</p>
                  </td>
                </tr>
              </table>`
                  : ""
              }

              ${
                safeW8Ben
                  ? `
              <!-- W-8BEN attachment card (only renders when w8benUrl is provided) -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0;border:1px solid ${COLORS.ruleLight};border-radius:10px;background-color:#ffffff;">
                <tr>
                  <td style="padding:16px 18px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td valign="top" style="width:44px;">
                          <div style="width:38px;height:46px;background-color:${COLORS.orangeSoft};border:1px solid ${COLORS.orange};border-radius:6px;text-align:center;line-height:44px;font-size:10px;font-weight:700;letter-spacing:0.5px;color:${COLORS.orange};">PDF</div>
                        </td>
                        <td valign="top" style="padding-left:14px;">
                          <p style="margin:0 0 2px 0;font-size:13px;font-weight:700;color:${COLORS.navy};">
                            FW8BEN.pdf
                            <span style="font-weight:500;color:${COLORS.inkMute};font-size:11px;">&nbsp; (attached)</span>
                          </p>
                          <p style="margin:0 0 8px 0;font-size:12px;line-height:1.5;color:${COLORS.inkMute};">
                            IRS W-8BEN form. Required only if you're a contract worker outside the US — fill it out, then upload it on step 4 of the onboarding form.
                          </p>
                          <a href="${safeW8Ben}" target="_blank" style="display:inline-block;font-size:12px;font-weight:600;color:${COLORS.navy};text-decoration:underline;">Download FW8BEN.pdf &rarr;</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>`
                  : ""
              }

              <!-- "What to expect" card -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0 0;border:1px solid ${COLORS.ruleLight};border-radius:10px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <p style="margin:0 0 10px 0;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.navy};">
                      What you'll fill in
                    </p>
                    <p style="margin:0;font-size:13px;line-height:1.7;color:${COLORS.ink};">
                      <span style="color:${COLORS.orange};">●</span>&nbsp;&nbsp;Your contact info<br />
                      <span style="color:${COLORS.orange};">●</span>&nbsp;&nbsp;Non-solicitation &amp; privacy agreements<br />
                      <span style="color:${COLORS.orange};">●</span>&nbsp;&nbsp;W-8BEN upload (only if you're outside the US)<br />
                      <span style="color:${COLORS.orange};">●</span>&nbsp;&nbsp;How you'd like to be paid — Hurupay or wire transfer<br />
                      <span style="color:${COLORS.orange};">●</span>&nbsp;&nbsp;Contract worker agreement signature
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:28px 0 0 0;font-size:13px;line-height:1.55;color:${COLORS.inkMute};">
                No account needed — this link is private to you. If you hit any issues, just reply to this
                email and we'll help you through it.
              </p>

              <p style="margin:24px 0 0 0;font-size:15px;line-height:1.55;color:${COLORS.ink};">
                Welcome aboard,<br />
                <strong style="color:${COLORS.navy};">The Simple.biz Team</strong>
                <span style="color:${COLORS.orange};">♥</span>
              </p>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding:24px 36px 28px 36px;text-align:center;border-top:1px solid ${COLORS.ruleLight};background-color:${COLORS.cream};">
              <p style="margin:0 0 6px 0;font-size:11px;color:${COLORS.inkMute};">
                Questions? Reach us at
                <a href="mailto:hr@simple.biz" style="color:${COLORS.navy};font-weight:600;text-decoration:none;">hr@simple.biz</a>
                or
                <a href="mailto:payroll@simple.biz" style="color:${COLORS.navy};font-weight:600;text-decoration:none;">payroll@simple.biz</a>.
              </p>
              <p style="margin:0;font-size:10px;color:${COLORS.inkMute};letter-spacing:0.5px;">
                Simple.biz &nbsp;·&nbsp; This link is single-use and tied only to you.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
