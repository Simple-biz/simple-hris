import { NextResponse } from "next/server";
import {
  getHrChecklistPeriod,
  listHrNewHireChecklist,
  setHrChecklistPeriodStatus,
  syncHrNewHireChecklist,
  type HrNewHireChecklistInput,
} from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET ?period=YYYY-MM-DD — that week's rows + its lock state. */
export async function GET(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const period = new URL(req.url).searchParams.get("period")?.trim() ?? "";
  if (!ISO_DATE.test(period)) {
    return NextResponse.json({ error: "A valid ?period=YYYY-MM-DD is required" }, { status: 400 });
  }

  const [{ rows, error }, { period: periodState }] = await Promise.all([
    listHrNewHireChecklist(period),
    getHrChecklistPeriod(period),
  ]);
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows, period: periodState });
}

/**
 * PUT — save / lock / reopen a single week.
 * Body: { period_start, period_end?, rows?, action: 'save' | 'lock' | 'reopen' }.
 *   save   — write the week's rows (rejected if the week is locked).
 *   lock   — write the week's rows, then freeze the week.
 *   reopen — flip the week back to 'open' for editing (rows untouched).
 */
export async function PUT(req: Request) {
  const authz = await requireFeatureEdit("hr", "new_hire_checklist");
  if (!authz.ok) return deniedResponse(authz);

  let body: {
    period_start?: string;
    period_end?: string | null;
    rows?: unknown;
    action?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const period = (body.period_start ?? "").trim();
  if (!ISO_DATE.test(period)) {
    return NextResponse.json({ error: "A valid period_start (YYYY-MM-DD) is required" }, { status: 400 });
  }
  const action = body.action === "lock" || body.action === "reopen" ? body.action : "save";

  // Reopen: just flip the lock; leave rows as they are.
  if (action === "reopen") {
    const { period: periodState, error } = await setHrChecklistPeriodStatus(period, {
      status: "open",
      periodEnd: body.period_end ?? null,
      by: authz.sessionEmail,
    });
    if (error) return NextResponse.json({ error }, { status: 500 });
    const { rows } = await listHrNewHireChecklist(period);
    return NextResponse.json({ rows, period: periodState });
  }

  // Save / Lock both write rows — refuse to write into a locked week unless this
  // request is the (idempotent) lock itself.
  const current = await getHrChecklistPeriod(period);
  if (current.period?.status === "locked" && action === "save") {
    return NextResponse.json(
      { error: "This week is locked. Reopen it before editing." },
      { status: 409 },
    );
  }

  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: "rows must be an array" }, { status: 400 });
  }

  const { rows, error } = await syncHrNewHireChecklist(
    period,
    body.rows as HrNewHireChecklistInput[],
    { createdBy: authz.sessionEmail },
  );
  if (error) return NextResponse.json({ error }, { status: 500 });

  let periodState = current.period;
  if (action === "lock") {
    const locked = await setHrChecklistPeriodStatus(period, {
      status: "locked",
      periodEnd: body.period_end ?? null,
      by: authz.sessionEmail,
    });
    if (locked.error) return NextResponse.json({ error: locked.error }, { status: 500 });
    periodState = locked.period;
  } else if (body.period_end && !current.period?.period_end) {
    // First save of a brand-new week — record its end date (best-effort).
    const saved = await setHrChecklistPeriodStatus(period, {
      status: current.period?.status ?? "open",
      periodEnd: body.period_end,
      by: authz.sessionEmail,
    });
    if (!saved.error) periodState = saved.period;
  }

  return NextResponse.json({ rows, period: periodState });
}
