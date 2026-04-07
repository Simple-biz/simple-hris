import { getEmployeeIds } from "@/lib/supabase/employee-ids";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const { rows, error } = await getEmployeeIds();
  return NextResponse.json({ rows, error });
}
