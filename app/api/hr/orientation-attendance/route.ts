import { NextResponse } from "next/server";
import {
  listOrientationHistory,
  type HrPendingEmployeeRow,
} from "@/lib/supabase/hr-pending-employees";
import { listChecklistWeeksByEmail } from "@/lib/supabase/hr-new-hire-checklist";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — company-wide orientation attendance for HR → New Hire Checklist →
 * **Orientation**.
 *
 * The HR twin of `/api/manager/orientation-history`. Same two tables, same
 * shared model downstream (`src/lib/manager/orientation-weekly.ts`), so HR and a
 * manager can never publish a different attendance rate for the same week. What
 * differs is only the gate and the scope:
 *
 *  - **Gate.** The manager route requires `manager|admin` and scopes to
 *    `department_managers`. HR staff carry neither, so this route gates on the
 *    feature they DO carry — `requireFeatureAccess("hr", "new_hire_checklist",
 *    "view")`, the same feature key that renders the tab this read feeds
 *    (`src/lib/rbac/feature-permissions.ts`). A view grant is enough: nothing
 *    here writes, and attendance is marked on the manager surface.
 *  - **Scope.** Company-wide, unfiltered — HR owns the whole checklist, which is
 *    the point of the tab. There is therefore no per-caller projection of the
 *    checklist map to build (the manager route needs one so a Lead Gen manager
 *    doesn't receive every hire's personal email company-wide).
 *
 * **Rates are stripped unconditionally.** A staged-hire row carries
 * `regular_rate` / `ot_rate`; this surface renders no money at all, so the
 * numbers never leave the server regardless of the caller's rate visibility.
 * Nothing downstream should have to be trusted to not render them.
 *
 * **One fetch serves every week.** The response is week-independent: the client
 * caches it for the page session and re-derives on every week switch, so moving
 * the selector never costs a query. Freshness is the tab's Refresh button
 * (`src/lib/hr/tab-cache.ts`).
 *
 * **A checklist failure is surfaced, never degraded.** The week key is
 * `hr_new_hire_checklist.period_start`; falling back to the hire's own dates is
 * the 46%-wrong grouping this whole feature exists to replace
 * (docs/features/manager-orientation-attendance.md), so a checklist read error
 * comes back as a 500 with empty rows and the client refuses to render numbers.
 *
 * Both reads page with `selectAllPaged` — `hr_new_hire_checklist` is at 1,351
 * rows and `hr_pending_employees` at 976, and PostgREST truncates at 1,000 with
 * no error even when an explicit `.range()` is given.
 */
export async function GET() {
  const authz = await requireFeatureAccess("hr", "new_hire_checklist", "view");
  if (!authz.ok) return deniedResponse(authz);

  const { rows, error } = await listOrientationHistory();
  if (error) {
    return NextResponse.json(
      { rows: [], checklistWeeks: {}, error },
      { status: 500 },
    );
  }

  const { weeksByEmail, error: ckErr } = await listChecklistWeeksByEmail();
  if (ckErr) {
    return NextResponse.json(
      { rows: [], checklistWeeks: {}, error: ckErr },
      { status: 500 },
    );
  }

  const stripRates = (r: HrPendingEmployeeRow): HrPendingEmployeeRow => ({
    ...r,
    regular_rate: null,
    ot_rate: null,
  });

  const checklistWeeks: Record<string, string[]> = {};
  for (const [email, weeks] of weeksByEmail) {
    if (weeks.length > 0) checklistWeeks[email] = weeks;
  }

  return NextResponse.json({
    rows: rows.map(stripRates),
    checklistWeeks,
    error: null,
  });
}
