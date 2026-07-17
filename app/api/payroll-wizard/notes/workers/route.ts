import { NextResponse } from "next/server";
import { listPayrollWorkerOptions } from "@/lib/supabase/payroll-wizard-notes";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/payroll-wizard/notes/workers → { workers: PayrollWorkerOption[] }
 *
 * Suggestions for the Notes board's Worker cell: the active Global Master
 * List plus recently offboarded employees (flagged with off_boarded_at, so
 * the picker can badge them) — offboarded people leave `active_employees`,
 * but their Last Pays are exactly what clerks log on the board. Same view
 * gate as reading the board itself.
 */
export async function GET() {
  const authz = await requireFeatureAccess("accounting", "payroll_wizard", "view");
  if (!authz.ok) return deniedResponse(authz);

  const { workers, error } = await listPayrollWorkerOptions();
  if (error) return NextResponse.json({ workers: [], error }, { status: 500 });
  return NextResponse.json({ workers });
}
