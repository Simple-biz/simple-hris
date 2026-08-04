import { NextRequest, NextResponse } from "next/server";
import { listOffboardedPayrollCandidates } from "@/lib/payroll/offboarded-payroll-candidates";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — recently offboarded people who may still need their final paycheck's
 * rate/bank set, scoped to the pay week in view (they age off once their
 * final pay has gone out — see `offboardedRelevantToWeek`).
 *
 * Optional `?source_file=` scopes to the exact Hubstaff upload the Payroll
 * Wizard is currently on, mirroring `/api/payroll-wizard/readiness`. Omitted
 * → the live (`is_current`) upload.
 *
 * Same gate as Readiness: a read-only view, anyone who can see the Payroll
 * Wizard can see this list; the write paths behind Set rate / Set bank
 * enforce their own edit grants.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess("accounting", "payroll_wizard", "view");
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = req.nextUrl.searchParams.get("source_file");

  try {
    const result = await listOffboardedPayrollCandidates(sourceFile);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not load recently offboarded people" },
      { status: 500 },
    );
  }
}
