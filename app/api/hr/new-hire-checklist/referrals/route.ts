import { NextResponse } from "next/server";
import { listHrNewHireChecklistReferrals } from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/hr/new-hire-checklist/referrals[?period=YYYY-MM-DD]
 *   → { referrals: [{ hire, referredBy }], total }
 *
 * One row per referral hire (source is a referral) — the new hire's name paired
 * with who referred them (`referred_by`). Across every week by default, or one
 * Sun-anchored week when `period` is given. Powers the HR Overview "Referrals"
 * table (New Hire that was Referred · Referred By).
 */
export async function GET(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const periodParam = new URL(request.url).searchParams.get("period");
  const period = periodParam && PERIOD_RE.test(periodParam) ? periodParam : undefined;
  const { referrals, total, error } = await listHrNewHireChecklistReferrals(period);
  if (error) return NextResponse.json({ referrals: [], total: 0, error }, { status: 500 });
  return NextResponse.json({ referrals, total });
}
