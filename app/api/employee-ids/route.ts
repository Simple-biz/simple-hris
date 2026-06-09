import { getEmployeeIds, getEmployeeIdRowByEmail } from "@/lib/supabase/employee-ids";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email")?.trim();
  if (email) {
    // employee_ids rows carry payment/bank details, so a per-email lookup is
    // self-or-elevated: a non-elevated caller may only read their own row and
    // the requested ?email= is resolved against the session, never trusted raw.
    const authz = await authorizeEmailAccess(email);
    if (!authz.ok) return deniedResponse(authz);
    const { row, error } = await getEmployeeIdRowByEmail(authz.effectiveEmail);
    return NextResponse.json({ rows: row ? [row] : [], error });
  }
  const { rows, error } = await getEmployeeIds();
  return NextResponse.json({ rows, error });
}
