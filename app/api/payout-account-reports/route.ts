import { NextRequest, NextResponse } from "next/server";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireRateVisibilityOrFeatureEdit } from "@/lib/auth/authorize-feature";
import { loadPayoutRowAndRail, readAccountReportsView } from "@/lib/supabase/payout-account-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Accounting's read of one person's account reports
 * (docs/features/payout-account-reports.md): what Mark Paid and People → Banking
 * show before a payment goes out. Same gate as the other Payment Dispatch reads
 * (`/api/payment-dispatches/cycle-closeout`): rate-visible roles, or anyone who
 * edits Payment Dispatch. Returns masked hints and statuses, never a number.
 *
 *   GET ?email=<work or personal email>  → { accountReports }
 */
export async function GET(req: NextRequest) {
  const authz = await requireRateVisibilityOrFeatureEdit("accounting", "payment_dispatch");
  if (!authz.ok) return deniedResponse(authz);

  const email = req.nextUrl.searchParams.get("email")?.trim() ?? "";
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });

  const { row, rail, error } = await loadPayoutRowAndRail(email);
  if (error) return NextResponse.json({ accountReports: { status: "unavailable" } });
  const accountReports = await readAccountReportsView({
    emails: [email, row?.work_email as string | null | undefined, row?.personal_email as string | null | undefined],
    row,
    rail,
  });
  return NextResponse.json({ accountReports });
}
