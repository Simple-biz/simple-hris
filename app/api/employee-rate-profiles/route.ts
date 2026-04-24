import { getEmployeeRateProfiles } from "@/lib/supabase/employee-rate-profiles";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { profiles, error, mergeNotes } = await getEmployeeRateProfiles();
    const url = new URL(req.url);
    const emailQuery = url.searchParams.get("email")?.trim() ?? "";
    const idQuery = url.searchParams.get("id")?.trim() ?? "";

    if (emailQuery || idQuery) {
      const emailLower = emailQuery.toLowerCase();
      const profile =
        profiles.find((p) => {
          if (idQuery && p.id === idQuery) return true;
          if (!emailLower) return false;
          return [p.workEmail, p.personalEmail, p.subtitle]
            .filter((v): v is string => Boolean(v))
            .some((v) => v.toLowerCase() === emailLower);
        }) ?? null;
      return NextResponse.json({ profile, error, mergeNotes });
    }

    return NextResponse.json({ profiles, error, mergeNotes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ profiles: [], profile: null, error: msg, mergeNotes: [] });
  }
}
