import { NextRequest, NextResponse } from "next/server";
import { getDisbursementReportDetail } from "@/lib/payroll/disbursement-reports";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireRateVisibilityOrFeatureEdit } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ cycleId: string }> },
) {
  // Cycle payout data (amounts, and in the CSV exports full bank account
  // numbers + SWIFT). Same gate the write siblings on this tree use, so a
  // signed-in employee with no payroll role can no longer pull it.
  const authz = await requireRateVisibilityOrFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);
  const { cycleId } = await params;
  if (!cycleId) {
    return NextResponse.json({ report: null, error: "Missing cycleId" }, { status: 400 });
  }
  try {
    const { report, error } = await getDisbursementReportDetail(cycleId);
    if (error || !report) {
      return NextResponse.json(
        { report: null, error: error ?? "Report not found" },
        { status: error?.includes("not found") ? 404 : 500 },
      );
    }
    return NextResponse.json({ report, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ report: null, error: msg }, { status: 500 });
  }
}
