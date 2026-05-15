import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./server";
import { getCurrentMasterListUploadId } from "./global-master-list-db";

const TABLE = "hr_pending_employees";
const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";

export type HrPendingStatus =
  | "pending_work_email"
  | "ready"
  | "promoted"
  | "cancelled";

export type HrPendingEmployeeRow = {
  id: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  name: string;
  personal_email: string;
  work_email: string | null;
  department: string;
  job_description: string | null;
  start_date: string | null;
  source: string | null;
  phone: string | null;
  location: string | null;
  regular_rate: string | null;
  ot_rate: string | null;
  status: HrPendingStatus;
  notes: string | null;
  promoted_at: string | null;
  /** UUID FK to global_master_list.id. Stays null until status='promoted'. */
  promoted_to_master_id: string | null;
  /** Set by the assigned department's manager. Required before HR promote runs. */
  orientation_attended_at: string | null;
  orientation_attended_by: string | null;
  orientation_note: string | null;
};

export type CreateHrPendingInput = {
  name: string;
  personal_email: string;
  work_email?: string | null;
  department: string;
  job_description?: string | null;
  start_date?: string | null;
  source?: string | null;
  phone?: string | null;
  location?: string | null;
  regular_rate?: string | null;
  ot_rate?: string | null;
  notes?: string | null;
  created_by?: string | null;
};

export type UpdateHrPendingInput = Partial<
  Omit<CreateHrPendingInput, "created_by">
> & { status?: HrPendingStatus };

function client() {
  const sb = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!sb)
    throw new Error(
      "Supabase client missing — set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or anon key)",
    );
  return sb;
}

/** Newest-first list of every staged hire. UI filters by status client-side. */
export async function listHrPendingEmployees(): Promise<{
  rows: HrPendingEmployeeRow[];
  error: string | null;
}> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .range(0, 1999);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as HrPendingEmployeeRow[], error: null };
}

/**
 * Status defaults to `pending_work_email` when no work_email is given, else `ready`.
 * Server-side derivation so the UI can't lie about which bucket a row belongs to.
 */
function deriveStatus(input: CreateHrPendingInput): HrPendingStatus {
  return input.work_email && input.work_email.trim() !== ""
    ? "ready"
    : "pending_work_email";
}

export async function createHrPendingEmployee(
  input: CreateHrPendingInput,
): Promise<{ row: HrPendingEmployeeRow | null; error: string | null }> {
  const sb = client();
  const status = deriveStatus(input);

  const payload: Record<string, unknown> = {
    name: input.name.trim(),
    personal_email: input.personal_email.trim().toLowerCase(),
    work_email: input.work_email?.trim().toLowerCase() || null,
    department: input.department.trim(),
    job_description: input.job_description?.trim() || null,
    start_date: input.start_date || null,
    source: input.source?.trim() || null,
    phone: input.phone?.trim() || null,
    location: input.location?.trim() || null,
    regular_rate: input.regular_rate?.trim() || null,
    ot_rate: input.ot_rate?.trim() || null,
    notes: input.notes?.trim() || null,
    created_by: input.created_by?.trim().toLowerCase() || null,
    status,
  };

  const { data, error } = await sb
    .from(TABLE)
    .insert(payload)
    .select("*")
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as HrPendingEmployeeRow, error: null };
}

export async function updateHrPendingEmployee(
  id: number,
  input: UpdateHrPendingInput,
): Promise<{ row: HrPendingEmployeeRow | null; error: string | null }> {
  const sb = client();
  const payload: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v !== undefined) payload[k] = v;
  };
  set("name", input.name?.trim());
  set("personal_email", input.personal_email?.trim().toLowerCase());
  // work_email needs explicit null support so HR can clear it if mistyped.
  if (input.work_email !== undefined) {
    payload["work_email"] = input.work_email?.trim().toLowerCase() || null;
  }
  set("department", input.department?.trim());
  if (input.job_description !== undefined) {
    payload["job_description"] = input.job_description?.trim() || null;
  }
  if (input.start_date !== undefined) payload["start_date"] = input.start_date || null;
  if (input.source !== undefined) payload["source"] = input.source?.trim() || null;
  if (input.phone !== undefined) payload["phone"] = input.phone?.trim() || null;
  if (input.location !== undefined) payload["location"] = input.location?.trim() || null;
  if (input.regular_rate !== undefined)
    payload["regular_rate"] = input.regular_rate?.trim() || null;
  if (input.ot_rate !== undefined)
    payload["ot_rate"] = input.ot_rate?.trim() || null;
  if (input.notes !== undefined) payload["notes"] = input.notes?.trim() || null;
  if (input.status !== undefined) payload["status"] = input.status;

  // If work_email moved from null → set, auto-bump status from
  // pending_work_email → ready (don't downgrade explicit `cancelled` etc.).
  if (
    input.status === undefined &&
    input.work_email !== undefined &&
    input.work_email &&
    input.work_email.trim() !== ""
  ) {
    payload["status"] = "ready";
  }

  const { data, error } = await sb
    .from(TABLE)
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as HrPendingEmployeeRow, error: null };
}

export async function cancelHrPendingEmployee(
  id: number,
): Promise<{ error: string | null }> {
  const sb = client();
  const { error } = await sb
    .from(TABLE)
    .update({ status: "cancelled" })
    .eq("id", id);
  return { error: error?.message ?? null };
}

export async function deleteHrPendingEmployee(
  id: number,
): Promise<{ error: string | null }> {
  const sb = client();
  const { error } = await sb.from(TABLE).delete().eq("id", id);
  return { error: error?.message ?? null };
}

/**
 * Promotes a pending hire into `global_master_list`. Inserts a fresh master-list
 * row stamped with the current upload id (so it appears in `active_employees`),
 * then flips the staging row to `promoted` and stores the new master-list id.
 *
 * Refuses to promote a row that's missing `work_email` — Payroll mints the
 * @simple.biz address and that's the canonical join key for every other system.
 */
export async function promoteHrPendingEmployee(
  id: number,
): Promise<{
  row: HrPendingEmployeeRow | null;
  /** UUID of the new global_master_list row, or null when promotion failed. */
  masterId: string | null;
  error: string | null;
}> {
  const sb = client();

  const { data: pending, error: fetchErr } = await sb
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .single();
  if (fetchErr)
    return { row: null, masterId: null, error: fetchErr.message };
  const row = pending as HrPendingEmployeeRow;

  if (row.status === "promoted") {
    return {
      row,
      masterId: row.promoted_to_master_id ?? null,
      error: "Already promoted",
    };
  }
  if (row.status === "cancelled") {
    return { row, masterId: null, error: "Cannot promote a cancelled hire" };
  }
  if (!row.work_email) {
    return {
      row,
      masterId: null,
      error: "Work email is required before promoting to the master list",
    };
  }
  if (!row.orientation_attended_at) {
    return {
      row,
      masterId: null,
      error:
        "Orientation attendance has not been confirmed. The department manager must mark orientation from their Newly Hired tab before promotion.",
    };
  }

  const uploadId = await getCurrentMasterListUploadId(sb);
  if (!uploadId) {
    return {
      row,
      masterId: null,
      error:
        "No current master list upload found. Run a master-list upload first so new hires can attach to it.",
    };
  }

  // Master-list columns use mixed-case quoted identifiers ("Personal Email", etc.)
  // — see references/supabase_global_master_list.sql.
  const masterPayload = {
    "Department": row.department,
    "Name": row.name,
    "Personal Email": row.personal_email,
    "Work Email": row.work_email,
    "Start Date": row.start_date,
    first_seen_upload_id: uploadId,
    last_seen_upload_id: uploadId,
    source_file: "hr_dashboard_add_person",
  };

  const { data: inserted, error: insertErr } = await sb
    .from(MASTER_TABLE)
    .insert(masterPayload)
    .select("id")
    .single();
  if (insertErr)
    return { row, masterId: null, error: `Master insert failed: ${insertErr.message}` };

  // global_master_list.id is UUID — keep as string.
  const masterId = (inserted as { id: string }).id;

  const { data: promoted, error: promoteErr } = await sb
    .from(TABLE)
    .update({
      status: "promoted",
      promoted_at: new Date().toISOString(),
      promoted_to_master_id: masterId,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (promoteErr)
    return { row, masterId, error: `Status update failed: ${promoteErr.message}` };

  // Stamp the new hire's employee_id (YYMM-NNNN). Best-effort: a failure here
  // doesn't unwind the promotion — the next master-list upload or the admin
  // backfill route will pick the row up.
  try {
    const { backfillEmployeeIds } = await import("./backfill-employee-ids");
    await backfillEmployeeIds(sb);
  } catch (e) {
    console.warn(
      `[promoteHrPendingEmployee] employee_id stamp skipped: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  return { row: promoted as HrPendingEmployeeRow, masterId, error: null };
}

/**
 * Manager dashboard fetch: every pending hire in any of the manager's
 * departments that is still actionable (not promoted, not cancelled). Used by
 * `/api/manager/pending-hires` to feed the My Team → Newly Hired tab.
 *
 * Case-insensitive department match; `departments` is the list returned by
 * `listDepartmentsForManager(managerEmail)`.
 */
export async function listManagerPendingHires(
  departments: string[],
): Promise<{ rows: HrPendingEmployeeRow[]; error: string | null }> {
  if (departments.length === 0) return { rows: [], error: null };
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .in("status", ["pending_work_email", "ready"])
    .order("created_at", { ascending: false })
    .range(0, 499);
  if (error) return { rows: [], error: error.message };
  // Department comparison is case-insensitive/trim-tolerant since hr_pending_employees
  // stores whatever the AddPersonDialog typed but department_managers may
  // capitalize differently.
  const wanted = new Set(departments.map((d) => d.trim().toLowerCase()));
  const rows = ((data ?? []) as HrPendingEmployeeRow[]).filter((r) =>
    wanted.has((r.department ?? "").trim().toLowerCase()),
  );
  return { rows, error: null };
}

/**
 * Manager stamps orientation as attended. Caller is responsible for verifying
 * (at the route layer) that `markedBy` actually manages the hire's department
 * — this function only writes the row. Idempotent: re-marking just updates
 * the timestamp + note.
 */
export async function markPendingHireOrientation(
  id: number,
  args: { markedBy: string; note?: string | null },
): Promise<{ row: HrPendingEmployeeRow | null; error: string | null }> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .update({
      orientation_attended_at: new Date().toISOString(),
      orientation_attended_by: args.markedBy.trim().toLowerCase(),
      orientation_note: args.note?.trim() || null,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as HrPendingEmployeeRow, error: null };
}

/** Manager unmarks orientation (typo / changed mind). Clears all 3 columns. */
export async function clearPendingHireOrientation(
  id: number,
): Promise<{ row: HrPendingEmployeeRow | null; error: string | null }> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .update({
      orientation_attended_at: null,
      orientation_attended_by: null,
      orientation_note: null,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as HrPendingEmployeeRow, error: null };
}

