import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { normEmail } from "@/lib/email/norm-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Manager-namespaced rate-history read. Mirrors the auth model used by
 * `/api/manager/member-monthly-pay` (no extra check beyond a valid session
 * via middleware) so a manager can fetch a team member's rate history for
 * the per-day badge on the modal calendar. The generic
 * `/api/employee-rate-history` endpoint stays self-or-elevated — this one
 * is the manager-only door.
 */
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email")?.trim();
  if (!email) {
    return NextResponse.json({ rows: [], error: "email is required" }, { status: 400 });
  }
  const target = normEmail(email) ?? email.toLowerCase();

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ rows: [] });

  const { data, error } = await supabase
    .from("employee_rate_history")
    .select("id, employee_email, regular_rate, ot_rate, effective_from")
    .eq("employee_email", target)
    .order("effective_from", { ascending: false });

  if (error) {
    return NextResponse.json({ rows: [], error: error.message }, { status: 500 });
  }
  return NextResponse.json({ rows: data ?? [] });
}
