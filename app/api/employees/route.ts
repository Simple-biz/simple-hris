import { getEmployees } from "@/lib/supabase/employees";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const { employees, error } = await getEmployees();
  return NextResponse.json({ employees, error });
}
