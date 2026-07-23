import { NextRequest, NextResponse } from "next/server";
import { getPayrollReadiness } from "@/lib/payroll/payroll-readiness";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — the Payroll Readiness snapshot for the payroll week in view: per-dept
 * KPI submission status, that week's workers with no rate, active employees
 * with no bank info, and onboarding-pipeline exceptions.
 *
 * Optional `?source_file=` scopes the snapshot to the exact Hubstaff upload the
 * Payroll Wizard is currently on (including a replayed past week), so readiness
 * always describes the same week the accountant sees. Omitted → the live
 * (`is_current`) upload.
 *
 * Same gate as the notes board: anyone who can SEE the Payroll Wizard can read
 * it (it's a read-only dashboard). The heavy identity/rate-redaction hazards
 * stay inside `getPayrollReadiness`.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess("accounting", "payroll_wizard", "view");
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = req.nextUrl.searchParams.get("source_file");

  try {
    const readiness = await getPayrollReadiness(sourceFile);
    return NextResponse.json({ readiness });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not compute payroll readiness" },
      { status: 500 },
    );
  }
}
