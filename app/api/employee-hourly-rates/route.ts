import { getEmployeeHourlyRatesRows } from "@/lib/supabase/employee-hourly-rates";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { rows, error } = await getEmployeeHourlyRatesRows();
    return NextResponse.json({ rows, error });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg });
  }
}
