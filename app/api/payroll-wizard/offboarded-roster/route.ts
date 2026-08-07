import { NextRequest, NextResponse } from "next/server";
import { listRecentlyOffboardedPeople } from "@/lib/roster/recently-offboarded";
import { offboardedRelevantToWeek } from "@/lib/roster/offboarded-week-relevance";
import { isEligibleForFinalPayReview } from "@/lib/payroll/offboarded-final-pay-eligibility";
import { resolveCurrentWeek } from "@/lib/payroll/payroll-readiness";
import type { OffboardedRosterRow } from "@/lib/roster/offboarded-roster-row";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — the Payroll Wizard's final-pay roster overlay: recently-offboarded
 * people who may still be owed a check for the pay week in view.
 *
 * The wizard's own roster (`/api/employees` → `active_employees`) carries no
 * offboarded rows, so tier 1 of its department resolver is silent for leavers
 * and their stale department key carries forward forever. This route supplies
 * the missing tier-1 answer, scoped to the week so it is last-pay only.
 *
 * Deliberately thinner than the sibling `/api/payroll-wizard/offboarded` (which
 * powers the Payroll Notes "Offboarded" tab): that one additionally reads
 * employee_ids, the legacy rates sheet, contractor roles and per-person bank
 * snapshots, and its response shape drops `hubstaff_email` — the one field that
 * IS the payable identity here.
 *
 * Same gate as the rest of the wizard's reads: anyone who can view the Payroll
 * Wizard can read this. It grants no writes.
 *
 * NEVER 500s. An empty overlay is a normal state (no recent leavers with hours
 * this week), so a failed read returns 200 with `rows: []` and an `error` note
 * — the wizard then behaves exactly as it does today rather than reading the
 * failure as a roster outage and bailing out of department resolution entirely.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess("accounting", "payroll_wizard", "view");
  if (!authz.ok) return deniedResponse(authz);

  const sourceFile = req.nextUrl.searchParams.get("source_file");

  try {
    const { weekStart } = await resolveCurrentWeek(sourceFile);
    const { people, hoursWeekFloor, error } = await listRecentlyOffboardedPeople(90);
    if (error) {
      return NextResponse.json({ rows: [], weekStart, hoursWeekFloor: null, error });
    }

    const rows: OffboardedRosterRow[] = people
      .filter(
        (p) =>
          // A suspension is not a departure — never treat one as final pay.
          isEligibleForFinalPayReview(p.off_boarded_reason) &&
          offboardedRelevantToWeek(p, weekStart, hoursWeekFloor),
      )
      .map((p) => ({
        name: p.name,
        department: p.department,
        work_email: p.work_email,
        personal_email: p.personal_email,
        alternate_work_email: p.alternate_work_email,
        alternate_work_email_2: p.alternate_work_email_2,
        hubstaff_email: p.hubstaff_email,
        start_date: p.start_date,
        off_boarded_at: p.off_boarded_at,
        last_hours_week_start: p.last_hours_week_start,
      }));

    return NextResponse.json({ rows, weekStart, hoursWeekFloor, error: null });
  } catch (e) {
    return NextResponse.json({
      rows: [],
      weekStart: null,
      hoursWeekFloor: null,
      error: e instanceof Error ? e.message : "Could not load the final-pay roster",
    });
  }
}
