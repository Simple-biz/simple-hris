import { NextResponse } from "next/server";
import { verifyOtp } from "@/lib/bank-update/otp";
import { getPayoutPrefill } from "@/lib/bank-update/prefill";
import { verifyFailureResponse } from "@/lib/bank-update/verify-failure";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { normEmail } from "@/lib/email/norm-email";
import { resolveWalletRailLock } from "@/lib/employee/wallet-rail-lock";
import { readPayoutTrackRecord } from "@/lib/supabase/payout-track-record";
import type { PayoutTrackRecord } from "@/lib/banking/payout-change-safety";

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
    // One body and one status for EVERY failure. The reason (and the old
    // "Too many incorrect attempts" wording) only ever differed for an active
    // employee's inbox, so either one told the public who works here (266 #1).
    // The reason stays on the audit row above, which the public never reads.
    const failure = verifyFailureResponse(result.reason);
    return NextResponse.json(failure.body, { status: failure.status });
  }

  // verifyOtp already resolved the active employee — reuse it (no extra query).
  const payout = await getPayoutPrefill(result.workEmail);

  // How many times the account on file has been paid (Kane, 2026-10-07): shown
  // above the form so the employee sees what a working account is worth before
  // they change it. Counts and dates only, no account value. Keyed on the rail
  // Payment Dispatch actually pays (all three tiers, the same resolver the
  // dashboard uses); an unresolvable rail or an unreadable log is "unavailable",
  // never "never paid".
  const payoutTrack: PayoutTrackRecord = await (async () => {
    if (!payout) return readPayoutTrackRecord({ emails: [result.workEmail], row: null, rail: null });
    const { effectiveRail, error } = await resolveWalletRailLock(result.workEmail);
    if (error) return { status: "unavailable" };
    return readPayoutTrackRecord({
      emails: [result.workEmail, result.personalEmail],
      row: payout,
      rail: effectiveRail,
    });
  })();

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
    name: result.name,
    payout: payout ?? {},
    payout_track: payoutTrack,
  });
}
