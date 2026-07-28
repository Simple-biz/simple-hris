import { NextRequest, NextResponse } from "next/server";
import {
  getDisbursementReportDetail,
  loadDisbursementRecordsForCycle,
} from "@/lib/payroll/disbursement-reports";
import { getEmployeeHourlyRatesRows } from "@/lib/supabase/employee-hourly-rates";
import { getEmployeeIds } from "@/lib/supabase/employee-ids";
import {
  buildDispatchExportRows,
  buildDispatchExportRowsFromDispatches,
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
  const [records, { rows: rates, error: ratesErr }, { rows: ids, error: idsErr }] =
    await Promise.all([
      loadDisbursementRecordsForCycle(report.sourceFile),
      getEmployeeHourlyRatesRows(),
      getEmployeeIds(),
    ]);
  const ratesRows = ratesErr ? [] : rates;
  const idsRows = idsErr ? [] : ids;

  // Urgent (MESA) weekly reports have no disbursement_records — each row is a
  // payment_dispatch. Fall back to a dispatches-only export in that case.
  //
  // Contractor settlements are appended as their OWN rows. They deliberately create
  // no disbursement_records row (that is what the payee_type guard in
  // sync_disbursement_from_dispatch enforces), so buildDispatchExportRows — which
  // emits one line per disbursement record — has nothing to attach them to and would
  // drop them entirely, leaving the export unable to tie to the bank statement.
  const contractorDispatches = report.dispatches.filter((d) => d.payee_type === 'contractor');
  const exportRows =
    records.length === 0 && report.dispatches.length > 0
      ? buildDispatchExportRowsFromDispatches(report.dispatches, ratesRows)
      : [
          ...buildDispatchExportRows(records, report.dispatches, ratesRows, idsRows),
          ...buildDispatchExportRowsFromDispatches(contractorDispatches, ratesRows),
        ];
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
