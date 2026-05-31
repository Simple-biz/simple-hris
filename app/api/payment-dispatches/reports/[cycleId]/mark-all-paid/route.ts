import { NextRequest, NextResponse } from "next/server";
import {
  listDisbursementReports,
  markAllDisbursementRecordsPaid,
} from "@/lib/payroll/disbursement-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ cycleId: string }> },
) {
  const { cycleId } = await params;
  if (!cycleId) {
    return NextResponse.json({ error: "Missing cycleId" }, { status: 400 });
  }

  // Resolve sourceFile from cycleId.
  const { reports, error: listError } = await listDisbursementReports();
  if (listError) {
    return NextResponse.json({ error: listError }, { status: 500 });
  }
  const summary = reports.find((r) => r.cycleId === cycleId);
  if (!summary?.sourceFile) {
    return NextResponse.json({ error: "Cycle not found" }, { status: 404 });
  }

  const { updated, error } = await markAllDisbursementRecordsPaid(summary.sourceFile);
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }
  return NextResponse.json({ updated, error: null });
}
