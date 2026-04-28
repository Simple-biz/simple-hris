import { NextResponse } from "next/server";
import { listDisbursementReports } from "@/lib/payroll/disbursement-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { reports, error } = await listDisbursementReports();
    return NextResponse.json({ reports, error });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ reports: [], error: msg }, { status: 500 });
  }
}
