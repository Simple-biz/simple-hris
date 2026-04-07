import { getHubstaffHoursPayrollRows } from "@/lib/supabase/hubstaff-hours";
import {
  fetchHubstaffRowsOrdered,
  replaceHubstaffHoursFromCsvText,
  rowsToPayrollRows,
} from "@/lib/supabase/hubstaff-hours-db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    try {
      const { columns, rows } = await fetchHubstaffRowsOrdered();
      const payrollRows = rowsToPayrollRows(rows);
      return NextResponse.json({ columns, rows, payrollRows, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ columns: null, rows: null, payrollRows: [], error: msg });
    }
  }

  const { rows: payrollRows, error } = await getHubstaffHoursPayrollRows();
  return NextResponse.json({ columns: null, rows: null, payrollRows, error });
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      return NextResponse.json(
        {
          success: false,
          error:
            "SUPABASE_SERVICE_ROLE_KEY is required. Add it to .env — Supabase → Project Settings → API → service_role (secret) key.",
        },
        { status: 400 },
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ success: false, error: "Missing file" }, { status: 400 });
    }

    const text = await (file as Blob).text();
    const { rowCount } = await replaceHubstaffHoursFromCsvText(text);
    return NextResponse.json({ success: true, rowCount });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[POST /api/hubstaff-hours]", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
