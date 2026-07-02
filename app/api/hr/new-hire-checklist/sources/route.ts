import { NextResponse } from "next/server";
import { listHrNewHireChecklistSourceCounts } from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/hr/new-hire-checklist/sources[?period=YYYY-MM-DD]
 *   → { sources: [{ source, count }], total }
 *
 * Hires grouped by their `sources` value, across every week by default or
 * scoped to one Sun-anchored week when `period` is given. Powers the HR
 * Overview "Hiring sources" pie + table.
 */
export async function GET(request: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const periodParam = new URL(request.url).searchParams.get("period");
  const period = periodParam && PERIOD_RE.test(periodParam) ? periodParam : undefined;
  const { sources, total, error } = await listHrNewHireChecklistSourceCounts(period);
  if (error) return NextResponse.json({ sources: [], total: 0, error }, { status: 500 });
  return NextResponse.json({ sources, total });
}
