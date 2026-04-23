import { createSupabaseServerClient } from "@/lib/supabase/server";
import { mapHubstaffHoursRow } from "@/lib/supabase/hubstaff-hours";
import {
  deleteHubstaffRowsBySourceFile,
  fetchHubstaffRowsOrdered,
  fetchHubstaffRowsBySourceFile,
  getCurrentHubstaffUploadId,
  getUploadedSourceFiles,
  listHubstaffUploads,
  replaceHubstaffHoursFromCsvText,
  rowsToPayrollRows,
  sortHubstaffColumnsForDisplay,
} from "@/lib/supabase/hubstaff-hours-db";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { NextRequest, NextResponse } from "next/server";

const SYSTEM_USER = { name: 'Fran M', role: 'Senior Admin' } as const;

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : (req.headers.get('x-real-ip') ?? null);
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Return list of uploaded source files. Shape:
  //   {
  //     files:   string[] (newest first, for legacy consumers),
  //     uploads: { id, source_file, uploaded_at, uploaded_by, row_count, is_current }[]
  //   }
  // `uploads` is the richer row set from `hubstaff_uploads`; Payroll Wizard uses
  // this to show filename + timestamp + current-upload badge. Falls back to the
  // legacy source_file scan if the archive table is empty / unavailable.
  if (searchParams.get("source_files") === "1") {
    try {
      let uploads: Awaited<ReturnType<typeof listHubstaffUploads>> = [];
      try {
        uploads = await listHubstaffUploads();
      } catch (uploadsErr) {
        console.warn("[GET /api/hubstaff-hours] listHubstaffUploads failed:", uploadsErr);
      }
      let files: string[];
      if (uploads.length > 0) {
        const seen = new Set<string>();
        files = [];
        for (const u of uploads) {
          const f = (u.source_file ?? "").trim();
          if (!f || seen.has(f)) continue;
          seen.add(f);
          files.push(f);
        }
      } else {
        files = await getUploadedSourceFiles();
      }
      return NextResponse.json({ files, uploads, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ files: [], uploads: [], error: msg });
    }
  }

  // Return rows filtered by a specific source file
  const sourceFileFilter = searchParams.get("source_file");
  if (sourceFileFilter) {
    try {
      const { columns, rows } = await fetchHubstaffRowsBySourceFile(sourceFileFilter);
      const payrollRows = rowsToPayrollRows(rows);
      return NextResponse.json({ columns, rows, payrollRows, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ columns: null, rows: null, payrollRows: [], error: msg });
    }
  }

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

  // Anon key path: also return raw rows so PA daily-column detection works in the UI.
  // Filter to the current upload so the wizard never sees stale archived data.
  try {
    const supabase = createSupabaseServerClient();
    if (!supabase) throw new Error("Supabase client unavailable");
    const table =
      process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours";

    const currentUploadId = await getCurrentHubstaffUploadId(supabase);
    let q = supabase.from(table).select("*");
    if (currentUploadId) q = q.eq("upload_id", currentUploadId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const rawRows = ((data ?? []) as Record<string, unknown>[]).filter((r) =>
      Object.values(r).some((v) => v != null && String(v).trim() !== ""),
    );
    const columns =
      rawRows.length > 0 ? sortHubstaffColumnsForDisplay(Object.keys(rawRows[0])) : [];
    const payrollRows = rawRows.map((r) => mapHubstaffHoursRow(r));
    return NextResponse.json({ columns, rows: rawRows, payrollRows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ columns: null, rows: null, payrollRows: [], error: msg });
  }
}

export async function DELETE(req: NextRequest) {
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

    const sourceFile = new URL(req.url).searchParams.get("source_file")?.trim();
    if (!sourceFile) {
      return NextResponse.json({ success: false, error: "Missing source_file query parameter." }, { status: 400 });
    }

    const { deleted } = await deleteHubstaffRowsBySourceFile(sourceFile);

    void insertAuditLog({
      user_name:   SYSTEM_USER.name,
      user_role:   SYSTEM_USER.role,
      action:      'csv.delete',
      resource:    'hubstaff_hours',
      resource_id: sourceFile,
      details:     { file: sourceFile, rows_deleted: deleted },
      ip_address:  clientIp(req),
    });

    return NextResponse.json({ success: true, deleted });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[DELETE /api/hubstaff-hours]", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
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
    const fileName = (file as File).name || form.get("fileName")?.toString() || undefined;
    // `mode` is retained in the form payload for back-compat but ignored: every upload
    // is archived and promoted to current. Latest always wins in the Payroll Wizard.
    const { rowCount, uploadId } = await replaceHubstaffHoursFromCsvText(text, fileName);

    void insertAuditLog({
      user_name:   SYSTEM_USER.name,
      user_role:   SYSTEM_USER.role,
      action:      'csv.upload',
      resource:    'hubstaff_hours',
      resource_id: fileName ?? null,
      details:     { file: fileName ?? 'unknown', rows: rowCount, upload_id: uploadId },
      ip_address:  clientIp(req),
    });

    return NextResponse.json({ success: true, rowCount, uploadId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[POST /api/hubstaff-hours]", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
