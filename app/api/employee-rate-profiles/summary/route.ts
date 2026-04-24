import { getEmployeeRateProfileSummaries } from "@/lib/supabase/employee-rate-profiles";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { profiles, error, mergeNotes } = await getEmployeeRateProfileSummaries();
    return NextResponse.json({ profiles, error, mergeNotes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ profiles: [], error: msg, mergeNotes: [] });
  }
}
