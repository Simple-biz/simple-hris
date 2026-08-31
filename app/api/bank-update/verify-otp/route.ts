import { NextResponse } from "next/server";
import { verifyOtp } from "@/lib/bank-update/otp";
import { getPayoutPrefill } from "@/lib/bank-update/prefill";
import { resolveWalletRailLock } from "@/lib/employee/wallet-rail-lock";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Mirrors request-otp: excludes LIKE/PostgREST metacharacters before any DB lookup. */
const EMAIL_OK = /^[^\s@%,"'()]+@[^\s@%,"'()]+\.[^\s@%,"'()]+$/;

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

  if (!email || !EMAIL_OK.test(email) || !/^\d{6}$/.test(code)) {
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
    // Don't distinguish "wrong code" from "no live code / unknown email" —
    // both map to one message so the response can't be used for enumeration.
    const error =
      result.reason === "locked"
        ? "Too many incorrect attempts. Request a new code."
        : "That code is invalid or expired. Request a new one.";
    return NextResponse.json({ error, reason: result.reason }, { status: 401 });
  }

  // verifyOtp already resolved the active employee — reuse it (no extra query).
  const payout = await getPayoutPrefill(result.workEmail);

  void insertAuditLog({
    user_name: "external",
    user_role: "public",
    action: "bank_update.otp_verified",
    resource: "bank_update_otps",
    resource_id: result.workEmail,
    details: { has_existing_payout: Boolean(payout) },
    ip_address: ip,
  });

  // The WIRES lock on the EFFECTIVE send-from rail, so this page can withhold
  // Kolan/HiGlobe from someone who cannot be paid into a wallet — instead of
  // collecting a wallet email nobody will deposit to and then 400ing the save.
  // Fails closed inside resolveWalletRailLock; the save re-checks regardless.
  const walletRail = await resolveWalletRailLock(result.workEmail);

  return NextResponse.json({
    ok: true,
    session_token: result.sessionToken,
    work_email: result.workEmail,
    name: result.name,
    payout: payout ?? {},
    walletRail,
  });
}
