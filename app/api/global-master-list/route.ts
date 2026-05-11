import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import {
  countMasterAndRatesRows,
  listMasterListUploads,
  replaceGlobalMasterListFromCsvText,
} from "@/lib/supabase/global-master-list-db";
import { NextRequest, NextResponse } from "next/server";

const SYSTEM_USER = { name: "Fran M", role: "Senior Admin" } as const;

/** CSV layout / mapping problems — 400 so DevTools shows a client error with the message, not a generic 500. */
function statusForMasterListImportError(message: string): number {
  if (
    message.includes("Global master list CSV must have at least 3 rows") ||
    message.includes("Rows 1–2 must identify this file as the MASTERLIST") ||
    message.includes("Row 3 looks like a Hubstaff timesheet header") ||
    message.includes("Row 3 must be the MASTERLIST header row") ||
    message.includes("No CSV columns match") ||
    message.includes("No non-empty data rows after mapping")
  ) {
    return 400;
  }
  return 500;
}

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : (req.headers.get("x-real-ip") ?? null);
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    const fileName = (file as File).name || form.get("fileName")?.toString() || "unknown.csv";

    const {
      rowCount,
      uploadId,
      inserted,
      updated,
      rowsMissingPersonalEmail,
      duplicatesInCsv,
      reonboarded,
      reconciledViaWorkEmail,
    } = await replaceGlobalMasterListFromCsvText(text, fileName);

    let ratesReconcile: {
      masterCount: number | null;
      ratesCount: number | null;
      ratesFewerThanMaster: boolean;
      hint: string | null;
    } | null = null;

    try {
      const { masterCount, ratesCount, masterError, ratesError } = await countMasterAndRatesRows();
      if (!masterError && !ratesError && masterCount != null && ratesCount != null) {
        const ratesFewer = ratesCount < masterCount;
        ratesReconcile = {
          masterCount,
          ratesCount,
          ratesFewerThanMaster: ratesFewer,
          hint: ratesFewer
            ? `employee_hourly_rates has ${(masterCount - ratesCount).toLocaleString()} fewer rows than the master list — add or sync rates for payroll.`
            : null,
        };
      }
    } catch {
      ratesReconcile = null;
    }

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: "csv.master.upload",
      resource: "global_master_list",
      resource_id: fileName,
      details: {
        file: fileName,
        rows: rowCount,
        inserted,
        updated,
        rows_missing_personal_email: rowsMissingPersonalEmail,
        duplicates_in_csv: duplicatesInCsv,
        reonboarded,
        reconciled_via_work_email: reconciledViaWorkEmail,
        upload_id: uploadId,
      },
      ip_address: clientIp(req),
    });

    return NextResponse.json({
      success: true,
      rowCount,
      inserted,
      updated,
      rowsMissingPersonalEmail,
      duplicatesInCsv,
      reonboarded,
      reconciledViaWorkEmail,
      uploadId,
      ratesReconcile,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[POST /api/global-master-list]", msg);
    const status = statusForMasterListImportError(msg);
    return NextResponse.json({ success: false, error: msg }, { status });
  }
}

/**
 * - With `?uploads=1`: returns archived `master_list_uploads` rows (newest first).
 *   Powers the admin CSV-imports Files tab.
 * - Without that flag: confirms service role can reach the employees table and
 *   reports master/rates row counts.
 */
export async function GET(req: NextRequest) {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 500 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return NextResponse.json(
      { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY is not set — required for CSV replace." },
      { status: 400 },
    );
  }

  if (new URL(req.url).searchParams.get("uploads") === "1") {
    try {
      const uploads = await listMasterListUploads();
      return NextResponse.json({ uploads, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ uploads: [], error: msg }, { status: 500 });
    }
  }

  try {
    const { masterCount, ratesCount, masterError, ratesError } = await countMasterAndRatesRows();
    return NextResponse.json({
      ok: !masterError && !ratesError,
      masterCount,
      ratesCount,
      masterError,
      ratesError,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
