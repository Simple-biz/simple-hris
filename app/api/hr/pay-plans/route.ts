import { NextResponse } from "next/server";
import {
  listOnboardingPayPlans,
  upsertOnboardingPayPlan,
  getPayPlanSignedUrl,
  type OnboardingPayPlanRow,
} from "@/lib/supabase/onboarding-pay-plans";
import { resolveOnboardingCountry } from "@/lib/onboarding/countries";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess, requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const PREVIEW_TTL = 600; // 10 min — HR preview/download window

type PayPlanApi = OnboardingPayPlanRow & { download_url: string | null };

/**
 * GET /api/hr/pay-plans
 * Lists every uploaded onboarding pay plan with a short-lived signed download
 * URL for preview. Auth: HR onboarding view (admin bypasses).
 */
export async function GET() {
  const authz = await requireFeatureAccess("hr", "onboarding", "view");
  if (!authz.ok) return deniedResponse(authz);

  const { rows, error } = await listOnboardingPayPlans();
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });

  const withUrls: PayPlanApi[] = await Promise.all(
    rows.map(async (r) => {
      const { url } = await getPayPlanSignedUrl(r.file_path, PREVIEW_TTL);
      return { ...r, download_url: url };
    }),
  );
  return NextResponse.json({ rows: withUrls, error: null });
}

/**
 * POST /api/hr/pay-plans  (multipart/form-data)
 * Fields: file (PDF), department, country. Uploads (or replaces) the pay plan
 * for the (department, country) pair. Auth: HR onboarding edit (admin bypasses).
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit("hr", "onboarding");
  if (!authz.ok) return deniedResponse(authz);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 },
    );
  }

  const department = String(form.get("department") ?? "").trim();
  const countryRaw = String(form.get("country") ?? "").trim();
  const file = form.get("file");

  if (!department) {
    return NextResponse.json({ error: "Department is required." }, { status: 400 });
  }
  if (!countryRaw || !resolveOnboardingCountry(countryRaw)) {
    return NextResponse.json(
      { error: "A valid country (United States / Philippines / Colombia) is required." },
      { status: 400 },
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No PDF file provided." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "The uploaded file is empty." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 10 MB)." }, { status: 400 });
  }
  // Accept PDFs by content type or extension (some browsers send empty type).
  const isPdf =
    file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    return NextResponse.json({ error: "Only PDF files are accepted." }, { status: 400 });
  }

  const buffer = await file.arrayBuffer();
  const { row, error } = await upsertOnboardingPayPlan({
    department,
    country: countryRaw,
    fileBytes: buffer,
    contentType: file.type || "application/pdf",
    fileName: file.name || "pay-plan.pdf",
    fileSize: file.size,
    uploadedBy: authz.sessionEmail,
  });
  if (error || !row) {
    return NextResponse.json({ error: error ?? "Failed to save pay plan." }, { status: 500 });
  }

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "hr",
    action: "hr.pay_plan.uploaded",
    resource: "onboarding_pay_plans",
    resource_id: row.id != null ? String(row.id) : null,
    details: {
      department,
      country: countryRaw,
      file_name: file.name || null,
      file_size: file.size,
    },
  });

  return NextResponse.json({ row });
}
