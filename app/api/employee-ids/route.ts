import { getEmployeeIds, getEmployeeIdRowByEmail } from "@/lib/supabase/employee-ids";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email")?.trim();
  if (email) {
    const { row, error } = await getEmployeeIdRowByEmail(email);
    return NextResponse.json({ rows: row ? [row] : [], error });
  }
  const { rows, error } = await getEmployeeIds();
  return NextResponse.json({ rows, error });
}
