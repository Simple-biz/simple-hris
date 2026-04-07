import { parseCsv } from "@/lib/csv/parse-csv";
import { importDailyReportToPostgres } from "@/lib/supabase/import-daily-report";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ success: false, error: "Missing file" }, { status: 400 });
    }

    const blob = file as Blob;
    const name =
      typeof (file as File).name === "string" && (file as File).name
        ? (file as File).name
        : "import.csv";

    const text = await blob.text();
    const grid = parseCsv(text);

    if (grid.length < 2) {
      return NextResponse.json(
        { success: false, error: "CSV must include a header row and at least one data row." },
        { status: 400 },
      );
    }

    const header = grid[0].map((h) => h.trim());
    const dataRows = grid.slice(1).map((row) => {
      const padded = [...row];
      while (padded.length < header.length) padded.push("");
      if (padded.length > header.length) return padded.slice(0, header.length);
      return padded;
    });

    const { schema, tableName, rowCount } = await importDailyReportToPostgres({
      fileName: name,
      header,
      dataRows,
    });

    return NextResponse.json({
      success: true,
      schema,
      tableName,
      rowCount,
      fileName: name,
    });
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
    return NextResponse.json({ success: false, error: msg || "Import failed" }, { status: 500 });
  }
}
