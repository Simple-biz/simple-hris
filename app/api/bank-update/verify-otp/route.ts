import { NextResponse } from "next/server";
import { verifyOtp } from "@/lib/bank-update/otp";
import { getPayoutPrefill } from "@/lib/bank-update/prefill";
import { verifyFailureResponse } from "@/lib/bank-update/verify-failure";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { normEmail } from "@/lib/email/norm-email";
import { readPayoutTrackRecord } from "@/lib/supabase/payout-track-record";
import { loadPayoutRowAndRail, readAccountReportsView } from "@/lib/supabase/payout-account-reports";
import type { PayoutTrackRecord } from "@/lib/banking/payout-change-safety";
import type { AccountReportsView } from "@/lib/banking/payout-account-reports";

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

  // The payout row Payment Dispatch pays from (`employee_ids`, never the
  // onboarding prefill fallback) and the rail it pays on (all three tiers), read
  // ONCE for two things shown above the form: how many times the account on file
  // has been paid (Kane, 2026-10-07), and any account the employee has reported
  // closed / deactivated / frozen (2026-10-08). Counts, dates and masked hints
  // only. An unreadable record is "unavailable" for both, never "never paid" and
  // never "nothing reported".
  const payoutRecord = await loadPayoutRowAndRail(result.workEmail);
  const recordEmails = [result.workEmail, result.personalEmail];
  const [payoutTrack, accountReports]: [PayoutTrackRecord, AccountReportsView] = payoutRecord.error
    ? [{ status: "unavailable" }, { status: "unavailable" }]
    : await Promise.all([
        readPayoutTrackRecord({ emails: recordEmails, row: payoutRecord.row, rail: payoutRecord.rail }),
        readAccountReportsView({ emails: recordEmails, row: payoutRecord.row, rail: payoutRecord.rail }),
      ]);

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
    account_reports: accountReports,
  });
}
