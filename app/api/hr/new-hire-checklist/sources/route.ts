import { NextResponse } from "next/server";
import { listHrNewHireChecklistSourceCounts } from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hr/new-hire-checklist/sources
 *   → { sources: [{ source, count }], total }
 *
 * Hires grouped by their `sources` value across every week. Powers the HR
 * Overview "Hiring sources" pie + table.
 */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { sources, total, error } = await listHrNewHireChecklistSourceCounts();
  if (error) return NextResponse.json({ sources: [], total: 0, error }, { status: 500 });
  return NextResponse.json({ sources, total });
}
