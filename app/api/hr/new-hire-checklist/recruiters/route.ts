import { NextResponse } from "next/server";
import { listHrNewHireChecklistRecruiterCounts } from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/hr/new-hire-checklist/recruiters[?period=YYYY-MM-DD]
 *   → { recruiters: [{ recruiter, hires, interviewed }], totalHires, totalInterviewed }
 *
 * Hires grouped by their `hired_by` value — a recruiter scorecard (who hired
 * how many, and how many of those they interviewed) — across every week by
 * default or scoped to one Sun-anchored week when `period` is given. Powers
 * the HR Overview "Hiring by recruiter" card.
 */
export async function GET(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const periodParam = new URL(request.url).searchParams.get("period");
  const period = periodParam && PERIOD_RE.test(periodParam) ? periodParam : undefined;
  const { recruiters, totalHires, totalInterviewed, error } =
    await listHrNewHireChecklistRecruiterCounts(period);
  if (error)
    return NextResponse.json(
      { recruiters: [], totalHires: 0, totalInterviewed: 0, error },
      { status: 500 },
    );
  return NextResponse.json({ recruiters, totalHires, totalInterviewed });
}
