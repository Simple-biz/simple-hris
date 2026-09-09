import { parseCsv } from "@/lib/csv/parse-csv";
import { importDailyReportToPostgres } from "@/lib/supabase/import-daily-report";
import { NextRequest, NextResponse } from "next/server";
import { requireElevatedSession, deniedResponse } from "@/lib/auth/authorize-email";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { auditFrom } from "@/lib/audit/context";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Daily-report CSV ingest — creates/fills a Postgres table from an uploaded
 * file.
 *
 * It had NO authorization gate and NO audit event: any caller could push a CSV
 * into the database and leave nothing behind. No component in the app fetches
 * it (the Diagnostics "Daily Report Import" probe only READS what it produced),
 * so gating it cannot break a caller. It is a deletion-candidate — see
 * `docs/features/audit-log.md` — but an ungated ingest must not sit around
 * waiting for that decision.
 */
export async function POST(req: NextRequest) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

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

    void insertAuditLog({
      ...auditFrom(req, authz),
      action: "daily_report.imported",
      resource: tableName,
      resource_id: name,
      details: { file_name: name, table_name: tableName, row_count: rowCount, columns: header.length },
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
