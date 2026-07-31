import { NextResponse } from "next/server";
import {
  bulkSetHrNewHireChecklistField,
  deleteHrNewHireChecklistRows,
  getHrChecklistPeriod,
  insertHrNewHireChecklistRow,
  listHrNewHireChecklist,
  setHrChecklistPeriodStatus,
  updateHrNewHireChecklistRow,
  HR_NEW_HIRE_CHECKLIST_FIELDS,
  type HrNewHireChecklistField,
} from "@/lib/supabase/hr-new-hire-checklist";
import { deniedResponse, requireElevatedSession } from "@/lib/auth/authorize-email";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { fireNewHireChecklistLockWebhook } from "@/lib/hr/new-hire-checklist-webhook";
import { insertAuditLog } from "@/lib/supabase/audit-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_SET = new Set<string>(HR_NEW_HIRE_CHECKLIST_FIELDS);

/** Keep only recognised data columns from an untrusted values object. */
function pickFields(
  raw: unknown,
): Partial<Record<HrNewHireChecklistField, string | null>> {
  const out: Partial<Record<HrNewHireChecklistField, string | null>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!FIELD_SET.has(k)) continue;
    out[k as HrNewHireChecklistField] = v == null ? null : String(v);
  }
  return out;
}

/** True when the given week is currently locked (so mutations are refused). */
async function weekIsLocked(period: string): Promise<boolean> {
  if (!ISO_DATE.test(period)) return false;
  const { period: state } = await getHrChecklistPeriod(period);
  return state?.status === "locked";
}

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
 * POST — add ONE hire to a week. Body: { period_start, period_end?, values }.
 * Atomic insert: never touches another row, so two people adding different
 * hires at once can't collide. Refused if the week is locked.
 */
export async function POST(req: Request) {
  const authz = await requireFeatureEdit("hr", "new_hire_checklist");
  if (!authz.ok) return deniedResponse(authz);

  let body: { period_start?: string; period_end?: string | null; values?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const period = (body.period_start ?? "").trim();
  if (!ISO_DATE.test(period)) {
    return NextResponse.json({ error: "A valid period_start (YYYY-MM-DD) is required" }, { status: 400 });
  }
  const current = await getHrChecklistPeriod(period);
  if (current.period?.status === "locked") {
    return NextResponse.json({ error: "This week is locked. Reopen it before adding hires." }, { status: 409 });
  }

  const { row, error } = await insertHrNewHireChecklistRow(period, pickFields(body.values), {
    createdBy: authz.sessionEmail,
  });
  if (error || !row) return NextResponse.json({ error: error ?? "Insert failed" }, { status: 400 });

  // First touch of a brand-new week records its end date (best-effort).
  if (body.period_end && !current.period?.period_end) {
    await setHrChecklistPeriodStatus(period, {
      status: current.period?.status ?? "open",
      periodEnd: body.period_end,
      by: authz.sessionEmail,
    });
  }

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "hr",
    action: "hr.new_hire_checklist.row_added",
    resource: "hr_new_hire_checklist",
    resource_id: row.id,
    details: { period, name: row.name },
  });

  return NextResponse.json({ row });
}

/**
 * PATCH — either update ONE row or bulk-set ONE field on many rows.
 *   • Single: { period_start?, id, values, expectedUpdatedAt? } → updates only
 *     the given fields; a stale `expectedUpdatedAt` yields 409 (co-editor won).
 *   • Bulk:   { period_start?, ids:[...], field, value } → sets one column on
 *     each id (bulk-apply department / country).
 * Refused if `period_start` is given and that week is locked.
 */
export async function PATCH(req: Request) {
  const authz = await requireFeatureEdit("hr", "new_hire_checklist");
  if (!authz.ok) return deniedResponse(authz);

  let body: {
    period_start?: string;
    id?: string;
    values?: unknown;
    expectedUpdatedAt?: string | null;
    ids?: unknown;
    field?: string;
    value?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const period = (body.period_start ?? "").trim();
  if (period && (await weekIsLocked(period))) {
    return NextResponse.json({ error: "This week is locked. Reopen it before editing." }, { status: 409 });
  }

  // Bulk set-field.
  if (Array.isArray(body.ids)) {
    const field = body.field ?? "";
    if (!FIELD_SET.has(field)) {
      return NextResponse.json({ error: "A valid field is required for a bulk update" }, { status: 400 });
    }
    const ids = (body.ids as unknown[]).map((x) => String(x));
    const { rows, error } = await bulkSetHrNewHireChecklistField(
      ids,
      field as HrNewHireChecklistField,
      body.value ?? null,
      { editedBy: authz.sessionEmail },
    );
    if (error) return NextResponse.json({ error }, { status: 500 });
    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: authz.roles[0] ?? "hr",
      action: "hr.new_hire_checklist.bulk_set",
      resource: "hr_new_hire_checklist",
      resource_id: period || field,
      details: { field, value: body.value ?? null, count: ids.length },
    });
    return NextResponse.json({ rows });
  }

  // Single-row update.
  const id = (body.id ?? "").trim();
  if (!id) {
    return NextResponse.json({ error: "A row id (or ids[] for a bulk update) is required" }, { status: 400 });
  }
  const { row, conflict, error } = await updateHrNewHireChecklistRow(id, pickFields(body.values), {
    editedBy: authz.sessionEmail,
    expectedUpdatedAt: body.expectedUpdatedAt ?? null,
  });
  if (conflict) return NextResponse.json({ conflict: true, row }, { status: 409 });
  if (error) return NextResponse.json({ error }, { status: 400 });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "hr",
    action: "hr.new_hire_checklist.row_updated",
    resource: "hr_new_hire_checklist",
    resource_id: id,
    details: { period: period || null },
  });

  return NextResponse.json({ row });
}

/**
 * DELETE — remove rows by id. Body: { period_start?, id? , ids?:[...] }. Deletes
 * exactly the ids named (never "everything not in a payload"). Refused if
 * `period_start` is given and that week is locked.
 */
export async function DELETE(req: Request) {
  const authz = await requireFeatureEdit("hr", "new_hire_checklist");
  if (!authz.ok) return deniedResponse(authz);

  let body: { period_start?: string; id?: string; ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const period = (body.period_start ?? "").trim();
  if (period && (await weekIsLocked(period))) {
    return NextResponse.json({ error: "This week is locked. Reopen it before deleting." }, { status: 409 });
  }

  const ids = Array.isArray(body.ids)
    ? (body.ids as unknown[]).map((x) => String(x))
    : body.id
      ? [String(body.id)]
      : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "id or ids[] is required" }, { status: 400 });
  }

  const { deleted, error } = await deleteHrNewHireChecklistRows(ids);
  if (error) return NextResponse.json({ error }, { status: 500 });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "hr",
    action: "hr.new_hire_checklist.row_deleted",
    resource: "hr_new_hire_checklist",
    resource_id: period || ids[0]!,
    details: { period: period || null, count: deleted },
  });

  return NextResponse.json({ deleted });
}

/**
 * PUT — lock / reopen a week (no row payload; rows are persisted atomically via
 * POST/PATCH/DELETE as they happen).
 *   lock   — freeze the week and fire the orientation webhook off the rows
 *            CURRENTLY IN THE DB (never a client's possibly-stale copy).
 *   reopen — flip the week back to 'open' for editing.
 */
export async function PUT(req: Request) {
  const authz = await requireFeatureEdit("hr", "new_hire_checklist");
  if (!authz.ok) return deniedResponse(authz);

  let body: { period_start?: string; period_end?: string | null; action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const period = (body.period_start ?? "").trim();
  if (!ISO_DATE.test(period)) {
    return NextResponse.json({ error: "A valid period_start (YYYY-MM-DD) is required" }, { status: 400 });
  }
  const action = body.action === "lock" ? "lock" : body.action === "reopen" ? "reopen" : null;
  if (!action) {
    return NextResponse.json({ error: "action must be 'lock' or 'reopen'" }, { status: 400 });
  }

  if (action === "reopen") {
    const { period: periodState, error } = await setHrChecklistPeriodStatus(period, {
      status: "open",
      periodEnd: body.period_end ?? null,
      by: authz.sessionEmail,
    });
    if (error) return NextResponse.json({ error }, { status: 500 });
    const { rows } = await listHrNewHireChecklist(period);
    void insertAuditLog({
      user_name: authz.sessionEmail,
      user_role: authz.roles[0] ?? "hr",
      action: "hr.new_hire_checklist.reopened",
      resource: "hr_new_hire_checklist",
      resource_id: period,
      details: { period },
    });
    return NextResponse.json({ rows, period: periodState });
  }

  // Lock: freeze first, then push the DB's rows to n8n (best-effort — the DB is
  // the source of truth, so a webhook failure never fails the lock).
  const locked = await setHrChecklistPeriodStatus(period, {
    status: "locked",
    periodEnd: body.period_end ?? null,
    by: authz.sessionEmail,
  });
  if (locked.error) return NextResponse.json({ error: locked.error }, { status: 500 });

  const { rows } = await listHrNewHireChecklist(period);
  const webhook = await fireNewHireChecklistLockWebhook({
    period: locked.period,
    periodStart: period,
    periodEnd: body.period_end ?? null,
    rows,
    lockedBy: authz.sessionEmail,
  });

  void insertAuditLog({
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? "hr",
    action: "hr.new_hire_checklist.locked",
    resource: "hr_new_hire_checklist",
    resource_id: period,
    details: {
      period,
      row_count: rows.length,
      webhook_fired: webhook ? webhook.fired && webhook.error == null : false,
      webhook_sent_count: webhook?.count ?? 0,
      webhook_skipped: (webhook?.skipped ?? []).map((s) => ({
        name: s.name,
        personal_email: s.personal_email,
      })),
    },
  });

  return NextResponse.json({ rows, period: locked.period, webhook });
}
