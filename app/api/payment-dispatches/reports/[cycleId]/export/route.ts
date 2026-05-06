import { NextRequest, NextResponse } from "next/server";
import {
  getDisbursementReportDetail,
  loadDisbursementRecordsForCycle,
} from "@/lib/payroll/disbursement-reports";
import { getEmployeeHourlyRatesRows } from "@/lib/supabase/employee-hourly-rates";
import {
  buildDispatchExportRows,
  dispatchExportFilename,
  dispatchRowsToCsv,
} from "@/lib/payroll/dispatch-export-csv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ cycleId: string }> },
) {
  const { cycleId } = await params;
  if (!cycleId) {
    return NextResponse.json({ error: "Missing cycleId" }, { status: 400 });
  }

  const { report, error: reportErr } = await getDisbursementReportDetail(cycleId);
  if (reportErr || !report) {
    return NextResponse.json(
      { error: reportErr ?? "Report not found" },
      { status: reportErr?.includes("not found") ? 404 : 500 },
    );
  }
  if (!report.sourceFile) {
    return NextResponse.json(
      { error: "Cycle has no source file — cannot export" },
      { status: 400 },
    );
  }

  // Pull canonical per-recipient records + rates (for personal_email / processor
  // fallback). Rates are best-effort — if the lookup fails the export still
  // succeeds, just with personal_email blank.
  const [records, { rows: rates, error: ratesErr }] = await Promise.all([
    loadDisbursementRecordsForCycle(report.sourceFile),
    getEmployeeHourlyRatesRows(),
  ]);
  const ratesRows = ratesErr ? [] : rates;

  const exportRows = buildDispatchExportRows(records, report.dispatches, ratesRows);
  const csv = dispatchRowsToCsv(exportRows);
  const filename = dispatchExportFilename(
    report.cycleId,
    report.periodStart,
    report.periodEnd,
  );

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
