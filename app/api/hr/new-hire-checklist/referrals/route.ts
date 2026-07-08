import { NextResponse } from "next/server";
import { listHrNewHireChecklistReferralCounts } from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/hr/new-hire-checklist/referrals[?period=YYYY-MM-DD]
 *   → { referrers: [{ referrer, count, hires: string[] }], total }
 *
 * Employee referrals derived from the New Hire Checklist `source` column — each
 * Source value is a referrer, with the count + names of the hires they brought
 * in. Across every week by default, or one Sun-anchored week when `period` is
 * given. Powers the HR Overview "Referrals" table.
 */
export async function GET(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const periodParam = new URL(request.url).searchParams.get("period");
  const period = periodParam && PERIOD_RE.test(periodParam) ? periodParam : undefined;
  const { referrers, total, error } = await listHrNewHireChecklistReferralCounts(period);
  if (error) return NextResponse.json({ referrers: [], total: 0, error }, { status: 500 });
  return NextResponse.json({ referrers, total });
}
