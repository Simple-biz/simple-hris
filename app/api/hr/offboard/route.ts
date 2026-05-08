import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import {
  deniedResponse,
  requireElevatedSession,
} from "@/lib/auth/authorize-email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";

/**
 * n8n webhook that fans out the rest of the off-board workflow:
 *   • deactivates the @simple.biz Workspace account (Drew's automation)
 *   • sends the termination notice to the personal email on file
 *
 * Configurable via env so test ↔ prod URLs can swap without redeploying code.
 * The default is the test endpoint the team gave us (n8n "Listen" mode — only
 * fires while the test workflow is armed). For production, set the env var to
 * the corresponding `/webhook/...` URL (no `-test` segment).
 */
const OFFBOARD_WEBHOOK_URL =
  process.env.N8N_OFFBOARDING_WEBHOOK_URL?.trim() ||
  "https://auto.simple.biz/webhook-test/offboarding-endpoint";

/** Reasons HR can pick when off-boarding. Free-text notes are stored separately
 *  in `off_boarded_note`. "other" requires a non-empty note. */
const VALID_REASONS = [
  "resigned",
  "performance",
  "time_manipulation",
  "attendance",
  "end_of_contract",
  "other",
] as const;
type Reason = (typeof VALID_REASONS)[number];

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

/** Fire-and-forget POST to the n8n offboarding webhook. Errors are logged but
 *  must NEVER fail the off-board itself — the DB write is the source of truth;
 *  the webhook is a side-effect for downstream automation. 8s timeout so a
 *  hanging webhook can't tie up the API request indefinitely. */
async function triggerOffboardWebhook(payload: Record<string, unknown>): Promise<{
  fired: boolean;
  status: number | null;
  error: string | null;
}> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(OFFBOARD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!res.ok) {
      console.error(
        `[offboard] webhook ${OFFBOARD_WEBHOOK_URL} returned ${res.status} ${res.statusText}`,
      );
      return { fired: true, status: res.status, error: `HTTP ${res.status}` };
    }
    return { fired: true, status: res.status, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[offboard] webhook ${OFFBOARD_WEBHOOK_URL} threw: ${msg}`);
    return { fired: false, status: null, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * POST /api/hr/offboard
 *
 * Body: { work_email: string; reason: Reason; note?: string }
 *
 * Marks every `global_master_list` row matching `work_email` as off-boarded:
 * sets off_boarded_at = now(), off_boarded_reason, off_boarded_by, off_boarded_note.
 * The `active_employees` view excludes rows with off_boarded_at set, so the
 * person drops from every downstream dashboard immediately.
 *
 * History is retained — rows are NOT deleted. Use the Add Person flow to
 * re-onboard if needed (creates a fresh row).
 */
export async function POST(req: Request) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  let body: { work_email?: string; reason?: string; note?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const work_email = body.work_email?.trim().toLowerCase();
  const reason = body.reason?.trim() as Reason | undefined;
  const note = body.note?.trim() || null;

  if (!work_email) {
    return NextResponse.json({ error: "work_email is required" }, { status: 400 });
  }
  if (!reason || !VALID_REASONS.includes(reason)) {
    return NextResponse.json(
      { error: `reason is required and must be one of: ${VALID_REASONS.join(", ")}` },
      { status: 400 },
    );
  }
  if (reason === "other" && !note) {
    return NextResponse.json(
      { error: 'When reason is "other", a free-text note is required.' },
      { status: 400 },
    );
  }

  const supabase = getClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  // Update every row with that work_email — covers dual-role employees who
  // have multiple master-list rows (one per department). All get off-boarded
  // together; they're the same person. Select identity fields back so we can
  // pass them to the n8n webhook (account deactivation + termination email).
  const offBoardedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from(MASTER_TABLE)
    .update({
      off_boarded_at: offBoardedAt,
      off_boarded_reason: reason,
      off_boarded_by: authz.sessionEmail,
      off_boarded_note: note,
    })
    .ilike('"Work Email"', work_email)
    .is("off_boarded_at", null) // don't re-stamp already-offboarded rows
    .select('id, "Name", "Personal Email", "Work Email", "Department", "Start Date"');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    id: unknown;
    Name: string | null;
    "Personal Email": string | null;
    "Work Email": string | null;
    Department: string | null;
    "Start Date": string | null;
  }>;

  if (rows.length === 0) {
    return NextResponse.json(
      {
        error:
          "No active master-list row found for that email. They may already be off-boarded, or the email doesn't exist on the roster.",
      },
      { status: 404 },
    );
  }

  // All rows share the same person — pull identity from the first row.
  const first = rows[0]!;
  const departments = Array.from(
    new Set(rows.map((r) => r.Department).filter((d): d is string => !!d)),
  );

  // Trigger Drew's n8n automation. Awaited (with internal timeout) so we can
  // surface the webhook status to the UI; failures don't block the off-board
  // since the DB update has already committed.
  const webhook = await triggerOffboardWebhook({
    event: "employee.offboarded",
    work_email,
    personal_email: first["Personal Email"],
    name: first.Name,
    departments,
    start_date: first["Start Date"],
    reason,
    note,
    off_boarded_at: offBoardedAt,
    off_boarded_by: authz.sessionEmail,
    rows_updated: rows.length,
  });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: "hr",
    action: "hr.employee.offboarded",
    resource: MASTER_TABLE,
    resource_id: work_email,
    details: {
      target_email: work_email,
      reason,
      note,
      rows_updated: rows.length,
      webhook_fired: webhook.fired,
      webhook_status: webhook.status,
      webhook_error: webhook.error,
    },
  });

  return NextResponse.json({
    success: true,
    rows_updated: rows.length,
    webhook,
  });
}
