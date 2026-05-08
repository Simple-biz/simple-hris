import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/**
 * POST /api/hr/reonboard
 * Body: { work_email: string }
 *
 * Reverses an off-board by nulling the four off_boarded_* fields on every
 * master-list row with that work_email. The person re-appears in
 * active_employees (and every downstream dashboard) immediately.
 */
export async function POST(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: { work_email?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const work_email = body.work_email?.trim().toLowerCase();
  if (!work_email) {
    return NextResponse.json({ error: "work_email is required" }, { status: 400 });
  }

  const supabase = getClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  const { data, error } = await supabase
    .from(MASTER_TABLE)
    .update({
      off_boarded_at: null,
      off_boarded_reason: null,
      off_boarded_by: null,
      off_boarded_note: null,
    })
    .ilike('"Work Email"', work_email)
    .not("off_boarded_at", "is", null)
    .select('id, "Name", "Work Email"');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = data ?? [];
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No off-boarded rows found for that email." },
      { status: 404 },
    );
  }

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: "hr",
    action: "hr.employee.reonboarded",
    resource: MASTER_TABLE,
    resource_id: work_email,
    details: { target_email: work_email, rows_updated: rows.length },
  });

  return NextResponse.json({ success: true, rows_updated: rows.length });
}
