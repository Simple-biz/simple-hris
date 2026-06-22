import { getEmployeeRateProfileSummaries } from "@/lib/supabase/employee-rate-profiles";
import { getSessionRateVisibility } from "@/lib/auth/authorize-email";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/employee-rate-profiles/summary — the roster summary list.
 *
 * Used both by the Accounting Rates tab (needs the numeric rates) and by several
 * non-accounting surfaces that only need roster identity / department: the
 * employee-facing Social Wall (mentions), the manager Transfer dialog, and the
 * Orphanage roster prefetch. SECURITY: pay rates are Accounting/CEO only, so the
 * `regularRate`/`otRate` columns are projected away for any caller that does not
 * have full rate visibility. The non-accounting consumers never render them.
 */
export async function GET() {
  try {
    const { rateVisible } = await getSessionRateVisibility();
    const { profiles, error, mergeNotes } = await getEmployeeRateProfileSummaries();
    const safeProfiles = rateVisible
      ? profiles
      : profiles.map((p) => ({ ...p, regularRate: null, otRate: null }));
    return NextResponse.json({ profiles: safeProfiles, error, mergeNotes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ profiles: [], error: msg, mergeNotes: [] });
  }
}
