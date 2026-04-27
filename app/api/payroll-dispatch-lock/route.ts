import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
  getPayrollDispatchLock,
  setPayrollDispatchLock,
} from "@/lib/supabase/payroll-dispatch-lock";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const state = await getPayrollDispatchLock();
  return NextResponse.json(state);
}

export async function POST(req: NextRequest) {
  let body: { locked?: boolean };
  try {
    body = (await req.json()) as { locked?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.locked !== "boolean") {
    return NextResponse.json({ error: "Body must include `locked: boolean`" }, { status: 400 });
  }

  let actor: string | null = null;
  try {
    const session = await getServerSession();
    actor = session?.user?.email ?? null;
  } catch {
    /* ignore */
  }

  const { state, error } = await setPayrollDispatchLock(body.locked, actor);
  if (error) {
    return NextResponse.json({ ...state, error }, { status: 500 });
  }

  void insertAuditLog({
    user_name: actor ?? "unknown",
    user_role: "payroll_clerk",
    action: body.locked ? "payroll.dispatch.locked" : "payroll.dispatch.unlocked",
    resource: "app_settings",
    resource_id: "payroll.dispatch_locked",
    details: {
      locked: body.locked,
      // Snapshot full state at the moment of toggle so the audit log is
      // self-contained — readers don't need to join app_settings rows by time.
      started_by: state.lockedBy,
      started_at: state.lockedAt,
    },
  });

  return NextResponse.json(state);
}
