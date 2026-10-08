import { NextRequest, NextResponse } from "next/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireRateVisibilityOrFeatureEdit } from "@/lib/auth/authorize-feature";
import { loadPayoutRowAndRail, readAccountReportsView } from "@/lib/supabase/payout-account-reports";
import { readPayoutTrackRecord } from "@/lib/supabase/payout-track-record";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Accounting's read of one person's account status
 * (docs/features/payout-account-reports.md): the accounts the employee reported
 * closed / deactivated / frozen, and (2026-10-08, people-bank-card.md §10) how many
 * times the account payroll pays has been paid. What Mark Paid and People → Banking
 * show before a payment goes out. Same gate as the other Payment Dispatch reads
 * (`/api/payment-dispatches/cycle-closeout`): rate-visible roles, or anyone who
 * edits Payment Dispatch. Returns masked hints, statuses, counts and dates, never a
 * number, and writes no audit row: it reveals nothing (people-bank-search.md §4.1).
 *
 *   GET ?email=<work or personal email>  → { accountReports, payoutTrack }
 */
export async function GET(req: NextRequest) {
  const authz = await requireRateVisibilityOrFeatureEdit("accounting", "payment_dispatch");
  if (!authz.ok) return deniedResponse(authz);

  const email = req.nextUrl.searchParams.get("email")?.trim() ?? "";
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });

  const { row, rail, error } = await loadPayoutRowAndRail(email);
  if (error) {
    return NextResponse.json({ accountReports: { status: "unavailable" }, payoutTrack: { status: "unavailable" } });
  }
  const emails = [email, row?.work_email as string | null | undefined, row?.personal_email as string | null | undefined];
  const [accountReports, payoutTrack] = await Promise.all([
    readAccountReportsView({ emails, row, rail }),
    readPayoutTrackRecord({ emails, row, rail }),
  ]);
  return NextResponse.json({ accountReports, payoutTrack });
}
