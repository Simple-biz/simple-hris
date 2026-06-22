import { randomUUID } from "crypto";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./server";
import { getCurrentMasterListUploadId } from "./global-master-list-db";
import { getHrOnboardingSubmissionById } from "./hr-onboarding-submissions";
import { normalizeDeptToKey } from "../payroll/normalize-dept-key";

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

/**
 * Renders a full timestamptz as a YYYY-MM-DD calendar date in the company
 * timezone (Asia/Manila). Used to derive a hire's Start Date from the moment
 * their manager marked orientation: a UTC timestamp like 23:30 the night before
 * would otherwise roll the date back a day. Returns null for empty/invalid input.
 */
function manilaDateFromIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA formats as YYYY-MM-DD, which matches the master list's Start Date.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Inverse of `manilaDateFromIso`: takes a YYYY-MM-DD calendar date and returns
 * the UTC ISO timestamp for the start of that day in Manila (fixed UTC+8, no
 * DST). Storing this in `orientation_attended_at` makes the date round-trip
 * cleanly back through `manilaDateFromIso` at promote time. Returns null for
 * empty or malformed input.
 */
function manilaDateStartToIso(date: string | null | undefined): string | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
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
  | "cancelled"
  | "no_show"
  // Promote ran but a step failed (master insert/lookup, status write, or the
  // Google Sheet append). The row is NOT on the master list end-to-end; the HR
  // dashboard shows a red pill and lets the user retry (idempotent). See
  // references/add_failed_to_promote_status_to_hr_pending.sql.
  | "failed_to_promote";

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
  /** Set when a manager marks "Did not attend orientation" (status -> no_show). */
  no_show_at: string | null;
  no_show_by: string | null;
  no_show_note: string | null;
  /** Non-Lead-Gen no-show hard-delete timer (Lead Gen deletes immediately).
   *  The scheduled-deletion cron drains these alongside global_master_list. */
  scheduled_deletion_at: string | null;
  deletion_processed_at: string | null;
  /** Provenance back-link when this hire was spun up from a submitted
   *  onboarding form (null for "Add person" hires). */
  onboarding_submission_id: string | null;
  /** Hubstaff project names picked at staging; sent to the invite webhook on promote. */
  project_names: string[] | null;
  /** DERIVED (not a column): the hire's country, pulled from their linked
   *  onboarding submission (the pending table stores no country). Prefers the
   *  country the hire selected, falling back to the invite country; null for
   *  manually-added hires with no submission. Set by listHrPendingEmployees. */
  country?: string | null;
};

/**
 * SECURITY: a staged-hire row carries the catalog-resolved `regular_rate`/
 * `ot_rate`. Those figures are needed server-side (the Hubstaff onboarding
 * webhook rejects a 0 rate), but pay rates are Accounting/CEO only — they must
 * never reach an HR or Manager client. Call this at every route boundary that
 * returns a pending row to the browser, passing whether the caller has full rate
 * visibility (admin/accounting/ceo via `hasRateVisibility`). Returns the row
 * untouched for rate-visible callers; nulls the two figures otherwise.
 */
export function redactPendingRowRates(
  row: HrPendingEmployeeRow | null,
  rateVisible: boolean,
): HrPendingEmployeeRow | null {
  if (!row || rateVisible) return row;
  return { ...row, regular_rate: null, ot_rate: null };
}

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
export async function getHrPendingEmployeeById(
  id: number,
): Promise<{ row: HrPendingEmployeeRow | null; error: string | null }> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: (data ?? null) as HrPendingEmployeeRow | null, error: null };
}

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
  const rows = (data ?? []) as HrPendingEmployeeRow[];

  // Enrich each hire with the country from their linked onboarding submission
  // (the pending table has no country column). Prefer the hire-selected country,
  // fall back to the invite country. Best-effort: a lookup failure just leaves
  // country null, and manually-added hires (no submission) stay null too.
  const subIds = Array.from(
    new Set(
      rows
        .map((r) => r.onboarding_submission_id)
        .filter((v): v is string => !!v),
    ),
  );
  if (subIds.length > 0) {
    try {
      const { data: subs } = await sb
        .from("hr_onboarding_submissions")
        .select("id, country, invite_country")
        .in("id", subIds);
      const byId = new Map<string, string | null>();
      for (const s of (subs ?? []) as {
        id: string;
        country: string | null;
        invite_country: string | null;
      }[]) {
        byId.set(s.id, s.country ?? s.invite_country ?? null);
      }
      for (const r of rows) {
        r.country = r.onboarding_submission_id
          ? byId.get(r.onboarding_submission_id) ?? null
          : null;
      }
    } catch {
      /* leave country null */
    }
  }

  return { rows, error: null };
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

/**
 * Soft-cancels a staged hire: flips status to 'cancelled' so it drops out of the
 * active buckets but stays visible in the Cancelled tab. The cancel route also
 * tears down the Workspace account + archives the linked onboarding submission;
 * pass `deletionProcessedAt` (now()) when an account teardown was fired so the
 * row records the deletion as handled (and never gets re-picked by the
 * scheduled-deletion cron).
 */
export async function cancelHrPendingEmployee(
  id: number,
  opts: { deletionProcessedAt?: string | null } = {},
): Promise<{ error: string | null }> {
  const sb = client();
  const payload: Record<string, unknown> = { status: "cancelled" };
  if (opts.deletionProcessedAt !== undefined) {
    payload["deletion_processed_at"] = opts.deletionProcessedAt;
    payload["scheduled_deletion_at"] = null;
  }
  const { error } = await sb.from(TABLE).update(payload).eq("id", id);
  return { error: error?.message ?? null };
}

/**
 * Reverses a promotion: flips a `promoted` staging row back to `ready` so HR can
 * re-promote (e.g. after fixing details). Clears `promoted_at` +
 * `promoted_to_master_id` AND removes the hire from the master list — both the
 * `global_master_list` row the promote created and the master Google Sheet row —
 * so a hire sent back to Ready stops showing as an active employee until they're
 * re-promoted (re-promote re-inserts + re-appends them fresh). Only a `promoted`
 * row can be reverted.
 */
export async function revertHrPendingEmployeeToReady(
  id: number,
): Promise<{ row: HrPendingEmployeeRow | null; error: string | null }> {
  const sb = client();

  // Capture the master link + identity BEFORE the update nulls promoted_to_master_id.
  const { data: before, error: beforeErr } = await sb
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (beforeErr) return { row: null, error: beforeErr.message };
  const prev = (before ?? null) as HrPendingEmployeeRow | null;

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

  // Pull them out of the master list (DB + Sheet). Best-effort: the status flip
  // already succeeded, so a cleanup failure shouldn't fail the whole revert —
  // it's logged and the row can be removed manually / on the next reconcile.
  if (prev) await removeFromMasterList(sb, prev);

  return { row: data as HrPendingEmployeeRow, error: null };
}

/**
 * Deletes a hire's master-list footprint: the `global_master_list` row (matched
 * by the promote link, falling back to the canonical (Work Email, Department))
 * and the master Google Sheet row(s) (matched by email). Used by "Back to Ready".
 * Best-effort and self-contained — never throws; failures are logged.
 */
async function removeFromMasterList(
  sb: ReturnType<typeof client>,
  row: HrPendingEmployeeRow,
): Promise<void> {
  try {
    if (row.promoted_to_master_id) {
      await sb.from(MASTER_TABLE).delete().eq("id", row.promoted_to_master_id);
    } else if (row.work_email) {
      // No stored link (e.g. an earlier promote reused a CSV row): match the
      // canonical key. (Work Email, Department) is unique, so this is precise.
      await sb
        .from(MASTER_TABLE)
        .delete()
        .ilike("Work Email", row.work_email)
        .ilike("Department", row.department);
    }
  } catch (e) {
    console.warn(
      `[removeFromMasterList] master DB delete skipped: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  try {
    const { deleteMasterSheetRowsByEmail } = await import(
      "../google-sheets/delete-master-sheet-rows"
    );
    await deleteMasterSheetRowsByEmail(row.personal_email, row.work_email ?? undefined);
  } catch (e) {
    console.warn(
      `[removeFromMasterList] master-sheet delete skipped: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
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
  opts: { skipBackfill?: boolean; skipSheet?: boolean; deferStatus?: boolean } = {},
): Promise<{
  row: HrPendingEmployeeRow | null;
  /** UUID of the new global_master_list row, or null when promotion failed. */
  masterId: string | null;
  error: string | null;
  /** Outcome of the best-effort master Google Sheet append (null until reached). */
  sheet?: { appended: boolean; reason?: string } | null;
  /** Manila Start Date stamped on the master row. Returned so the bulk-promote
   *  path can append all hires to the Google Sheet in one batched call instead
   *  of one-read-per-hire (see opts.skipSheet). Null only on early failures. */
  startDate?: string | null;
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
  if (row.status === "no_show") {
    return {
      row,
      masterId: null,
      error:
        "Cannot promote a no-show hire. They were marked as not attending orientation and their accounts were torn down; re-onboard them instead.",
    };
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

  // The hire's official Start Date is the day they actually attended
  // orientation (stamped by the manager when they marked it above — guaranteed
  // non-null here by the orientation guard), NOT the tentative start_date typed
  // at staging. Rendered as a Manila calendar date so an evening-UTC mark keeps
  // the right day. Falls back to the staged start_date only if the timestamp is
  // somehow unparseable.
  const startDate =
    manilaDateFromIso(row.orientation_attended_at) ?? row.start_date;

  const uploadId = await getCurrentMasterListUploadId(sb);
  if (!uploadId) {
    return {
      row,
      masterId: null,
      error:
        "No current master list upload found. Run a master-list upload first so new hires can attach to it.",
    };
  }

  // Idempotency keyed on Work Email — the canonical, globally-unique identity
  // join key (minted by Payroll; required above). We deliberately DO NOT match
  // on (Personal Email, Department): a personal email is NOT unique — the same
  // address can belong to multiple distinct work accounts (a person re-onboarded
  // under a new @simple.biz address, a shared personal inbox, an admin testing
  // with a second account). Matching on it would reattach THIS hire to a
  // DIFFERENT person's master row and overwrite their Work Email — hijacking
  // their entire identity, since name/department/start date/profile photo/
  // commendations all resolve through this one row.
  //
  // A row for this exact work email may legitimately already exist (an earlier
  // promote inserted the master row but a later step failed and left the pending
  // row 'ready', or a master-list CSV already listed them). Reuse THAT row; never
  // reassign someone else's. Work Email is the match key, so it's already
  // correct — we don't rewrite it.
  // Keyed on (Work Email, Department): a person can hold one master row per
  // department, so the work email alone isn't the row key — the department
  // disambiguates. This mirrors the (Work Email, Department) uniqueness the
  // schema now enforces.
  let masterId: string;
  const { data: existingMaster, error: existingErr } = await sb
    .from(MASTER_TABLE)
    .select("id")
    .ilike("Work Email", row.work_email)
    .ilike("Department", row.department)
    .limit(1)
    .maybeSingle();
  if (existingErr)
    return { row, masterId: null, error: `Master lookup failed: ${existingErr.message}` };

  if (existingMaster) {
    masterId = (existingMaster as { id: string }).id;
    // Attach the reused row to the current upload so it shows in active_employees,
    // and (re)stamp Start Date to the orientation date in case this is a
    // re-promote after a fix. Never rewrites identity fields (Work Email etc.).
    await sb
      .from(MASTER_TABLE)
      .update({ last_seen_upload_id: uploadId, "Start Date": startDate })
      .eq("id", masterId);
  } else {
    // Master-list columns use mixed-case quoted identifiers ("Personal Email", etc.)
    // — see references/supabase_global_master_list.sql.
    const masterPayload: Record<string, unknown> = {
      "Department": row.department,
      "Name": row.name,
      "Personal Email": row.personal_email,
      "Work Email": row.work_email,
      "Start Date": startDate,
      first_seen_upload_id: uploadId,
      last_seen_upload_id: uploadId,
      source_file: "hr_dashboard_add_person",
    };
    if (row.phone) masterPayload["Phone Number"] = row.phone;
    if (row.location) masterPayload["Location"] = row.location;

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

  // NOTE: the status flip to 'promoted' is deliberately NOT done here. It is the
  // LAST step, and it's gated on the Google Sheet write succeeding (see the end
  // of this function). Marking 'promoted' before the Sheet append meant a hire
  // could show as Promoted while never reaching the source-of-truth Sheet and
  // then silently drop out on the next sync. The master-list row above already
  // exists, so the side-effects below (which only need `masterId`) run now; the
  // pending row stays 'ready' until we know the outcome.

  // Stamp the new hire's employee_id (YYMM-NNNN). Best-effort: a failure here
  // doesn't unwind the promotion — the next master-list upload or the admin
  // backfill route will pick the row up. `skipBackfill` is used by the Lead-Gen
  // bulk promote, which runs backfillEmployeeIds ONCE after its loop instead of
  // once per hire (the backfill re-scans the whole roster on every call).
  if (!opts.skipBackfill) {
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
  // The bulk-promote path passes skipSheet:true and appends every hire to the
  // Sheet in ONE batched call after its loop (appendMasterSheetRows), so it
  // doesn't re-read the whole sheet once per hire.
  let sheet: { appended: boolean; reason?: string } | null = null;
  if (!opts.skipSheet) {
    try {
      const { appendMasterSheetRow } = await import(
        "../google-sheets/append-master-sheet"
      );
      sheet = await appendMasterSheetRow({
        name: row.name,
        personalEmail: row.personal_email,
        workEmail: row.work_email,
        department: row.department,
        startDate,
        phoneNumber: row.phone ?? undefined,
        location: row.location ?? undefined,
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
  }

  // NOTE: The Hubstaff invite + Roboform emails are now fired by the combined
  // create-workspace-account webhook at work-email-set time, NOT at promote
  // time. Promote is master-list-only. See src/lib/hr/workspace-account.ts.

  // The bulk-promote path defers the status flip: it appends every hire to the
  // Sheet in one batched call AFTER this returns, then calls
  // setHrPromotionOutcome() per hire with that batch's per-row result. So leave
  // the pending row 'ready' and hand back the masterId + startDate it needs.
  if (opts.deferStatus) {
    return { row, masterId, error: null, sheet, startDate };
  }

  // Single-promote path: the Sheet write ran inline above, so we know the
  // outcome. A hire is only 'promoted' when it reached the Sheet end-to-end
  // (or was already on it). Any real Sheet failure -> 'failed_to_promote' so
  // the row shows a red, retryable pill instead of a misleading Promoted badge.
  const sheetOk = sheetWriteSucceeded(sheet);
  const { row: finalized, error: finalizeErr } = await setHrPromotionOutcome(id, {
    promoted: sheetOk,
    masterId,
  });
  if (finalizeErr)
    return { row, masterId, error: `Status update failed: ${finalizeErr}`, sheet, startDate };
  if (!sheetOk) {
    return {
      row: finalized ?? row,
      masterId,
      error: `Added to the master list, but the Google Sheet write failed (${
        sheet?.reason ?? "unknown error"
      }). Marked "Failed to promote" — retry once the Sheet is reachable.`,
      sheet,
      startDate,
    };
  }
  return { row: finalized ?? row, masterId, error: null, sheet, startDate };
}

/**
 * True when a best-effort master-Sheet append result means the hire is on the
 * Sheet: either we just wrote the row, or it was already present (idempotent
 * skip). A null result means the Sheet step was skipped entirely (bulk path) —
 * treated as "not confirmed here". Any other { appended:false } is a real
 * failure (env not configured, read/write/permission error).
 */
export function sheetWriteSucceeded(
  sheet: { appended: boolean; reason?: string } | null | undefined,
): boolean {
  if (!sheet) return false;
  return sheet.appended || sheet.reason === "already present in sheet";
}

/**
 * Finalizes a promote's status once the master-Sheet outcome is known. This is
 * the ONLY place a pending row flips to 'promoted', and it only does so when
 * `promoted` is true (master row + Sheet row both landed). Otherwise it sets
 * 'failed_to_promote' so the HR dashboard shows a red, retryable pill — the
 * master-list row may already exist in Supabase, but a retry reuses it
 * idempotently, so this is safe to call repeatedly.
 *
 * Used by both the single-promote path (above) and the batched bulk-promote
 * route after its one-shot Sheet append.
 */
export async function setHrPromotionOutcome(
  id: number,
  opts: { promoted: boolean; masterId: string | null },
): Promise<{ row: HrPendingEmployeeRow | null; error: string | null }> {
  const sb = client();
  const patch: Record<string, unknown> = opts.promoted
    ? {
        status: "promoted",
        promoted_at: new Date().toISOString(),
        promoted_to_master_id: opts.masterId,
      }
    : {
        status: "failed_to_promote",
        // Keep the link if we got far enough to create/find the master row, so a
        // later "Back to Ready" can still unwind it; clear promoted_at.
        promoted_at: null,
        ...(opts.masterId ? { promoted_to_master_id: opts.masterId } : {}),
      };
  const { data, error } = await sb
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return { row: null, error: error.message };
  return { row: data as HrPendingEmployeeRow, error: null };
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
 *
 * `attendedOn` is the calendar date the manager picked (YYYY-MM-DD). It's
 * anchored at the start of that day in Manila (the company tz, fixed UTC+8) so
 * that when promote later renders it back to a Manila date for the master
 * list's Start Date, it round-trips to the exact day chosen. Omitted/invalid
 * input falls back to now() (the legacy "marked just now" behaviour).
 */
export async function markPendingHireOrientation(
  id: number,
  args: { markedBy: string; note?: string | null; attendedOn?: string | null },
): Promise<{ row: HrPendingEmployeeRow | null; error: string | null }> {
  const sb = client();
  const attendedAt = manilaDateStartToIso(args.attendedOn) ?? new Date().toISOString();
  const { data, error } = await sb
    .from(TABLE)
    .update({
      orientation_attended_at: attendedAt,
      orientation_attended_by: args.markedBy.trim().toLowerCase(),
      orientation_note: args.note?.trim() || null,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return { row: null, error: error.message };

  // The orientation date IS the hire's Start Date. If they've already been
  // promoted into the master list, propagate the (possibly edited) date to both
  // the master DB row and the source Google Sheet so the next sync doesn't
  // overwrite it. Best-effort: a hire still in staging simply has no master row
  // yet, and any failure here never fails the orientation mark itself.
  const updated = data as HrPendingEmployeeRow;
  await syncStartDateToMaster(sb, updated, manilaDateFromIso(attendedAt));

  return { row: updated, error: null };
}

/**
 * Pushes a hire's Start Date (their orientation date) to the master DB row and
 * the master Google Sheet, but only when a master row already exists for them
 * (i.e. they've been promoted). No-op + swallow-on-error by design — this is a
 * convenience sync, never a gate.
 */
async function syncStartDateToMaster(
  sb: ReturnType<typeof client>,
  row: HrPendingEmployeeRow,
  startDate: string | null,
): Promise<void> {
  if (!row.work_email || !startDate) return;
  try {
    const { data: master } = await sb
      .from(MASTER_TABLE)
      .select("id")
      .ilike("Work Email", row.work_email)
      .ilike("Department", row.department)
      .limit(1)
      .maybeSingle();
    if (!master) return; // not promoted yet — nothing in the master list/sheet

    await sb
      .from(MASTER_TABLE)
      .update({ "Start Date": startDate })
      .eq("id", (master as { id: string }).id);

    const { updateMasterSheetStartDate } = await import(
      "../google-sheets/update-master-sheet-start-date"
    );
    const res = await updateMasterSheetStartDate({
      workEmail: row.work_email,
      personalEmail: row.personal_email,
      startDate,
    });
    if (!res.updated) {
      console.warn(
        `[syncStartDateToMaster] sheet Start Date not updated: ${res.reason ?? "unknown"}`,
      );
    }
  } catch (e) {
    console.warn(
      `[syncStartDateToMaster] skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Manager marks a staged hire as "Did not attend orientation" -> status='no_show'.
 * Records who/when/note (mirrors the orientation markers). Idempotent. This ONLY
 * writes the row; the caller (the no-show route) is responsible for firing the
 * department-aware account teardown. Refuses to no-show an already-promoted hire
 * (they're in the master list — use the normal Offboard flow for those).
 */
export async function markPendingHireNoShow(
  id: number,
  args: {
    markedBy: string;
    note?: string | null;
    /** Non-Lead-Gen: now()+14d. Lead Gen: null (deleted immediately). */
    scheduledDeletionAt?: string | null;
    /** Lead Gen: stamp now() (delete fired immediately, nothing left to do). */
    deletionProcessedAt?: string | null;
  },
): Promise<{ row: HrPendingEmployeeRow | null; error: string | null }> {
  const sb = client();
  const payload: Record<string, unknown> = {
    status: "no_show",
    no_show_at: new Date().toISOString(),
    no_show_by: args.markedBy.trim().toLowerCase(),
    no_show_note: args.note?.trim() || null,
  };
  if (args.scheduledDeletionAt !== undefined)
    payload["scheduled_deletion_at"] = args.scheduledDeletionAt;
  if (args.deletionProcessedAt !== undefined)
    payload["deletion_processed_at"] = args.deletionProcessedAt;
  const { data, error } = await sb
    .from(TABLE)
    .update(payload)
    .eq("id", id)
    .neq("status", "promoted")
    .select("*")
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  if (!data)
    return {
      row: null,
      error:
        "Hire not found, or already promoted (promoted hires use the Offboard flow, not no-show).",
    };
  return { row: data as HrPendingEmployeeRow, error: null };
}

/**
 * Lead-Gen-only bulk promote pre-filter: every 'ready' hire in the Lead Gen
 * department that already satisfies the single-row promote gates (orientation
 * confirmed + work email present). Pre-filtering here means the bulk loop never
 * hits the orientation/work-email guards inside promoteHrPendingEmployee.
 */
export async function listReadyLeadGenHires(): Promise<{
  rows: HrPendingEmployeeRow[];
  error: string | null;
}> {
  const sb = client();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .eq("status", "ready")
    .not("orientation_attended_at", "is", null)
    .not("work_email", "is", null)
    .order("created_at", { ascending: true })
    .range(0, 999);
  if (error) return { rows: [], error: error.message };
  const rows = ((data ?? []) as HrPendingEmployeeRow[]).filter(
    (r) => normalizeDeptToKey(r.department) === "lead_gen",
  );
  return { rows, error: null };
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

