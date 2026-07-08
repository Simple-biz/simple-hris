import { NextResponse } from "next/server";
import { listActiveMasterListNames } from "@/lib/supabase/global-master-list-db";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/global-master-list/names → { names: string[] }
 *
 * Distinct active-employee names from the Global Master List. Powers the New
 * Hire Checklist "Referred By" picker so referrers are always checked against a
 * real person on the master list. Elevated HR session required (admits
 * hr_coordinator), matching the checklist's other read endpoints.
 */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { names, error } = await listActiveMasterListNames();
  if (error) return NextResponse.json({ names: [], error }, { status: 500 });
  return NextResponse.json({ names });
}
