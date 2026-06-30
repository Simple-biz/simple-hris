import { NextResponse } from "next/server";
import { findActiveEmployeeByEmail, createOtpForEmail } from "@/lib/bank-update/otp";
import { sendBankUpdateOtpEmail, resolveOtpWebhookUrl } from "@/lib/bank-update/otp-email";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip");
}

/** Always-the-same answer so this endpoint can't be used to enumerate emails. */
const GENERIC = {
  ok: true,
  message:
    "If that email belongs to an active employee, a 6-digit code is on its way to your work inbox.",
};

/**
 * Strict-enough email shape that excludes LIKE/PostgREST metacharacters (`%`,
 * quotes, parens, commas, whitespace) before any DB lookup. `_`/`.`/`+`/`-` stay
 * allowed (valid in real addresses) and are escaped at the query layer.
 */
const EMAIL_OK = /^[^\s@%,"'()]+@[^\s@%,"'()]+\.[^\s@%,"'()]+$/;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string };
  const email = normEmail(body.email) ?? "";
  if (!email) {
    return NextResponse.json({ error: "Enter your work email." }, { status: 400 });
  }
  // Malformed input: answer generically (no DB hit) so it's indistinguishable
  // from a valid-but-unknown email.
  if (!EMAIL_OK.test(email)) {
    return NextResponse.json(GENERIC);
  }

  // Resolve the email channel first. A missing webhook is a deployment
  // misconfiguration (not email-specific), so reporting it leaks nothing and
  // keeps the generic response below truly indistinguishable per-email. In
  // local dev we allow proceeding without a webhook and print the code to the
  // server console so the flow is testable without n8n.
  const webhook = await resolveOtpWebhookUrl();
  const isDev = process.env.NODE_ENV !== "production";
  if (!webhook && !isDev) {
    return NextResponse.json(
      {
        error:
          "The verification email channel isn't set up yet. Please contact HR or Accounting.",
      },
      { status: 503 },
    );
  }

  const ip = clientIp(req);
  const match = await findActiveEmployeeByEmail(email);

  if (!match) {
    void insertAuditLog({
      user_name: "external",
      user_role: "public",
      action: "bank_update.otp_requested",
      resource: "bank_update_otps",
      resource_id: email,
      details: { found: false },
      ip_address: ip,
    });
    return NextResponse.json(GENERIC);
  }

  const code = await createOtpForEmail(match.workEmail, ip);
  if (code) {
    if (webhook) {
      // Soft-fail: the code row exists; the employee can request another if the
      // mail hiccups. Never surface delivery state (would leak that the email exists).
      await sendBankUpdateOtpEmail(match.workEmail, match.name, code).catch(() => ({ ok: false }));
    } else if (isDev) {
      // No email webhook configured (local dev only): expose the code in the
      // server terminal so the flow can be tested end-to-end.
      console.warn(`[bank-update] DEV verification code for ${match.workEmail}: ${code}`);
    }
  }

  void insertAuditLog({
    user_name: "external",
    user_role: "public",
    action: "bank_update.otp_requested",
    resource: "bank_update_otps",
    resource_id: match.workEmail,
    details: { found: true, throttled: !code },
    ip_address: ip,
  });

  return NextResponse.json(GENERIC);
}
