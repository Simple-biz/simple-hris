import { NextResponse } from "next/server";
import { verifyOtp, findActiveEmployeeByEmail } from "@/lib/bank-update/otp";
import { getPayoutPrefill } from "@/lib/bank-update/prefill";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip");
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; code?: string };
  const email = normEmail(body.email) ?? "";
  const code = String(body.code ?? "").trim();
  const ip = clientIp(req);

  if (!email || !/^\d{6}$/.test(code)) {
    return NextResponse.json(
      { error: "Enter the 6-digit code from your email." },
      { status: 400 },
    );
  }

  const result = await verifyOtp(email, code);
  if (!result.ok) {
    void insertAuditLog({
      user_name: "external",
      user_role: "public",
      action: "bank_update.otp_verify_failed",
      resource: "bank_update_otps",
      resource_id: email,
      details: { reason: result.reason },
      ip_address: ip,
    });
    const error =
      result.reason === "locked"
        ? "Too many incorrect attempts. Request a new code."
        : result.reason === "expired"
          ? "That code has expired. Request a new one."
          : "That code is incorrect. Check your email and try again.";
    return NextResponse.json({ error, reason: result.reason }, { status: 401 });
  }

  // Pull the personal email for the onboarding-submission prefill fallback.
  const match = await findActiveEmployeeByEmail(result.workEmail);
  const payout = await getPayoutPrefill(result.workEmail, match?.personalEmail ?? null);

  void insertAuditLog({
    user_name: "external",
    user_role: "public",
    action: "bank_update.otp_verified",
    resource: "bank_update_otps",
    resource_id: result.workEmail,
    details: { has_existing_payout: Boolean(payout) },
    ip_address: ip,
  });

  return NextResponse.json({
    ok: true,
    session_token: result.sessionToken,
    work_email: result.workEmail,
    name: match?.name ?? null,
    payout: payout ?? {},
  });
}
