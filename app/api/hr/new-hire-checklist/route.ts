import { NextResponse } from "next/server";
import {
  listHrNewHireChecklist,
  syncHrNewHireChecklist,
  type HrNewHireChecklistInput,
} from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET — the full checklist grid, in row order. */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { rows, error } = await listHrNewHireChecklist();
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows });
}

/** PUT — full grid save (Save button). Body: { rows: HrNewHireChecklistInput[] }
 *  where `rows` is the complete desired grid in order. The server upserts and
 *  deletes to match (see syncHrNewHireChecklist). */
export async function PUT(req: Request) {
  const authz = await requireFeatureEdit("hr", "new_hire_checklist");
  if (!authz.ok) return deniedResponse(authz);

  let body: { rows?: unknown };
  try {
    body = (await req.json()) as { rows?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: "rows must be an array" }, { status: 400 });
  }

  const { rows, error } = await syncHrNewHireChecklist(
    body.rows as HrNewHireChecklistInput[],
    { createdBy: authz.sessionEmail },
  );
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ rows });
}
