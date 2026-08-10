import { NextResponse } from "next/server";
import { listDisbursementReports } from "@/lib/payroll/disbursement-reports";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireRateVisibilityOrFeatureEdit } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Cycle payout data (amounts, and in the CSV exports full bank account
  // numbers + SWIFT). Same gate the write siblings on this tree use, so a
  // signed-in employee with no payroll role can no longer pull it.
  const authz = await requireRateVisibilityOrFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);
  try {
    const { reports, error, unseeded, unseededCount } = await listDisbursementReports();
    return NextResponse.json({ reports, error, unseeded, unseededCount });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ reports: [], error: msg, unseeded: [], unseededCount: 0 }, { status: 500 });
  }
}
