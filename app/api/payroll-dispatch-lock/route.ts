import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
  getPayrollDispatchLock,
  setPayrollDispatchLock,
} from "@/lib/supabase/payroll-dispatch-lock";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { getSessionActor } from "@/lib/auth/session-actor";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

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
  let actorRole = 'user';
  try {
    const sessionActor = await getSessionActor();
    actor = sessionActor.user_name !== 'anonymous' ? sessionActor.user_name : null;
    actorRole = sessionActor.user_role;
  } catch {
    /* ignore */
  }

  const { state, error } = await setPayrollDispatchLock(body.locked, actor);
  if (error) {
    return NextResponse.json({ ...state, error }, { status: 500 });
  }

  void insertAuditLog({
    user_name: actor ?? "unknown",
    user_role: actorRole,
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

  // Persist a notification for all relevant roles so the payroll lock event
  // appears in the Notifications tab even after processing stops.
  void (async () => {
    try {
      const supabase = createSupabaseServiceRoleClient();
      if (!supabase) return;
      const { data: roleRows } = await supabase
        .from("employee_roles")
        .select("work_email")
        .in("role", ["admin", "hr_coordinator", "payroll_coordinator", "payroll_manager", "finance"])
        .is("revoked_at", null);
      const recipients = Array.from(
        new Set(
          (roleRows ?? [])
            .map((r: { work_email?: string | null }) => (r.work_email ?? "").trim().toLowerCase())
            .filter(Boolean),
        ),
      );
      if (recipients.length === 0) return;
      const type = body.locked ? "payroll.processing_started" : "payroll.processing_stopped";
      const title = body.locked ? "Payroll Processing Started" : "Payroll Processing Stopped";
      const message = body.locked
        ? `${actor ?? "Accounting"} started payroll processing. Disputes, bank changes, and leave requests are temporarily paused.`
        : `${actor ?? "Accounting"} stopped payroll processing. Normal operations have resumed.`;
      await supabase.from("employee_notifications").insert(
        recipients.map((to) => ({
          recipient_email: to,
          type,
          tone: "neutral",
          title,
          message,
          details: { locked: body.locked, actor, started_at: state.lockedAt },
        })),
      );
    } catch {
      /* non-fatal */
    }
  })();

  return NextResponse.json(state);
}
