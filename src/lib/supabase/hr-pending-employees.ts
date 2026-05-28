import { randomUUID } from "crypto";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./server";
import { getCurrentMasterListUploadId } from "./global-master-list-db";
import { getHrOnboardingSubmissionById } from "./hr-onboarding-submissions";

/**
 * Maps an onboarding submission's payment details onto the `employee_ids`
 * payout columns the employee portal reads, so a hire promoted from an
 * onboarding form sees their bank/processor details pre-filled on first login
 * instead of an empty Settings form. Only returns the columns we actually have
 * values for. Returns null when there's nothing worth writing.
 */
function onboardingPayoutPatch(sub: {
  payment_method: string | null;
  hurupay_email: string | null;
  bank_full_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_swift_code: string | null;
  bank_full_address: string | null;
  phone: string | null;
}): Record<string, string> | null {
  const patch: Record<string, string> = {};
  const set = (k: string, v: string | null | undefined) => {
    const t = (v ?? "").trim();
    if (t) patch[k] = t;
  };

  if (sub.payment_method === "hurupay") {
    patch["preferred_processor"] = "hurupay";
    set("hurupay_email", sub.hurupay_email);
  } else if (sub.payment_method === "wires") {
    patch["preferred_processor"] = "wires";
    set("bank_name", sub.bank_full_name);
    set("account_holder_name", sub.bank_account_name);
    set("account_number", sub.bank_account_number);
    set("swift_code", sub.bank_swift_code);
    set("full_address", sub.bank_full_address);
  }
  set("phone_number", sub.phone);

  return Object.keys(patch).length > 0 ? patch : null;
}

const TABLE = "hr_pending_employees";
const MASTER_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";
const RATES_TABLE =
  process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() ||
  "employee_hourly_rates";

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
  /** Provenance back-link when this hire was spun up from a submitted
   *  onboarding form (null for "Add person" hires). */
  onboarding_submission_id: string | null;
  /** Hubstaff project names picked at staging; sent to the invite webhook on promote. */
  project_names: string[] | null;
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
  onboarding_submission_id?: string | null;
  project_names?: string[] | null;
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
    onboarding_submission_id: input.onboarding_submission_id ?? null,
    project_names: Array.isArray(input.project_names)
      ? input.project_names.map((p) => String(p).trim()).filter(Boolean)
      : [],
    status,
  };

  const { data, error } = await sb
    .from(TABLE)
    .insert(payload)
    .select("*")
    .single();
  if (error) {
    // Graceful fallback if the project_names column migration
    // (references/add_project_names_to_hr_pending.sql) hasn't been run yet —
    // retry without it so staging still works (projects just won't persist).
    if (/project_names/i.test(error.message)) {
      const { project_names: _omit, ...rest } = payload;
      void _omit;
      const retry = await sb.from(TABLE).insert(rest).select("*").single();
      if (retry.error) return { row: null, error: retry.error.message };
      return { row: retry.data as HrPendingEmployeeRow, error: null };
    }
    return { row: null, error: error.message };
  }
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

/**
 * Reverses a promotion: flips a `promoted` staging row back to `ready` so HR can
 * re-promote (e.g. after fixing details). Clears `promoted_at` +
 * `promoted_to_master_id`. Does NOT remove the `global_master_list` row the
 * original promote created — the person stays in the master list, and a later
 * re-promote reuses that row (idempotent, by personal email + department). Only
 * a `promoted` row can be reverted.
 */
export async function revertHrPendingEmployeeToReady(
  id: number,
): Promise<{ row: HrPendingEmployeeRow | null; error: string | null }> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .update({ status: "ready", promoted_at: null, promoted_to_master_id: null })
    .eq("id", id)
    .eq("status", "promoted")
    .select("*")
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  if (!data)
    return { row: null, error: "Only a promoted hire can be sent back to Ready." };
  return { row: data as HrPendingEmployeeRow, error: null };
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
  /** Outcome of the best-effort master Google Sheet append (null until reached). */
  sheet?: { appended: boolean; reason?: string } | null;
  /** Outcome of the best-effort Hubstaff-invite webhook (null until reached). */
  hubstaff?: { ok: boolean; error?: string } | null;
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

  // Idempotency: global_master_list has a unique index on
  // (LOWER("Personal Email"), LOWER("Department")). A row for this person+dept
  // may already exist — e.g. an earlier promote inserted the master row but a
  // later step failed (pending row still 'ready'), or the person was added from
  // another source. Reuse that row instead of failing on the duplicate key.
  let masterId: string;
  const { data: existingMaster, error: existingErr } = await sb
    .from(MASTER_TABLE)
    .select("id")
    .ilike("Personal Email", row.personal_email)
    .ilike("Department", row.department)
    .limit(1)
    .maybeSingle();
  if (existingErr)
    return { row, masterId: null, error: `Master lookup failed: ${existingErr.message}` };

  if (existingMaster) {
    masterId = (existingMaster as { id: string }).id;
    // Make sure the reused row is attached to the current upload so it shows in
    // active_employees, and refresh the work email in case it was just minted.
    await sb
      .from(MASTER_TABLE)
      .update({ last_seen_upload_id: uploadId, "Work Email": row.work_email })
      .eq("id", masterId);
  } else {
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
    masterId = (inserted as { id: string }).id;
  }

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

  // Pre-fill the hire's payout details (incl. the Hurupay email they entered on
  // the onboarding form) into the `employee_ids` table so their employee-portal
  // Profile > payment section is pre-filled on first login. The profile reads
  // this table via /api/employee-ids. Crucially this UPSERTS: a freshly promoted
  // hire usually has NO employee_ids row yet (backfillEmployeeIds only stamps
  // global_master_list.employee_id, not this table), so a plain UPDATE would
  // silently write nothing. Best-effort: a failure never unwinds the promotion.
  if (row.onboarding_submission_id) {
    try {
      const { row: sub } = await getHrOnboardingSubmissionById(
        row.onboarding_submission_id,
      );
      if (sub) {
        const patch = onboardingPayoutPatch({
          payment_method: sub.payment_method,
          hurupay_email: sub.hurupay_email,
          bank_full_name: sub.bank_full_name,
          bank_account_name: sub.bank_account_name,
          bank_account_number: sub.bank_account_number,
          bank_swift_code: sub.bank_swift_code,
          bank_full_address: sub.bank_full_address,
          phone: sub.phone ?? row.phone,
        });
        if (patch) {
          const { data: existingIds } = await sb
            .from("employee_ids")
            .select("employee_id")
            .eq("work_email", row.work_email)
            .limit(1);
          if (existingIds && existingIds.length > 0) {
            const { error: payoutErr } = await sb
              .from("employee_ids")
              .update(patch)
              .eq("work_email", row.work_email);
            if (payoutErr) {
              console.warn(
                `[promoteHrPendingEmployee] payout pre-fill (update) skipped: ${payoutErr.message}`,
              );
            }
          } else {
            // No employee_ids row yet — create one so the prefill lands. Reuse
            // the YYMM-NNNN id backfill stamped on the master row; fall back to a
            // SELF- id if it isn't there.
            const { data: masterRow } = await sb
              .from(MASTER_TABLE)
              .select("employee_id")
              .eq("id", masterId)
              .maybeSingle();
            const employeeId =
              (masterRow as { employee_id?: string | null } | null)?.employee_id?.trim() ||
              `SELF-${randomUUID().replace(/-/g, "").slice(0, 14).toUpperCase()}`;
            const { error: insertIdErr } = await sb.from("employee_ids").insert({
              employee_id: employeeId,
              name: row.name,
              work_email: row.work_email,
              personal_email: row.personal_email,
              ...patch,
            });
            if (insertIdErr) {
              console.warn(
                `[promoteHrPendingEmployee] payout pre-fill (insert) skipped: ${insertIdErr.message}`,
              );
            }
          }
        }
      }
    } catch (e) {
      console.warn(
        `[promoteHrPendingEmployee] payout pre-fill skipped: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // Seed the hire's hourly rates so Regular Rate / OT Rate exist (and stay
  // editable) the moment they log in. Only inserts when there's no existing
  // rates row for this work email — never clobbers rates the hire already has.
  // Best-effort: a failure here never unwinds the promotion.
  if (row.regular_rate || row.ot_rate) {
    try {
      // Use limit(1) (not maybeSingle) — maybeSingle errors if duplicate rate
      // rows already exist for this email, which would mask the check.
      const { data: existingRates } = await sb
        .from(RATES_TABLE)
        .select("id")
        .eq("Work Email", row.work_email)
        .limit(1);
      if (!existingRates || existingRates.length === 0) {
        // NOTE: employee_hourly_rates has no "Name" column — only Work/Personal
        // Email, Department, Regular/OT Rate (see the table schema).
        const { error: rateErr } = await sb.from(RATES_TABLE).insert({
          "Work Email": row.work_email,
          "Personal Email": row.personal_email,
          "Department": row.department,
          "Regular Rate": row.regular_rate,
          "OT Rate": row.ot_rate,
        });
        if (rateErr) {
          console.warn(
            `[promoteHrPendingEmployee] rate seed skipped: ${rateErr.message}`,
          );
        }
      }
    } catch (e) {
      console.warn(
        `[promoteHrPendingEmployee] rate seed skipped: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // Append the hire to the master Google Sheet so the next Sheet -> Supabase
  // sync keeps them in `active_employees` (the sync only pulls; it never adds
  // in-app promotions back to the Sheet). Best-effort + idempotent (the helper
  // skips if the hire's work/personal email is already on the Sheet) — a
  // failure here (e.g. service account lacks Editor access) never unwinds the
  // promotion.
  let sheet: { appended: boolean; reason?: string } | null = null;
  try {
    const { appendMasterSheetRow } = await import(
      "../google-sheets/append-master-sheet"
    );
    sheet = await appendMasterSheetRow({
      name: row.name,
      personalEmail: row.personal_email,
      workEmail: row.work_email,
      department: row.department,
      startDate: row.start_date,
    });
    if (!sheet.appended) {
      console.warn(
        `[promoteHrPendingEmployee] master-sheet append skipped: ${sheet.reason ?? "unknown"}`,
      );
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    sheet = { appended: false, reason };
    console.warn(`[promoteHrPendingEmployee] master-sheet append skipped: ${reason}`);
  }

  // Invite the hire to the Hubstaff workspace via the n8n automation, using the
  // projects HR picked at staging (persisted on the row) + the hire's rate.
  // Best-effort: a failure here never unwinds the promotion.
  let hubstaff: { ok: boolean; error?: string } | null = null;
  try {
    const { inviteHubstaffUser } = await import("../hr/hubstaff-invite");
    const payRate =
      row.regular_rate != null && Number.isFinite(Number(row.regular_rate))
        ? Number(row.regular_rate)
        : null;
    hubstaff = await inviteHubstaffUser({
      workEmail: row.work_email,
      projectNames: Array.isArray(row.project_names) ? row.project_names : [],
      payRate,
    });
    if (!hubstaff.ok) {
      console.warn(
        `[promoteHrPendingEmployee] hubstaff invite failed: ${hubstaff.error ?? "unknown"}`,
      );
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    hubstaff = { ok: false, error: err };
    console.warn(`[promoteHrPendingEmployee] hubstaff invite failed: ${err}`);
  }

  return { row: promoted as HrPendingEmployeeRow, masterId, error: null, sheet, hubstaff };
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
  // Department comparison is case-insensitive/trim-tolerant: hr_pending_employees
  // stores whatever was typed during intake, but department_managers may capitalize differently.
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

