import { NextRequest, NextResponse } from "next/server";
import {
  listRatesUploads,
  replaceEmployeeHourlyRatesFromCsv,
} from "@/lib/supabase/rates-upload-db";
import { insertAuditLog } from "@/lib/supabase/audit-log";

const SYSTEM_USER = { name: "Fran M", role: "Senior Admin" } as const;

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : (req.headers.get("x-real-ip") ?? null);
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `GET ?uploads=1` returns archived `rates_uploads` rows (newest first) so the
 * admin CSV-imports Files tab can list past rates batches.
 */
export async function GET(req: NextRequest) {
  if (new URL(req.url).searchParams.get("uploads") !== "1") {
    return NextResponse.json(
      { error: "Unsupported. Use POST to upload, or GET ?uploads=1 to list batches." },
      { status: 400 },
    );
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return NextResponse.json(
      { uploads: [], error: "SUPABASE_SERVICE_ROLE_KEY is not set — required for rates archive lookup." },
      { status: 400 },
    );
  }
  try {
    const uploads = await listRatesUploads();
    return NextResponse.json({ uploads, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ uploads: [], error: msg }, { status: 500 });
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
    const fileName =
      (file as File).name || form.get("fileName")?.toString() || "unknown.csv";

    const result = await replaceEmployeeHourlyRatesFromCsv(text, fileName);

    void insertAuditLog({
      user_name: SYSTEM_USER.name,
      user_role: SYSTEM_USER.role,
      action: "csv.rates.upload",
      resource: "employee_hourly_rates",
      resource_id: fileName,
      details: {
        file: fileName,
        rows: result.rowCount,
        inserted: result.inserted,
        updated: result.updated,
        unique_employees: result.uniqueEmployees,
        skipped_no_work_email: result.skippedNoWorkEmail,
        skipped_no_rate: result.skippedNoRate,
        upload_id: result.uploadId,
      },
      ip_address: clientIp(req),
    });

    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[POST /api/employee-hourly-rates-upload]", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
