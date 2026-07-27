import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import {
  deniedResponse,
} from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import {
  LEAD_GEN_DELETION_DELAY_DAYS,
  OFFBOARD_DEACTIVATE_SLUG,
  fireOffboardWebhook,
  isLeadGenDepartment,
  scheduledDeletionFrom,
} from "@/lib/hr/offboard-webhooks";
import { appendOffboardedSheetRow } from "@/lib/google-sheets/append-offboarded-sheet";
import { offboardReasonLabel } from "@/lib/hr/offboard-reasons";
import { snapshotAndRevokeRbacGrants } from "@/lib/hr/offboard-rbac";
import { bumpForceLogoutFor } from "@/lib/auth/force-logout";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The offboarding webhooks respond "when the last node finishes" (deactivate
// suspends the Workspace account AND sends the termination email synchronously),
// which can take well over the old 8s budget. Give the function headroom so
// Vercel doesn't kill it before n8n replies. A batch fires at most three webhooks
// (one per phase/deletion-mode group) regardless of how many people are in it, so
// this ceiling still holds — the per-person account teardown is fanned out inside
// each n8n flow.
export const maxDuration = 60;

const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";

/** Reasons HR can pick when off-boarding. Free-text notes are stored separately
 *  in `off_boarded_note`. "other" requires a non-empty note. "temporary_pause"
 *  suspends the account (deactivate webhook) but never schedules the delete. */
const VALID_REASONS = [
  "ncns",
  "resigned",
  "performance",
  "time_manipulation",
  "attendance",
  "end_of_contract",
  "temporary_pause",
  "other",
] as const;
type Reason = (typeof VALID_REASONS)[number];

function getClient() {
  return createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
}

type SupabaseClient = NonNullable<ReturnType<typeof getClient>>;

/** One normalized offboard request after validation. */
interface OffboardRequest {
  work_email: string;
  reason: Reason;
  note: string | null;
}

/** The per-person payload that rides inside a phase-grouped webhook envelope.
 *  `off_boarded_by` / `off_boarded_at` are duplicated here (they also live on the
 *  envelope) so each item is self-contained after n8n's Split Out — the per-person
 *  email node needs them without reaching back to the parent. */
interface OffboardEmployeePayload {
  work_email: string;
  personal_email: string | null;
  name: string | null;
  departments: string[];
  start_date: string | null;
  reason: Reason;
  note: string | null;
  off_boarded_by: string;
  off_boarded_at: string;
  scheduled_deletion_at: string | null;
}

type Phase = "deactivate" | "delete";
/** "none" = temporary pause: suspended via deactivate, never deleted.
 *  "delayed_7d" = all-Lead-Gen: suspended now, cron-deleted after the 7-day
 *  final-pay grace window. "delayed_14d" = everyone else. Nothing deletes
 *  immediately anymore — a leaver's account and data must survive their final
 *  pay cycle (n8n treats delayed_7d exactly like delayed_14d: suspend only). */
type DeletionMode = "delayed_7d" | "delayed_14d" | "none";

interface OffboardOutcome {
  work_email: string;
  ok: boolean;
  status: number;
  error: string | null;
  phase: Phase;
  deletion_mode: DeletionMode;
  rows_updated: number;
  rbac_revoked: { roles: number; departments: number; features: number } | null;
  payload: OffboardEmployeePayload | null;
}

/**
 * Validates a single {work_email, reason, note} triple. Returns the normalized
 * request or an error string (never throws). Shared by the single- and
 * batch-shaped bodies so both paths reject identically.
 */
function validateOne(raw: {
  work_email?: unknown;
  reason?: unknown;
  note?: unknown;
}): { ok: true; value: OffboardRequest } | { ok: false; error: string } {
  const work_email =
    typeof raw.work_email === "string" ? raw.work_email.trim().toLowerCase() : "";
  const reason = (typeof raw.reason === "string" ? raw.reason.trim() : "") as
    | Reason
    | "";
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : null;

  if (!work_email) return { ok: false, error: "work_email is required" };
  if (!reason || !VALID_REASONS.includes(reason)) {
    return {
      ok: false,
      error: `reason is required and must be one of: ${VALID_REASONS.join(", ")}`,
    };
  }
  if (reason === "other" && !note) {
    return { ok: false, error: 'When reason is "other", a free-text note is required.' };
  }
  return { ok: true, value: { work_email, reason, note } };
}

/**
 * Off-boards ONE person: stamps every active master-list row, kicks off the
 * best-effort side-effects (offboarded_sheet insert + Google Sheet append,
 * cancel pending hires), revokes RBAC + force-logs-out, and writes the audit
 * row. Returns everything the caller needs to build the phase-grouped webhook
 * envelope — but does NOT fire the webhook itself, so a whole batch can be
 * coalesced into at most two POSTs. Never throws.
 *
 * `offBoardedAt` is passed in so every person in a batch shares one timestamp
 * (and therefore one deletion window), keeping the envelope's `off_boarded_at`
 * meaningful.
 */
async function offboardOnePerson(
  supabase: SupabaseClient,
  req: OffboardRequest,
  actorEmail: string,
  offBoardedAt: string,
): Promise<OffboardOutcome> {
  const { work_email, reason, note } = req;
  const isTemporaryPause = reason === "temporary_pause";
  const fallbackMode: DeletionMode = isTemporaryPause ? "none" : "delayed_14d";
  const base: Omit<OffboardOutcome, "phase" | "deletion_mode"> = {
    work_email,
    ok: false,
    status: 500,
    error: null,
    rows_updated: 0,
    rbac_revoked: null,
    payload: null,
  };

  // Look at the still-active rows first so we know which departments this person
  // belongs to before deciding the teardown mode.
  const { data: activeRows, error: lookupErr } = await supabase
    .from(MASTER_TABLE)
    .select('"Department"')
    .ilike('"Work Email"', work_email)
    .is("off_boarded_at", null);
  if (lookupErr) {
    return { ...base, phase: "deactivate", deletion_mode: fallbackMode, error: lookupErr.message };
  }
  if (!activeRows || activeRows.length === 0) {
    return {
      ...base,
      status: 404,
      phase: "deactivate",
      deletion_mode: fallbackMode,
      error:
        "No active master-list row found for that email. They may already be off-boarded, or the email doesn't exist on the roster.",
    };
  }

  const lookupDepartments = (activeRows as Array<{ Department: string | null }>)
    .map((r) => r.Department)
    .filter((d): d is string => !!d);

  // EVERY offboard suspends first (deactivate) — deletion always runs through
  // the scheduled-deletion cron, so the person's account and data survive their
  // final pay cycle. All-Lead-Gen people get the short 7-day final-pay grace
  // window; any non-Lead-Gen role defers deletion 14 days. Temporary pause
  // overrides both: suspend and never schedule the delete — the person is
  // expected back.
  const allLeadGen =
    lookupDepartments.length > 0 && lookupDepartments.every(isLeadGenDepartment);
  const phase: Phase = "deactivate";
  const deletionMode: DeletionMode = isTemporaryPause
    ? "none"
    : allLeadGen
      ? "delayed_7d"
      : "delayed_14d";
  const scheduledDeletionAt =
    deletionMode === "none"
      ? null
      : scheduledDeletionFrom(
          offBoardedAt,
          deletionMode === "delayed_7d" ? LEAD_GEN_DELETION_DELAY_DAYS : undefined,
        );

  // Stamp off_boarded_* (and the deletion timer) on every active
  // row for this work_email. Covers dual-role employees with multiple rows.
  const { data, error } = await supabase
    .from(MASTER_TABLE)
    .update({
      off_boarded_at: offBoardedAt,
      off_boarded_reason: reason,
      off_boarded_by: actorEmail,
      off_boarded_note: note,
      scheduled_deletion_at: scheduledDeletionAt,
      deletion_processed_at: null,
    })
    .ilike('"Work Email"', work_email)
    .is("off_boarded_at", null) // don't re-stamp already-offboarded rows
    .select(
      'id, "Name", "Personal Email", "Work Email", "Department", "Start Date", city, province, full_address, "Location", "Phone Number"',
    );

  if (error) {
    return { ...base, phase, deletion_mode: deletionMode, error: error.message };
  }

  const rows = (data ?? []) as Array<{
    id: unknown;
    Name: string | null;
    "Personal Email": string | null;
    "Work Email": string | null;
    Department: string | null;
    "Start Date": string | null;
    city: string | null;
    province: string | null;
    full_address: string | null;
    Location: string | null;
    "Phone Number": string | null;
  }>;

  if (rows.length === 0) {
    return {
      ...base,
      status: 404,
      phase,
      deletion_mode: deletionMode,
      error:
        "No active master-list row found for that email. They may already be off-boarded, or the email doesn't exist on the roster.",
    };
  }

  const first = rows[0]!;
  const departments = Array.from(
    new Set(rows.map((r) => r.Department).filter((d): d is string => !!d)),
  );

  // Location mirrors AdminGlobalMasterList: "City, Province", falling back to the
  // seeded free-text full address, then the onboarding-form "Location" string
  // (which is all a freshly-promoted hire has — city/province were only backfilled
  // for the older seeded rows). Phone comes straight off the master row. Both feed
  // the Google "Offboarded" sheet columns HR expects filled (the offboarded_sheet
  // DB table ignores them — they're sheet-only enrichment).
  const location =
    [first.city, first.province].map((s) => s?.trim()).filter(Boolean).join(", ") ||
    first.full_address?.trim() ||
    first.Location?.trim() ||
    null;

  // Insert into offboarded_sheet immediately so the HR Offboarded tab shows the
  // person without waiting for the nightly cron. Best-effort — don't block.
  const sheetInput = {
    personalEmail: first["Personal Email"] ?? "",
    workEmail: work_email,
    name: first.Name,
    department: departments.join(", ") || null,
    location,
    phoneNumber: first["Phone Number"],
    startDate: first["Start Date"],
    offBoardedAt: offBoardedAt,
    offBoardedReason: reason,
    offBoardedNote: note,
    offBoardedBy: actorEmail,
  };

  void (async () => {
    try {
      await supabase.from("offboarded_sheet").insert({
        personal_email: sheetInput.personalEmail,
        work_email: sheetInput.workEmail,
        name: sheetInput.name,
        department: sheetInput.department,
        start_date: sheetInput.startDate,
        off_boarded_at: sheetInput.offBoardedAt,
        off_boarded_reason: sheetInput.offBoardedReason,
        off_boarded_note: sheetInput.offBoardedNote,
        off_boarded_by: sheetInput.offBoardedBy,
      });
    } catch (e) {
      console.error("[offboard] offboarded_sheet insert failed:", e);
    }
    try {
      // The sheet's "Offboard Reason" column is a dropdown of human labels
      // ("Resigned", "Performance", …) — write the label, not the raw slug, so
      // the value satisfies the cell's data validation. The DB row above keeps
      // the slug (consistent with off_boarded_reason on the master).
      await appendOffboardedSheetRow({
        ...sheetInput,
        offBoardedReason: offboardReasonLabel(reason),
      });
    } catch (e) {
      console.error("[offboard] Google Sheet Offboarded append failed:", e);
    }
    try {
      await supabase
        .from("hr_pending_employees")
        .update({ status: "cancelled" })
        .ilike("work_email", work_email)
        .in("status", ["pending_work_email", "ready"]);
    } catch (e) {
      console.error("[offboard] cancel pending hires failed:", e);
    }
  })();

  // Strip every RBAC grant this person holds and force-logout to kill live
  // sessions. The grants are snapshotted first so re-onboarding restores them.
  const rbacRevoked = await snapshotAndRevokeRbacGrants(work_email);
  void bumpForceLogoutFor(work_email);

  void insertAuditLog({
    user_name: actorEmail,
    user_role: "hr",
    action: "hr.employee.offboarded",
    resource: MASTER_TABLE,
    resource_id: work_email,
    details: {
      target_email: work_email,
      reason,
      note,
      rows_updated: rows.length,
      deletion_mode: deletionMode,
      scheduled_deletion_at: scheduledDeletionAt,
      rbac_revoked: rbacRevoked,
      // Every offboard fires deactivate now; the delete slug fires later from
      // the scheduled-deletion cron.
      webhook_slug: OFFBOARD_DEACTIVATE_SLUG,
      batched: true,
    },
  });

  return {
    work_email,
    ok: true,
    status: 200,
    error: null,
    phase,
    deletion_mode: deletionMode,
    rows_updated: rows.length,
    rbac_revoked: rbacRevoked,
    payload: {
      work_email,
      personal_email: first["Personal Email"],
      name: first.Name,
      departments,
      start_date: first["Start Date"],
      reason,
      note,
      off_boarded_by: actorEmail,
      off_boarded_at: offBoardedAt,
      scheduled_deletion_at: scheduledDeletionAt,
    },
  };
}

/**
 * POST /api/hr/offboard
 *
 * Accepts either shape:
 *   Single (back-compat): { work_email, reason, note? }
 *   Batch:                { employees: [{ work_email, reason, note? }, ...] }
 *
 * Marks every matching `global_master_list` row as off-boarded, tears down RBAC,
 * and fires the account SUSPENSION (`offboarding_deactivate`) — never a delete;
 * deletion happens later via the scheduled-deletion cron once the final-pay
 * grace window elapses (7d all-Lead-Gen, 14d others). Firing is COALESCED by
 * (phase, deletion_mode): all-Lead-Gen people go out in one envelope
 * (`deletion_mode: "delayed_7d"`), other deactivates in one (`"delayed_14d"`),
 * and temporary pauses in one with `deletion_mode: "none"` — so a batch of any
 * size is at most three webhook POSTs, each carrying an `employees[]` array
 * for n8n's Split Out.
 *
 * Response: `{ success, count, results[], webhooks[], webhook }`. `webhook` is
 * the first fired webhook (kept so the single-person dialog toast still works).
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit("hr", "offboarding");
  if (!authz.ok) return deniedResponse(authz);
  const actorEmail = authz.sessionEmail;

  let body: {
    work_email?: unknown;
    reason?: unknown;
    note?: unknown;
    employees?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Normalize both shapes into a validated list. A batch body wins if present.
  const rawList: Array<{ work_email?: unknown; reason?: unknown; note?: unknown }> =
    Array.isArray(body.employees)
      ? (body.employees as Array<{ work_email?: unknown; reason?: unknown; note?: unknown }>)
      : [{ work_email: body.work_email, reason: body.reason, note: body.note }];

  if (rawList.length === 0) {
    return NextResponse.json({ error: "No employees to off-board" }, { status: 400 });
  }

  // Validate everything up front — reject the whole batch before any writes if a
  // single entry is malformed, and de-dupe repeated work emails.
  const seen = new Set<string>();
  const requests: OffboardRequest[] = [];
  const validationErrors: Array<{ index: number; work_email: string | null; error: string }> = [];
  rawList.forEach((raw, index) => {
    const res = validateOne(raw);
    if (!res.ok) {
      validationErrors.push({
        index,
        work_email: typeof raw.work_email === "string" ? raw.work_email : null,
        error: res.error,
      });
      return;
    }
    if (seen.has(res.value.work_email)) return; // ignore duplicate rows silently
    seen.add(res.value.work_email);
    requests.push(res.value);
  });

  if (validationErrors.length > 0) {
    return NextResponse.json(
      { error: "One or more entries are invalid", validation_errors: validationErrors },
      { status: 400 },
    );
  }

  const supabase = getClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  // One timestamp for the whole batch → one shared 14-day deletion window.
  const offBoardedAt = new Date().toISOString();

  // Tear each person down (DB stamp + RBAC + side-effects), in parallel. Each
  // returns its phase + webhook payload; no webhook has fired yet.
  const outcomes = await Promise.all(
    requests.map((r) => offboardOnePerson(supabase, r, actorEmail, offBoardedAt)),
  );

  const succeeded = outcomes.filter((o) => o.ok && o.payload);
  const failed = outcomes.filter((o) => !o.ok);

  // Coalesce successes by (phase, deletion_mode) and fire at most one webhook
  // per group. Temporary pauses share the deactivate slug with regular
  // deactivates but go out in their own envelope (deletion_mode: "none") so the
  // n8n flow can branch on it — so a batch is at most THREE POSTs. Every group
  // is a deactivate now: deletes only ever fire from the scheduled-deletion
  // cron once the person's final-pay grace window has elapsed.
  const groupDefs: Array<{ phase: Phase; deletion_mode: DeletionMode }> = [
    { phase: "deactivate", deletion_mode: "none" },
    { phase: "deactivate", deletion_mode: "delayed_7d" },
    { phase: "deactivate", deletion_mode: "delayed_14d" },
  ];

  const webhooks: Array<{
    phase: Phase;
    deletion_mode: DeletionMode;
    slug: string;
    count: number;
    fired: boolean;
    status: number | null;
    error: string | null;
  }> = [];

  for (const { phase, deletion_mode } of groupDefs) {
    const group = succeeded.filter(
      (o) => o.phase === phase && o.deletion_mode === deletion_mode,
    );
    if (group.length === 0) continue;
    // Always the deactivate slug: this route never fires deletes anymore (the
    // scheduled-deletion cron owns OFFBOARD_DELETE_SLUG).
    const slug = OFFBOARD_DEACTIVATE_SLUG;
    const result = await fireOffboardWebhook(slug, {
      event: "employee.offboarded",
      phase,
      deletion_mode,
      hubstaff_pay_rate: 0,
      off_boarded_by: actorEmail,
      off_boarded_at: offBoardedAt,
      count: group.length,
      employees: group.map((o) => o.payload as OffboardEmployeePayload),
    });
    webhooks.push({
      phase,
      deletion_mode,
      slug,
      count: group.length,
      fired: result.fired,
      status: result.status,
      error: result.error,
    });
  }

  // Nothing off-boarded at all → surface the first failure with its status so the
  // single-person path still returns 404/500 as before.
  if (succeeded.length === 0) {
    const firstFail = failed[0];
    return NextResponse.json(
      { error: firstFail?.error ?? "Off-board failed", results: outcomes },
      { status: firstFail?.status ?? 500 },
    );
  }

  const results = outcomes.map((o) => ({
    work_email: o.work_email,
    ok: o.ok,
    error: o.error,
    deletion_mode: o.deletion_mode,
    rows_updated: o.rows_updated,
    rbac_revoked: o.rbac_revoked,
  }));

  return NextResponse.json({
    success: true,
    count: succeeded.length,
    failed_count: failed.length,
    results,
    webhooks,
    // Back-compat single-webhook field the offboarding dialog/toast reads.
    webhook: webhooks[0]
      ? { fired: webhooks[0].fired, status: webhooks[0].status, error: webhooks[0].error }
      : { fired: false, status: null, error: null },
  });
}
