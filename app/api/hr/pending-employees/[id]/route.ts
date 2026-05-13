import { NextResponse } from "next/server";
import {
  cancelHrPendingEmployee,
  deleteHrPendingEmployee,
  updateHrPendingEmployee,
  type UpdateHrPendingInput,
} from "@/lib/supabase/hr-pending-employees";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** PATCH — partial update to a staged hire (e.g. setting work_email later). */
export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  let body: UpdateHrPendingInput;
  try {
    body = (await req.json()) as UpdateHrPendingInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { row, error } = await updateHrPendingEmployee(id, body);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ row });
}

/** DELETE — soft cancel by default; ?hard=true permanently removes the row. */
export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { id: rawId } = await context.params;
  const id = parseId(rawId);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const hard = new URL(req.url).searchParams.get('hard') === 'true';
  const { error } = hard
    ? await deleteHrPendingEmployee(id)
    : await cancelHrPendingEmployee(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
