import {
  getHrChecklistPeriod,
  listAllHrNewHireChecklist,
  listHrChecklistPeriods,
  listHrNewHireChecklist,
  type HrNewHireChecklistRow,
} from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";
import {
  buildNewHireChecklistWorkbook,
  workbookToBuffer,
  type ExportWeek,
} from "@/lib/hr/new-hire-checklist-export";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET — download the New Hire Checklist as a multi-sheet .xlsx workbook.
 *   ?scope=week&period=YYYY-MM-DD  → one sheet for that week.
 *   ?scope=all (default)           → one sheet per week that has saved rows.
 * The response is an attachment so it downloads straight to disk.
 */
export async function GET(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") === "week" ? "week" : "all";

  let weeks: ExportWeek[];
  let filenameStub: string;

  if (scope === "week") {
    const period = url.searchParams.get("period")?.trim() ?? "";
    if (!ISO_DATE.test(period)) {
      return NextResponse.json({ error: "A valid ?period=YYYY-MM-DD is required" }, { status: 400 });
    }
    const [{ rows, error }, { period: periodState }] = await Promise.all([
      listHrNewHireChecklist(period),
      getHrChecklistPeriod(period),
    ]);
    if (error) return NextResponse.json({ error }, { status: 500 });
    weeks = [{ periodStart: period, periodEnd: periodState?.period_end ?? null, status: periodState?.status, rows }];
    filenameStub = `new-hire-checklist-${period}`;
  } else {
    const [{ rows, error }, { periods, error: periodsError }] = await Promise.all([
      listAllHrNewHireChecklist(),
      listHrChecklistPeriods(),
    ]);
    if (error) return NextResponse.json({ error }, { status: 500 });
    if (periodsError) return NextResponse.json({ error: periodsError }, { status: 500 });

    // Group every row under its week, preserving the query's newest-first,
    // grid-order sort.
    const byWeek = new Map<string, HrNewHireChecklistRow[]>();
    for (const r of rows) {
      const p = r.period_start;
      if (!p) continue;
      const arr = byWeek.get(p);
      if (arr) arr.push(r);
      else byWeek.set(p, [r]);
    }
    const statusByWeek = new Map(periods.map((p) => [p.period_start, p.status]));
    // Union weeks that have rows with locked-but-empty weeks, newest-first.
    const weekStarts = [...new Set([...byWeek.keys(), ...periods.map((p) => p.period_start)])]
      .filter((p) => (byWeek.get(p)?.length ?? 0) > 0)
      .sort((a, b) => b.localeCompare(a));
    weeks = weekStarts.map((p) => ({
      periodStart: p,
      status: statusByWeek.get(p),
      rows: byWeek.get(p) ?? [],
    }));
    filenameStub = "new-hire-checklist-all-weeks";
  }

  const buffer = workbookToBuffer(buildNewHireChecklistWorkbook(weeks));
  const filename = `${filenameStub}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
