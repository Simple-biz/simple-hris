import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { normEmail } from "@/lib/email/norm-email";
import { deniedResponse, requireRateVisibilitySession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Rate-history read for an arbitrary employee. This used to run with NO auth
 * beyond a valid session (an IDOR: `?email=` was trusted raw, so any signed-in
 * user could read anyone's compensation timeline). Pay rates are Accounting/CEO
 * only, so it is now gated to full rate visibility. Managers no longer see rates
 * anywhere, so they use the rate-free attendance surfaces instead; employees
 * read their own history via the self-or-elevated `/api/employee-rate-history`.
 */
export async function GET(req: NextRequest) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

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
