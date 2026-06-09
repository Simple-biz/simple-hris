import {
  getEmployeeHourlyRateRowByEmail,
  getEmployeeHourlyRatesRows,
} from "@/lib/supabase/employee-hourly-rates";
import { authorizeEmailAccess, deniedResponse } from "@/lib/auth/authorize-email";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const email = req.nextUrl.searchParams.get("email")?.trim();
    if (email) {
      // Self-or-elevated: a non-elevated caller may only read their own rate row;
      // the requested ?email= is resolved against the session, never trusted raw.
      const authz = await authorizeEmailAccess(email);
      if (!authz.ok) return deniedResponse(authz);
      const { row, error } = await getEmployeeHourlyRateRowByEmail(authz.effectiveEmail);
      return NextResponse.json({ rows: row ? [row] : [], error });
    }
    const { rows, error } = await getEmployeeHourlyRatesRows();
    return NextResponse.json({ rows, error });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg });
  }
}
