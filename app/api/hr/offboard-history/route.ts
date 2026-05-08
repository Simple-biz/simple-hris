import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/** GET /api/hr/offboard-history — returns all off-boarded rows, newest first. */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const supabase = getClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  const { data, error } = await supabase
    .from(MASTER_TABLE)
    .select(
      'id, "Name", "Work Email", "Personal Email", "Department", "Start Date", off_boarded_at, off_boarded_reason, off_boarded_by, off_boarded_note',
    )
    .not("off_boarded_at", "is", null)
    .order("off_boarded_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ rows: data ?? [] });
}
