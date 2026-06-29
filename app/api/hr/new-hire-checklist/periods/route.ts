import { NextResponse } from "next/server";
import { listHrChecklistPeriods } from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hr/new-hire-checklist/periods
 *   → { periods: [{ period_start, period_end, status, locked_at, locked_by, row_count }] }
 *
 * Weeks that already have saved rows and/or a lock row, newest-first. The grid's
 * period selector unions these with a generated rolling window of recent weeks.
 */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { periods, error } = await listHrChecklistPeriods();
  if (error) return NextResponse.json({ periods: [], error }, { status: 500 });
  return NextResponse.json({ periods });
}
