import { NextResponse } from "next/server";
import {
  createHrPendingEmployee,
  listHrPendingEmployees,
  type CreateHrPendingInput,
} from "@/lib/supabase/hr-pending-employees";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET — newest-first list of every staged hire. UI buckets by status. */
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { rows, error } = await listHrPendingEmployees();
  if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
  return NextResponse.json({ rows });
}

/** POST — Add Person form submission. */
export async function POST(req: Request) {
  const authz = await requireElevatedSession();
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
  return NextResponse.json({ row });
}
