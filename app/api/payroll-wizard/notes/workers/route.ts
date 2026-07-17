import { NextResponse } from "next/server";
import { listPayrollWorkerOptions } from "@/lib/supabase/payroll-wizard-notes";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/payroll-wizard/notes/workers → { workers: PayrollWorkerOption[] }
 *
 * Suggestions for the Notes board's Worker cell: the people in the CURRENT
 * Hubstaff timesheet upload — the same list (name + email) the Payroll
 * Wizard's Initial Calculation ("CSV") step shows, keyed on the same Hubstaff
 * email the wizard's Adj. overrides use so a picked worker bridges cleanly.
 * Same view gate as reading the board itself.
 */
export async function GET() {
  const authz = await requireFeatureAccess("accounting", "payroll_wizard", "view");
  if (!authz.ok) return deniedResponse(authz);

  const { workers, error } = await listPayrollWorkerOptions();
  if (error) return NextResponse.json({ workers: [], error }, { status: 500 });
  return NextResponse.json({ workers });
}
