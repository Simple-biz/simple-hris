import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { hasElevatedRole } from "@/lib/auth/elevated-roles";
import { listDepartmentsForManager } from "@/lib/supabase/department-managers";
import { markPendingHireNoShow } from "@/lib/supabase/hr-pending-employees";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import {
  OFFBOARD_DEACTIVATE_SLUG,
  OFFBOARD_DELETE_SLUG,
  fireOffboardWebhook,
  isLeadGenDepartment,
  scheduledDeletionFrom,
} from "@/lib/hr/offboard-webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function normEmail(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

type HireRow = {
  id: number;
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
  department: string | null;
  status: string;
};

/**
 * Authorizes the caller as a manager of the hire's department (or elevated) and
 * returns the full pending row. Mirrors the orientation route's gate.
 */
async function authorizeAndLoad(id: number) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const sessionEmail = normEmail(user?.email ?? null);
  if (!sessionEmail) {
    return { ok: false as const, res: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  }
  const roles = (user?.roles ?? []) as string[];
  if (!(roles.includes("manager") || roles.includes("admin"))) {
    return {
      ok: false as const,
      res: NextResponse.json({ error: "Manager or admin role required" }, { status: 403 }),
    };
  }

  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    return {
      ok: false as const,
      res: NextResponse.json({ error: "Supabase not configured" }, { status: 500 }),
    };
  }
  const { data: hireRow, error: hireErr } = await sb
    .from("hr_pending_employees")
    .select("id, name, work_email, personal_email, department, status")
    .eq("id", id)
    .single();
  if (hireErr || !hireRow) {
    return { ok: false as const, res: NextResponse.json({ error: "Pending hire not found" }, { status: 404 }) };
  }
  const row = hireRow as HireRow;

  if (!hasElevatedRole(roles)) {
    const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
    const allowed = new Set(assigns.map((a) => a.department.trim().toLowerCase()));
    const hireDept = (row.department ?? "").trim().toLowerCase();
    if (!allowed.has(hireDept)) {
      return {
        ok: false as const,
        res: NextResponse.json({ error: "You don't manage this hire's department." }, { status: 403 }),
      };
    }
  }

  return { ok: true as const, sessionEmail, row };
}

/**
 * POST /api/manager/pending-hires/[id]/no-show
 * Body: { note?: string }
 *
 * Manager marks a staged hire as "Did not attend orientation": flips the row to
 * status='no_show' and fires the department-aware account teardown keyed by the
 * pending row's work_email (the hire was never promoted, so there is no
 * global_master_list row).
 *
 *   Lead Gen        -> fire offboarding_delete now; stamp deletion_processed_at.
 *   Other depts     -> fire offboarding_deactivate now; set the 14-day timer on
 *                      the pending row (the cron fires the delete later).
 *   No work_email   -> no account exists yet; just mark no_show, fire nothing.
 *
 * never_promoted:true tells n8n the Hubstaff member was never invited (invite
 * only fires at promote), so Hubstaff removal is a no-op.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const authz = await authorizeAndLoad(id);
  if (!authz.ok) return authz.res;
  const { row, sessionEmail } = authz;

  if (row.status === "promoted") {
    return NextResponse.json(
      { error: "This hire was already promoted. Use the HR Offboard flow instead of no-show." },
      { status: 400 },
    );
  }

  let body: { note?: string | null } = {};
  try {
    body = (await req.json()) as { note?: string | null };
  } catch {
    // empty body is fine
  }

  const workEmail = normEmail(row.work_email);
  const leadGen = isLeadGenDepartment(row.department);
  const nowIso = new Date().toISOString();

  // Fire the teardown only when an account actually exists (work email present).
  let webhook: { fired: boolean; status: number | null; error: string | null } | null = null;
  if (workEmail) {
    const slug = leadGen ? OFFBOARD_DELETE_SLUG : OFFBOARD_DEACTIVATE_SLUG;
    webhook = await fireOffboardWebhook(slug, {
      event: "hire.no_show",
      phase: leadGen ? "delete" : "deactivate",
      deletion_mode: leadGen ? "immediate" : "delayed_14d",
      never_promoted: true,
      hubstaff_pay_rate: 0,
      work_email: workEmail,
      personal_email: row.personal_email,
      name: row.name,
      departments: row.department ? [row.department] : [],
      no_show_by: sessionEmail,
      no_show_at: nowIso,
    });
  }

  // Lead Gen (or no account): nothing left to delete later -> mark processed now.
  // Non-Lead-Gen with an account: set the 14-day timer for the cron.
  const scheduledDeletionAt = workEmail && !leadGen ? scheduledDeletionFrom(nowIso) : null;
  const deletionProcessedAt = !workEmail || leadGen ? nowIso : null;

  const { row: updated, error } = await markPendingHireNoShow(id, {
    markedBy: sessionEmail,
    note: body.note ?? null,
    scheduledDeletionAt,
    deletionProcessedAt,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });

  void insertAuditLog({
    user_name: sessionEmail,
    user_role: "manager",
    action: "hr.hire.no_show",
    resource: "hr_pending_employees",
    resource_id: String(id),
    details: {
      target_email: workEmail || null,
      department: row.department,
      lead_gen: leadGen,
      deletion_mode: workEmail ? (leadGen ? "immediate" : "delayed_14d") : "no_account",
      scheduled_deletion_at: scheduledDeletionAt,
      webhook_fired: webhook ? webhook.fired && webhook.error == null : false,
      webhook_status: webhook?.status ?? null,
      webhook_error: webhook?.error ?? null,
    },
  });

  return NextResponse.json({ row: updated, webhook });
}
