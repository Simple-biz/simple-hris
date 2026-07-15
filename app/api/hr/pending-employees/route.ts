import { NextResponse } from "next/server";
import {
  createHrPendingEmployee,
  listHrPendingEmployees,
  redactPendingRowRates,
  type CreateHrPendingInput,
} from "@/lib/supabase/hr-pending-employees";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";
import { hasRateVisibility } from "@/lib/auth/elevated-roles";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET — newest-first list of every staged hire. UI buckets by status. */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { rows, error } = await listHrPendingEmployees();
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  // SECURITY: a staged-hire row carries the catalog-resolved regular_rate/ot_rate.
  // The HR onboarding UI (the only consumer) never renders them, and the gate
  // here admits hr_coordinator — so strip the numeric figures for any caller
  // without full rate visibility. Pay rates are Accounting/CEO only.
  const rateVisible = hasRateVisibility(authz.roles);
  const safeRows = rateVisible
    ? rows
    : (rows ?? []).map((r) => ({ ...r, regular_rate: null, ot_rate: null }));
  return NextResponse.json({ rows: safeRows });
}

/** POST — Add Person form submission. */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit('hr', 'onboarding');
  if (!authz.ok) return deniedResponse(authz);

  let body: Partial<CreateHrPendingInput>;
  try {
    body = (await req.json()) as Partial<CreateHrPendingInput>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = body.name?.trim();
  const personal_email = body.personal_email?.trim();
  const department = body.department?.trim();
  if (!name || !personal_email || !department) {
    return NextResponse.json(
      { error: "name, personal_email, and department are required" },
      { status: 400 },
    );
  }

  const { row, error } = await createHrPendingEmployee({
    name,
    personal_email,
    department,
    work_email: body.work_email,
    job_description: body.job_description,
    start_date: body.start_date,
    source: body.source,
    phone: body.phone,
    location: body.location,
    regular_rate: body.regular_rate,
    ot_rate: body.ot_rate,
    notes: body.notes,
    created_by: authz.sessionEmail,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "hr",
    action: "hr.pending.created",
    resource: "hr_pending_employees",
    resource_id: row ? String(row.id) : null,
    details: {
      name,
      department,
      personal_email,
      work_email: body.work_email?.trim() || null,
      source: body.source ?? null,
    },
  });

  // Never echo the staged hire's pay rate back to the HR client.
  return NextResponse.json({ row: redactPendingRowRates(row, hasRateVisibility(authz.roles)) });
}
