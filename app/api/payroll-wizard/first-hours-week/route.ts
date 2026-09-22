import { NextResponse } from "next/server";
import { loadFirstHoursIndex } from "@/lib/payroll/first-hours-index";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { requireFeatureAccess } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — the Payroll Wizard's "first paycheck" index: for every email that has
 * ever had Hubstaff hours, the EARLIEST upload week that carries it.
 *
 * Step 2 (Initial Calculation) uses it to LABEL a calc row whose first-ever
 * hours are in the week in view — so a hire who worked a few hours and was
 * off-boarded inside their first week is visible on the payroll table itself,
 * instead of missing from every active-roster new-hire list (Carla, 2026-09-22).
 *
 * Display-only: it never adds a payee, never touches the payload, the
 * final_pay snapshot or dispatch. Same gate as every other wizard read.
 *
 * NEVER 500s. A failed read returns 200 with an EMPTY `byEmail` and `error`
 * set; the wizard then labels nobody and says the labels are unavailable —
 * never "no first paychecks this week".
 */
export async function GET() {
  const authz = await requireFeatureAccess("accounting", "payroll_wizard", "view");
  if (!authz.ok) return deniedResponse(authz);
  const payload = await loadFirstHoursIndex();
  return NextResponse.json(payload);
}
