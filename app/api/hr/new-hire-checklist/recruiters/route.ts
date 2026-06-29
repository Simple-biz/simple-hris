import { NextResponse } from "next/server";
import { listHrNewHireChecklistRecruiterCounts } from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hr/new-hire-checklist/recruiters
 *   → { recruiters: [{ recruiter, hires, interviewed }], totalHires, totalInterviewed }
 *
 * Hires grouped by their `hired_by` value across every week — a recruiter
 * scorecard (who hired how many, and how many of those they interviewed).
 * Powers the HR Overview "Hiring by recruiter" card.
 */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { recruiters, totalHires, totalInterviewed, error } =
    await listHrNewHireChecklistRecruiterCounts();
  if (error)
    return NextResponse.json(
      { recruiters: [], totalHires: 0, totalInterviewed: 0, error },
      { status: 500 },
    );
  return NextResponse.json({ recruiters, totalHires, totalInterviewed });
}
