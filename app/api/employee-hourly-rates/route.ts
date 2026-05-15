import {
  getEmployeeHourlyRateRowByEmail,
  getEmployeeHourlyRatesRows,
} from "@/lib/supabase/employee-hourly-rates";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const email = req.nextUrl.searchParams.get("email")?.trim();
    if (email) {
      const { row, error } = await getEmployeeHourlyRateRowByEmail(email);
      return NextResponse.json({ rows: row ? [row] : [], error });
    }
    const { rows, error } = await getEmployeeHourlyRatesRows();
    return NextResponse.json({ rows, error });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg });
  }
}
