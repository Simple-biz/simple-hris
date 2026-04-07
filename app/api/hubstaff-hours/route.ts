import { createSupabaseServerClient } from "@/lib/supabase/server";
import { mapHubstaffHoursRow } from "@/lib/supabase/hubstaff-hours";
import {
  fetchHubstaffRowsOrdered,
  replaceHubstaffHoursFromCsvText,
  rowsToPayrollRows,
} from "@/lib/supabase/hubstaff-hours-db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Service role path: full ordered fetch with OpenAPI column discovery
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

  // Anon key path: also return raw rows so PA daily-column detection works in the UI
  try {
    const supabase = createSupabaseServerClient();
    const table =
      process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours";
    const { data, error } = await supabase!.from(table).select("*");
    if (error) throw new Error(error.message);

    const rawRows = ((data ?? []) as Record<string, unknown>[]).filter((r) =>
      Object.values(r).some((v) => v != null && String(v).trim() !== ""),
    );
    const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
    const payrollRows = rawRows.map((r) => mapHubstaffHoursRow(r));
    return NextResponse.json({ columns, rows: rawRows, payrollRows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ columns: null, rows: null, payrollRows: [], error: msg });
  }
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
