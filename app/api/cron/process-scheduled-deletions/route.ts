import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import {
  OFFBOARD_DELETE_SLUG,
  fireOffboardWebhook,
} from "@/lib/hr/offboard-webhooks";
import { cronSessionElevated } from "@/lib/auth/cron-auth";
import {
  loadDeletionGuardIndex,
  splitDueDeletions,
  type HeldDeletion,
} from "@/lib/hr/deletion-hold";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM_USER = { name: "Scheduled Deletion Cron", role: "System" } as const;
const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";
const HUBSTAFF_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours";

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0]!.trim() : req.headers.get("x-real-ip");
}

/** Same auth model as the sheet-sync crons: Bearer CRON_SECRET if configured,
 *  otherwise open (so it also works from a manual admin trigger / local dev). */
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${expected}`;
}

/**
 * GET/POST /api/cron/process-scheduled-deletions
 *
 * Daily Vercel cron (see vercel.json). Finds off-boarded rows whose 14-day
 * deactivation window has elapsed and fires `offboarding_delete` to
 * permanently delete the Workspace account.
 *
 * LEGACY DRAIN since 2026-08-07: offboards now fire `offboarding_delete`
 * immediately for every reason/department and never stamp
 * `scheduled_deletion_at`, so this cron only exists to work off rows stamped
 * before that change. Once the backlog is empty it will always no-op.
 *
 * HOLD before delete (2026-10-01, audit item 301): a due row is fired only when
 * no signal says the person is here: a live row on its work or personal email,
 * an in-flight or later hire on the work email, or worked time in the current
 * Hubstaff upload (`src/lib/hr/deletion-hold.ts`). A held row gets no webhook
 * and no write; it is reported in `held` and re-checked next run. If any guard
 * read fails, NOTHING fires.
 *
 * Idempotency: rows are row-keyed (not email-keyed) and stamped with
 * `deletion_processed_at` only after the webhook succeeds, so a Vercel cron
 * retry (or a manual re-run) never double-deletes. Rows whose webhook failed
 * keep deletion_processed_at NULL and are retried next run.
 */
async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req) && !(await cronSessionElevated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json(
      { success: false, error: "SUPABASE_SERVICE_ROLE_KEY is required for this cron." },
      { status: 400 },
    );
  }

  const nowIso = new Date().toISOString();

  // Work queue: timer elapsed, not yet processed. A returning person is NOT
  // guaranteed absent from it: a rehire on a NEW row leaves the old row's timer
  // in place (measured 2026-10-01). The hold below is what keeps them safe.
  const { data, error } = await supabase
    .from(MASTER_TABLE)
    .select(
      'id, "Name", "Work Email", "Personal Email", "Department", "Start Date", scheduled_deletion_at, off_boarded_at',
    )
    .lte("scheduled_deletion_at", nowIso)
    .not("scheduled_deletion_at", "is", null)
    .is("deletion_processed_at", null)
    .range(0, 499);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  const due = (data ?? []) as Array<{
    id: unknown;
    Name: string | null;
    "Work Email": string | null;
    "Personal Email": string | null;
    Department: string | null;
    "Start Date": string | null;
    scheduled_deletion_at: string | null;
    off_boarded_at: string | null;
  }>;

  // NON-Lead-Gen no-show hires whose 14-day timer elapsed. These were never
  // promoted, so they have no global_master_list row -- the timer lives on the
  // pending row instead. Read BEFORE anything fires, so a failed read can never
  // leave a run half done.
  const { data: pendingData, error: pendingErr } = await supabase
    .from("hr_pending_employees")
    .select("id, name, work_email, personal_email, department, scheduled_deletion_at, created_at")
    .eq("status", "no_show")
    .lte("scheduled_deletion_at", nowIso)
    .not("scheduled_deletion_at", "is", null)
    .is("deletion_processed_at", null)
    .range(0, 499);
  if (pendingErr) {
    return NextResponse.json({ success: false, error: pendingErr.message }, { status: 500 });
  }
  const duePending = (pendingData ?? []) as Array<{
    id: number;
    name: string | null;
    work_email: string | null;
    personal_email: string | null;
    department: string | null;
    scheduled_deletion_at: string | null;
    created_at: string | null;
  }>;

  let fireMaster: typeof due = [];
  let firePending: typeof duePending = [];
  const held: Array<HeldDeletion & { source: "master" | "pending" }> = [];
  if (due.length + duePending.length > 0) {
    const guard = await loadDeletionGuardIndex(supabase, {
      masterTable: MASTER_TABLE,
      hubstaffTable: HUBSTAFF_TABLE,
    });
    if (guard.error !== null) {
      return NextResponse.json(
        { success: false, error: `Nothing was deleted: ${guard.error}` },
        { status: 500 },
      );
    }
    const master = splitDueDeletions(
      due,
      (row) => ({
        workEmail: row["Work Email"],
        personalEmail: row["Personal Email"],
        leftAt: row.off_boarded_at,
      }),
      guard.index,
    );
    const pending = splitDueDeletions(
      duePending,
      (row) => ({
        workEmail: row.work_email,
        personalEmail: row.personal_email,
        leftAt: row.created_at,
        ownPendingId: row.id,
      }),
      guard.index,
    );
    fireMaster = master.fire;
    firePending = pending.fire;
    held.push(
      ...master.held.map((h) => ({ ...h, source: "master" as const })),
      ...pending.held.map((h) => ({ ...h, source: "pending" as const })),
    );
  }

  let deleted = 0;
  let failed = 0;
  const failures: Array<{ work_email: string | null; error: string | null }> = [];

  for (const row of fireMaster) {
    const workEmail = (row["Work Email"] ?? "").trim().toLowerCase();
    const webhook = await fireOffboardWebhook(OFFBOARD_DELETE_SLUG, {
      event: "employee.offboarded",
      phase: "delete",
      deletion_mode: "delayed_14d",
      scheduled: true,
      work_email: workEmail || null,
      personal_email: row["Personal Email"],
      name: row.Name,
      departments: row.Department ? [row.Department] : [],
      start_date: row["Start Date"],
      scheduled_deletion_at: row.scheduled_deletion_at,
    });

    if (webhook.fired && webhook.error == null) {
      // Stamp processed only on success so failures retry next run.
      const { error: stampErr } = await supabase
        .from(MASTER_TABLE)
        .update({ deletion_processed_at: new Date().toISOString() })
        .eq("id", row.id as string);
      if (stampErr) {
        failed += 1;
        failures.push({ work_email: workEmail || null, error: `stamp failed: ${stampErr.message}` });
      } else {
        deleted += 1;
      }
    } else {
      failed += 1;
      failures.push({ work_email: workEmail || null, error: webhook.error ?? "webhook did not fire" });
    }
  }

  // never_promoted:true tells n8n the Hubstaff member was never invited
  // (invite only fires at promote), so removal is a no-op.
  let pendingDeleted = 0;
  let pendingFailed = 0;
  for (const row of firePending) {
    const workEmail = (row.work_email ?? "").trim().toLowerCase();
    const webhook = await fireOffboardWebhook(OFFBOARD_DELETE_SLUG, {
      event: "hire.no_show",
      phase: "delete",
      deletion_mode: "delayed_14d",
      scheduled: true,
      never_promoted: true,
      work_email: workEmail || null,
      personal_email: row.personal_email,
      name: row.name,
      departments: row.department ? [row.department] : [],
      scheduled_deletion_at: row.scheduled_deletion_at,
    });
    if (webhook.fired && webhook.error == null) {
      const { error: stampErr } = await supabase
        .from("hr_pending_employees")
        .update({ deletion_processed_at: new Date().toISOString() })
        .eq("id", row.id);
      if (stampErr) {
        pendingFailed += 1;
        failures.push({ work_email: workEmail || null, error: `pending stamp failed: ${stampErr.message}` });
      } else {
        pendingDeleted += 1;
      }
    } else {
      pendingFailed += 1;
      failures.push({ work_email: workEmail || null, error: webhook.error ?? "webhook did not fire" });
    }
  }

  void insertAuditLog({
    user_name: SYSTEM_USER.name,
    user_role: SYSTEM_USER.role,
    action: "hr.employee.scheduled_deletion",
    resource: MASTER_TABLE,
    resource_id: null,
    details: {
      due: due.length,
      deleted,
      failed,
      pending_due: duePending.length,
      pending_deleted: pendingDeleted,
      pending_failed: pendingFailed,
      held_count: held.length,
      held,
      failures,
    },
    ip_address: clientIp(req),
  });

  return NextResponse.json({
    success: true,
    due: due.length,
    deleted,
    failed,
    pending_due: duePending.length,
    pending_deleted: pendingDeleted,
    pending_failed: pendingFailed,
    held_count: held.length,
    held,
    failures,
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
