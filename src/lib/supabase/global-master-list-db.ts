import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseCsv } from "@/lib/csv/parse-csv";

const MASTER_LIST_UPLOADS_TABLE = "master_list_uploads";

/**
 * Returns the id of the master-list upload currently flagged `is_current`, or null
 * when no uploads have been recorded yet (fresh DB, pre-migration).
 */
export async function getCurrentMasterListUploadId(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { data, error } = await supabase
    .from(MASTER_LIST_UPLOADS_TABLE)
    .select("id")
    .eq("is_current", true)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  const id = (data as { id?: string } | null)?.id;
  return id ?? null;
}

/** Newest-first list of master-list upload batches (for the admin CSV imports tab). */
export async function listMasterListUploads(): Promise<
  {
    id: string;
    source_file: string | null;
    uploaded_at: string;
    uploaded_by: string | null;
    row_count: number | null;
    is_current: boolean;
  }[]
> {
  const supabase = requireServiceRole();
  const { data, error } = await supabase
    .from(MASTER_LIST_UPLOADS_TABLE)
    .select("id, source_file, uploaded_at, uploaded_by, row_count, is_current")
    .order("uploaded_at", { ascending: false });
  if (error) throw new Error(`Could not list master_list_uploads: ${error.message}`);
  return (data ?? []) as {
    id: string;
    source_file: string | null;
    uploaded_at: string;
    uploaded_by: string | null;
    row_count: number | null;
    is_current: boolean;
  }[];
}

function getMasterTableName(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE?.trim() || "global_master_list";
}

function requireServiceRole(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required to sync the global master list. Add it to .env (Supabase → Project Settings → API → service_role key).",
    );
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const tableColumnsFromSpecCache = new Map<string, Promise<string[]>>();

async function getTableColumnsFromSpec(table: string): Promise<string[]> {
  let cached = tableColumnsFromSpecCache.get(table);
  if (!cached) {
    cached = (async () => {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
      if (!url || !key) return [];
      try {
        const res = await fetch(`${url}/rest/v1/?apikey=${key}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!res.ok) return [];
        const spec = (await res.json()) as {
          definitions?: Record<string, { properties?: Record<string, unknown> }>;
        };
        const props = spec.definitions?.[table]?.properties;
        return props ? Object.keys(props) : [];
      } catch {
        return [];
      }
    })();
    tableColumnsFromSpecCache.set(table, cached);
  }
  return cached;
}

function normHeader(s: string): string {
  return s.trim().toLowerCase();
}

const MASTERLIST_MARKER = "MASTERLIST";

function rowLooksLikeHubstaffWeeklyHeader(headerRow: string[]): boolean {
  const h = headerRow.map(normHeader);
  const hasDept = h.includes("department");
  if (hasDept) return false;
  const hasMember = h.includes("member");
  const hasEmail = h.includes("email") || h.includes("work email");
  const hasWorked =
    h.some((c) => c.includes("total worked")) ||
    h.some((c) => c.includes("total hours")) ||
    h.includes("total hours");
  return hasMember && hasEmail && hasWorked;
}

/**
 * Enforces the MASTERLIST export layout:
 * - Rows 1–2 (0-based indices 0–1): at least one cell must contain `MASTERLIST` (case-insensitive).
 * - Row 3 (index 2): fixed header row — must have Department and Name or Personal Email.
 * - Rejects a typical Hubstaff weekly header on row 3.
 */
export function validateMasterListCsvLayout(grid: string[][]): { headerRowIndex: number } {
  if (grid.length < 3) {
    throw new Error(
      "Global master list CSV must have at least 3 rows: rows 1–2 identify the MASTERLIST sheet (include the text MASTERLIST), row 3 must be the column headers.",
    );
  }

  const row1 = grid[0] ?? [];
  const row2 = grid[1] ?? [];
  const hasMarker = [...row1, ...row2].some((cell) =>
    String(cell).toUpperCase().includes(MASTERLIST_MARKER),
  );
  if (!hasMarker) {
    throw new Error(
      'Rows 1–2 must identify this file as the MASTERLIST sheet: include the text MASTERLIST in any cell in those rows (e.g. export only the MASTERLIST tab from Excel so the title row is preserved). Do not upload Hubstaff or other sheets.',
    );
  }

  const headerRow = grid[2] ?? [];
  if (rowLooksLikeHubstaffWeeklyHeader(headerRow)) {
    throw new Error(
      "Row 3 looks like a Hubstaff timesheet header (Member / Email / Total hours). Export only the MASTERLIST sheet — row 3 should list Department, Name, Personal Email, Work Email, Start Date, etc.",
    );
  }

  const lowered = headerRow.map((c) => normHeader(c));
  const hasDept = lowered.some((c) => c === "department");
  const hasName = lowered.some((c) => c === "name");
  const hasPersonal =
    lowered.some((c) => c === "personal email") || lowered.some((c) => c === "personalemail");
  if (!hasDept || !(hasName || hasPersonal)) {
    throw new Error(
      "Row 3 must be the MASTERLIST header row with a Department column and Name or Personal Email columns.",
    );
  }

  return { headerRowIndex: 2 };
}

function rowIsEmptyForMappedColumns(row: string[], insertCols: { csvIdx: number; dbCol: string }[]): boolean {
  return insertCols.every(({ csvIdx }) => {
    const v = row[csvIdx] ?? "";
    return v.trim() === "";
  });
}

/** Alternate-work-email columns ("Alternate Work Email", "Alternate Work Email 2").
 *  The sheet may head both with the same text, so they can't be matched by name
 *  alone — they're mapped positionally instead (see resolveMasterColumnMapping). */
function isAlternateEmailHeader(h: string): boolean {
  const n = normHeader(h);
  return n.includes("alternate") && n.includes("email");
}

function resolveMasterColumnMapping(
  csvHeaders: string[],
  specCols: string[],
): { csvIdx: number; dbCol: string }[] {
  const specWithoutId = specCols.filter((c) => {
    const l = c.toLowerCase();
    return (
      l !== "id" &&
      l !== "import_batch_id" &&
      l !== "source_file" &&
      l !== "first_seen_upload_id" &&
      l !== "last_seen_upload_id"
    );
  });
  const usedSpec = new Set<string>();
  const insertCols: { csvIdx: number; dbCol: string }[] = [];

  // Reserve the alternate-email DB slots from the name-based pass below. The
  // sheet often heads both alternate columns with identical text, which the
  // name matcher can't disambiguate (it maps each DB column once, so the second
  // duplicate header would silently drop). We map them positionally afterwards.
  const altSpecCols = specWithoutId
    .filter((c) => isAlternateEmailHeader(c))
    .sort((a, b) => a.localeCompare(b));
  for (const c of altSpecCols) usedSpec.add(c);

  csvHeaders.forEach((rawH, csvIdx) => {
    const h = normHeader(rawH);
    if (!h) return;
    if (isAlternateEmailHeader(rawH)) return; // handled positionally below
    const match = specWithoutId.find(
      (db) => normHeader(db) === h && !usedSpec.has(db),
    );
    if (match) {
      usedSpec.add(match);
      insertCols.push({ csvIdx, dbCol: match });
    }
  });

  // Positional alternate-email mapping: the Nth alternate-email column in the
  // sheet maps to the Nth alternate-email DB slot, regardless of header text.
  const altCsvIdxs = csvHeaders
    .map((rawH, csvIdx) => ({ rawH, csvIdx }))
    .filter(({ rawH }) => isAlternateEmailHeader(rawH))
    .map(({ csvIdx }) => csvIdx);
  for (let i = 0; i < altCsvIdxs.length && i < altSpecCols.length; i++) {
    insertCols.push({ csvIdx: altCsvIdxs[i], dbCol: altSpecCols[i] });
  }

  return insertCols;
}

/** Finds the index in `insertCols` whose dbCol matches a given DB column (case-insensitive). */
function findMappingIndexByDbCol(
  insertCols: { csvIdx: number; dbCol: string }[],
  target: string,
): number {
  const t = target.toLowerCase();
  return insertCols.findIndex((c) => c.dbCol.toLowerCase() === t);
}

function normalizeEmail(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = String(v).trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

function normalizeDepartment(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = String(v).trim();
  return trimmed === "" ? null : trimmed;
}

/** `${personal_email_lc}|${department_lc}` — composite identity key for a roster row. */
function composeIdentityKey(personalEmail: string, department: string): string {
  return `${personalEmail}|${department.toLowerCase()}`;
}

/** Secondary reconcile key: work email is stable across personal-email corrections on the sheet. */
function composeWorkDeptKey(workEmailLower: string, department: string): string {
  return `${workEmailLower}|${department.trim().toLowerCase()}`;
}

type MasterReconcileRow = {
  id: unknown;
  "Personal Email": string | null;
  "Department": string | null;
  "Work Email": string | null;
  first_seen_upload_id: string | null;
  off_boarded_at: string | null;
};

type MasterListReconcileMatch =
  | {
      kind: "personal";
      id: unknown;
      off_boarded_at: string | null;
      first_seen_upload_id: string | null;
    }
  | { kind: "work"; row: MasterReconcileRow };

/** Paginated read — roster can exceed a single `.range(0, 9999)` window.
 *  Filters ONLY on Department (not Personal Email): a row can have a null personal
 *  email yet still hold a (Work Email, Department) pair that occupies the
 *  `global_master_list_work_email_dept_uniq` index — e.g. the manually-seeded US
 *  employees (seungyong/adrian/brandonb have null personal email) or prior orphan
 *  inserts. Excluding them here made them invisible to the work+dept collision guard,
 *  so a sheet row reusing their work email would still INSERT and hit the unique index. */
async function fetchAllMasterRowsForReconcile(
  supabase: SupabaseClient,
  table: string,
  selectCols: string,
): Promise<MasterReconcileRow[]> {
  const pageSize = 1000;
  const out: MasterReconcileRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(selectCols)
      .not('"Department"', "is", null)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Could not read ${table} for reconciliation: ${error.message}`);
    const batch = (data ?? []) as unknown as MasterReconcileRow[];
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

/** Builds an object `{ dbCol: value }` for a CSV row using the resolved column mapping. */
function csvRowToObject(
  row: string[],
  insertCols: { csvIdx: number; dbCol: string }[],
): Record<string, string | null> {
  const obj: Record<string, string | null> = {};
  for (const { csvIdx, dbCol } of insertCols) {
    const val = row[csvIdx] ?? "";
    obj[dbCol] = val === "" ? null : String(val);
  }
  return obj;
}

/** Creates a new master_list_uploads row with `is_current=false`, returns its id. */
async function createPendingMasterListUpload(
  supabase: SupabaseClient,
  sourceFile: string,
  rowCount: number,
): Promise<string> {
  const { data, error } = await supabase
    .from(MASTER_LIST_UPLOADS_TABLE)
    .insert({
      source_file: sourceFile || null,
      row_count: rowCount,
      is_current: false,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not create master_list_uploads row: ${error.message}`);
  const id = (data as { id?: string }).id;
  if (!id) throw new Error("master_list_uploads insert returned no id");
  return id;
}

/** Flips all prior uploads to `is_current=false` and sets this one to `true`. */
async function promoteMasterListUploadToCurrent(
  supabase: SupabaseClient,
  newUploadId: string,
): Promise<void> {
  const { error: clearErr } = await supabase
    .from(MASTER_LIST_UPLOADS_TABLE)
    .update({ is_current: false })
    .eq("is_current", true)
    .neq("id", newUploadId);
  if (clearErr) throw new Error(`Failed to clear prior current uploads: ${clearErr.message}`);

  const { error: setErr } = await supabase
    .from(MASTER_LIST_UPLOADS_TABLE)
    .update({ is_current: true })
    .eq("id", newUploadId);
  if (setErr) throw new Error(`Failed to mark upload ${newUploadId} current: ${setErr.message}`);
}

/**
 * Archives a new Master List CSV and reconciles the roster by the composite key
 * `(personal_email, department)`. Same personal_email = same human; different departments
 * for that human = multiple rows (dual-role). Work_email is NOT the identity key because
 * it gets recycled when employees offboard.
 *
 * Flow (no rows are deleted — history is preserved):
 *   1. Insert a `master_list_uploads` row (is_current=false) to stamp this batch.
 *   2. For every CSV row with a usable (personal_email, department) pair:
 *        • If that pair exists in `global_master_list`, UPDATE the row with the new
 *          CSV values and bump `last_seen_upload_id` to this upload.
 *        • Else if `(Work Email, Department)` uniquely matches a non-duplicate DB row
 *          (same department, case-insensitive work email), UPDATE that row — corrects
 *          personal-email drift between sheet and DB without orphaning the old row.
 *        • Otherwise INSERT a new row with `first_seen = last_seen = this upload`.
 *   3. Rows missing personal_email are INSERTED without dedupe (counted separately so
 *      HR can patch them later).
 *   4. Assignments NOT in this CSV keep their old `last_seen_upload_id` and drop out of
 *      the `active_employees` view automatically.
 *   5. Promote the new upload to `is_current=true`.
 */
export async function replaceGlobalMasterListFromCsvText(
  csvText: string,
  sourceFile: string,
  options: { clearOffboarded?: boolean } = {},
): Promise<{
  rowCount: number;
  uploadId: string;
  inserted: number;
  updated: number;
  rowsMissingPersonalEmail: number;
  /** Count of rows that shared a `(personal_email, department)` key with another row in the same CSV.
   *  Last occurrence wins; earlier ones are dropped silently to avoid violating the partial unique index. */
  duplicatesInCsv: number;
  /** How many previously off-boarded rows were re-activated because clearOffboarded=true. */
  reonboarded: number;
  /** Rows matched to an existing DB row by Work Email + Department when (Personal Email, Department) did not match — fixes sheet/DB personal-email drift. */
  reconciledViaWorkEmail: number;
  /** INSERT candidates dropped because their (work email, department) was already
   *  claimed by another row in the same sync — would have violated
   *  `global_master_list_work_email_dept_uniq`. */
  skippedWorkDeptCollisions: number;
}> {
  const { clearOffboarded = false } = options;
  const supabase = requireServiceRole();
  const table = getMasterTableName();

  const grid = parseCsv(csvText);
  const { headerRowIndex } = validateMasterListCsvLayout(grid);

  const csvHeaders = grid[headerRowIndex].map((h) => h.trim());
  const dataRows = grid
    .slice(headerRowIndex + 1)
    .filter((row) => row.some((cell) => cell.trim() !== ""));

  const specCols = await getTableColumnsFromSpec(table);
  if (specCols.length === 0) {
    throw new Error(
      `Could not load ${table} columns from PostgREST. Check NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and that the table exists.`,
    );
  }

  const hasUploadTracking =
    specCols.some((c) => c.toLowerCase() === "last_seen_upload_id") &&
    specCols.some((c) => c.toLowerCase() === "first_seen_upload_id");
  if (!hasUploadTracking) {
    throw new Error(
      `${table} is missing first_seen_upload_id / last_seen_upload_id. Run the upload-archive migration before uploading.`,
    );
  }

  const insertCols = resolveMasterColumnMapping(csvHeaders, specCols);
  if (insertCols.length === 0) {
    throw new Error(
      `No CSV columns match ${table}. Ensure headers match Supabase column names (e.g. Department, Name, Personal Email, Work Email, Start Date).`,
    );
  }

  const personalEmailMappingIdx = findMappingIndexByDbCol(insertCols, "Personal Email");
  const departmentMappingIdx = findMappingIndexByDbCol(insertCols, "Department");
  if (personalEmailMappingIdx < 0) {
    throw new Error(
      `Master List CSV is missing a "Personal Email" column. That is the identity key — without it the system cannot dedupe rows (work_email is recycled when employees offboard).`,
    );
  }
  if (departmentMappingIdx < 0) {
    throw new Error(
      `Master List CSV is missing a "Department" column. An employee's (personal_email, department) pair is the row key.`,
    );
  }
  const personalEmailCsvIdx = insertCols[personalEmailMappingIdx].csvIdx;
  const departmentCsvIdx = insertCols[departmentMappingIdx].csvIdx;
  const workEmailMappingIdx = findMappingIndexByDbCol(insertCols, "Work Email");

  const filteredRows = dataRows.filter((row) => !rowIsEmptyForMappedColumns(row, insertCols));
  if (filteredRows.length === 0) {
    throw new Error("No non-empty data rows after mapping CSV columns to the table.");
  }

  // Partition rows:
  //   dedupableRows — have both personal_email AND department; participate in upsert.
  //   orphanRows    — missing personal_email; inserted as-is, reported to the caller.
  const dedupableRows: { row: string[]; personalEmail: string; department: string }[] = [];
  const orphanRows: string[][] = [];
  let rowsMissingPersonalEmail = 0;
  for (const row of filteredRows) {
    const personalEmail = normalizeEmail(row[personalEmailCsvIdx]);
    const department = normalizeDepartment(row[departmentCsvIdx]);
    if (!personalEmail) {
      rowsMissingPersonalEmail += 1;
      orphanRows.push(row);
      continue;
    }
    if (!department) {
      // Has personal_email but no department: can't key it, still preserve the row.
      orphanRows.push(row);
      continue;
    }
    dedupableRows.push({ row, personalEmail, department });
  }

  const totalUsable = dedupableRows.length + orphanRows.length;
  if (totalUsable === 0) {
    throw new Error("No usable rows in the CSV after filtering.");
  }

  const uploadId = await createPendingMasterListUpload(supabase, sourceFile, totalUsable);

  // Fetch ALL rows with non-null personal email + department (paginated), then index by
  // `(personal_email_lc, department_lc)`. Case-fold in memory so DB rows with mixed-case
  // emails still match the sheet. Also build a secondary index on `(work_email_lc, department_lc)`
  // for active (non-off-boarded) rows only — used when the sheet's personal email was
  // corrected but the DB row still has the old address (avoids INSERT + old row falling
  // out of `active_employees`).
  const hasWorkEmailCol = specCols.some((c) => normHeader(c) === normHeader("Work Email"));
  const existingByKey = new Map<
    string,
    { id: unknown; first_seen_upload_id: string | null; off_boarded_at: string | null }
  >();
  const existingByWorkDept = new Map<string, MasterReconcileRow>();
  // One deterministic representative per ACTIVE (work email, department) bucket.
  // The partial unique index `global_master_list_work_email_dept_uniq` permits at
  // most one active row per (lower(work email), lower(department)), so an INSERT
  // whose work+dept already belongs to an active row must instead UPDATE that row.
  // Unlike `existingByWorkDept` (single-bucket only), this keeps a pick even when a
  // bucket has >1 active row (pre-migration leftovers) so the INSERT still never collides.
  const activeWorkDeptReps = new Map<string, MasterReconcileRow>();
  {
    const selectCols = hasWorkEmailCol
      ? 'id, "Personal Email", "Department", "Work Email", first_seen_upload_id, off_boarded_at'
      : 'id, "Personal Email", "Department", first_seen_upload_id, off_boarded_at';
    const allRows = await fetchAllMasterRowsForReconcile(supabase, table, selectCols);
    if (!hasWorkEmailCol) {
      for (const r of allRows) {
        r["Work Email"] = null;
      }
    }

    const workBuckets = new Map<string, MasterReconcileRow[]>();
    for (const r of allRows) {
      const pe = normalizeEmail(r["Personal Email"]);
      const dep = normalizeDepartment(r["Department"]);
      if (pe && dep) {
        existingByKey.set(composeIdentityKey(pe, dep), {
          id: r.id,
          first_seen_upload_id: r.first_seen_upload_id,
          off_boarded_at: r.off_boarded_at ?? null,
        });
      }
      if (!hasWorkEmailCol) continue;
      const we = normalizeEmail(r["Work Email"]);
      if (!we || !dep) continue;
      const wk = composeWorkDeptKey(we, dep);
      if (!workBuckets.has(wk)) workBuckets.set(wk, []);
      workBuckets.get(wk)!.push(r);
      // Only ACTIVE rows participate in the partial unique index, so only they can
      // be collided with on INSERT. Keep one deterministic representative (lowest
      // id) per active bucket so re-runs target the same row.
      if (!r.off_boarded_at) {
        const rep = activeWorkDeptReps.get(wk);
        if (!rep || String(r.id) < String(rep.id)) activeWorkDeptReps.set(wk, r);
      }
    }
    for (const [wk, arr] of workBuckets) {
      if (arr.length === 1) existingByWorkDept.set(wk, arr[0]!);
    }
  }

  let inserted = 0;
  let updated = 0;
  let reonboarded = 0;
  let reconciledViaWorkEmail = 0;
  let skippedWorkDeptCollisions = 0;
  const rowsToInsert: Record<string, string | null>[] = [];
  // INSERT candidates are collected here and run through the (work email, department)
  // collision guard below before being committed, so none violates the partial unique
  // index `global_master_list_work_email_dept_uniq`.
  const insertCandidates: {
    payload: Record<string, string | null>;
    workEmail: string | null;
    department: string | null;
  }[] = [];

  // ── Dedupe within the CSV itself ──
  // Two rows in the same upload that share `(personal_email, department)` would
  // both miss `existingByKey` (neither is in the DB yet) and both queue for
  // INSERT — the second hits the partial unique index on
  // (LOWER("Personal Email"), LOWER("Department")) and the whole batch fails.
  // Last occurrence wins (consistent with how the rates ingest uses the latest
  // Week row). Earlier duplicates are silently dropped; we surface the count.
  const dedupableByKey = new Map<
    string,
    { row: string[]; personalEmail: string; department: string }
  >();
  for (const item of dedupableRows) {
    dedupableByKey.set(composeIdentityKey(item.personalEmail, item.department), item);
  }
  const duplicatesInCsv = dedupableRows.length - dedupableByKey.size;
  const dedupableRowsUnique = Array.from(dedupableByKey.values());

  // ── Partition into UPDATE-targets and INSERT-payloads ──
  const updateOps: { id: string | number; payload: Record<string, string | null> }[] = [];
  for (const { row, personalEmail, department } of dedupableRowsUnique) {
    const payload = csvRowToObject(row, insertCols);
    if (payload["Personal Email"]) payload["Personal Email"] = personalEmail;
    if (payload["Department"]) payload["Department"] = department;

    const existing = existingByKey.get(composeIdentityKey(personalEmail, department));
    let match: MasterListReconcileMatch | null = existing
      ? {
          kind: "personal",
          id: existing.id,
          off_boarded_at: existing.off_boarded_at,
          first_seen_upload_id: existing.first_seen_upload_id,
        }
      : null;

    if (!match && hasWorkEmailCol && workEmailMappingIdx >= 0) {
      const we = normalizeEmail(row[insertCols[workEmailMappingIdx].csvIdx]);
      if (we) {
        const workHit = existingByWorkDept.get(composeWorkDeptKey(we, department));
        if (workHit) match = { kind: "work", row: workHit };
      }
    }

    if (match) {
      if (match.kind === "work") {
        reconciledViaWorkEmail += 1;
        const hitRow = match.row;
        const oldPe = normalizeEmail(hitRow["Personal Email"]);
        const oldDep = normalizeDepartment(hitRow["Department"]);
        if (oldPe && oldDep) {
          existingByKey.delete(composeIdentityKey(oldPe, oldDep));
        }
        existingByKey.set(composeIdentityKey(personalEmail, department), {
          id: hitRow.id,
          first_seen_upload_id: hitRow.first_seen_upload_id,
          off_boarded_at: hitRow.off_boarded_at ?? null,
        });
        if (workEmailMappingIdx >= 0) {
          const we = normalizeEmail(row[insertCols[workEmailMappingIdx].csvIdx]);
          if (we) existingByWorkDept.delete(composeWorkDeptKey(we, department));
        }
      }

      const isOffboarded =
        match.kind === "work" ? !!match.row.off_boarded_at : !!match.off_boarded_at;
      if (clearOffboarded && isOffboarded) reonboarded += 1;
      const updatePayload: Record<string, string | null> = {
        ...payload,
        last_seen_upload_id: uploadId,
      };
      if (clearOffboarded && isOffboarded) {
        updatePayload["off_boarded_at"] = null;
        updatePayload["off_boarded_reason"] = null;
        updatePayload["off_boarded_by"] = null;
        updatePayload["off_boarded_note"] = null;
        // Also clear the pending hard-delete timer so a re-onboarded person
        // isn't deleted by the scheduled-deletion cron within the 14-day window.
        updatePayload["scheduled_deletion_at"] = null;
        updatePayload["deletion_processed_at"] = null;
      }
      updateOps.push({
        id: (match.kind === "work" ? match.row.id : match.id) as string | number,
        payload: updatePayload,
      });
    } else {
      const we =
        hasWorkEmailCol && workEmailMappingIdx >= 0
          ? normalizeEmail(row[insertCols[workEmailMappingIdx].csvIdx])
          : null;
      insertCandidates.push({
        payload: {
          ...payload,
          first_seen_upload_id: uploadId,
          last_seen_upload_id: uploadId,
          source_file: sourceFile || null,
        },
        workEmail: we,
        department,
      });
    }
  }

  // Orphan rows (missing personal_email or department): inserted fresh every upload.
  // They have no stable identity so we can't dedupe them by personal email; HR should
  // patch and re-upload. They can still carry a work email + department, so they run
  // through the same collision guard below.
  for (const row of orphanRows) {
    const payload = csvRowToObject(row, insertCols);
    const we =
      hasWorkEmailCol && workEmailMappingIdx >= 0
        ? normalizeEmail(row[insertCols[workEmailMappingIdx].csvIdx])
        : null;
    insertCandidates.push({
      payload: {
        ...payload,
        first_seen_upload_id: uploadId,
        last_seen_upload_id: uploadId,
        source_file: sourceFile || null,
      },
      workEmail: we,
      department: normalizeDepartment(row[departmentCsvIdx]),
    });
  }

  // ── (work email, department) collision guard ──
  // The partial unique index allows at most one ACTIVE row per
  // (lower(work email), lower(department)). The personal-email dedup above does not
  // protect this key, so two sheet rows sharing a work email + department (differing
  // only on personal email), or an orphan row whose work email belongs to an active
  // row, would both reach INSERT and the batch would fail with
  // "duplicate key value violates unique constraint global_master_list_work_email_dept_uniq".
  // Seed the set of claimed keys from every row already heading to UPDATE (those rows
  // stay/become active and own their key), then for each INSERT candidate:
  //   • if an active DB row already owns the key → UPDATE that row instead of inserting;
  //   • else if another candidate this run already claimed it → drop (last one loses);
  //   • else claim it and insert.
  const claimedWorkDept = new Set<string>();
  // Track which update-op row id already claimed each new (work email, dept) key
  // so we can detect intra-batch UPDATE collisions as well as conflicts with
  // active rows not touched by this sync.
  const updateKeyClaimedBy = new Map<string, string | number>();
  for (const op of updateOps) {
    const we = normalizeEmail(op.payload["Work Email"]);
    const dep = normalizeDepartment(op.payload["Department"]);
    if (we && dep) {
      const wk = composeWorkDeptKey(we, dep);
      const opIdStr = String(op.id);
      // Guard: updating this row's work email to `we` would violate
      // global_master_list_work_email_dept_uniq if another active DB row
      // (not this one) already owns that (work email, department) key, OR
      // if an earlier UPDATE op in this batch already claimed that key.
      const existingRep = activeWorkDeptReps.get(wk);
      const priorClaim = updateKeyClaimedBy.get(wk);
      if (
        (existingRep && String(existingRep.id) !== opIdStr) ||
        (priorClaim !== undefined && String(priorClaim) !== opIdStr)
      ) {
        // Strip only the Work Email — every other field (name, personal email,
        // department, etc.) still syncs correctly. HR must fix the duplicate
        // work email in the sheet to get the assignment to move.
        delete op.payload["Work Email"];
        skippedWorkDeptCollisions += 1;
        continue;
      }
      claimedWorkDept.add(wk);
      updateKeyClaimedBy.set(wk, op.id);
      activeWorkDeptReps.delete(wk);
    }
  }
  for (const cand of insertCandidates) {
    const wk =
      cand.workEmail && cand.department
        ? composeWorkDeptKey(cand.workEmail, cand.department)
        : null;
    if (wk) {
      const rep = activeWorkDeptReps.get(wk);
      if (rep) {
        // An active row already owns this canonical (work email, department) identity.
        // Update it (corrects personal-email drift) rather than inserting a colliding row.
        // Drop the insert-only stamps so we don't clobber the existing row's original
        // first_seen_upload_id / source_file — only CSV columns + last_seen move.
        reconciledViaWorkEmail += 1;
        activeWorkDeptReps.delete(wk);
        claimedWorkDept.add(wk);
        const { first_seen_upload_id: _fs, source_file: _sf, ...cols } = cand.payload;
        void _fs;
        void _sf;
        updateOps.push({
          id: rep.id as string | number,
          payload: { ...cols, last_seen_upload_id: uploadId },
        });
        continue;
      }
      if (claimedWorkDept.has(wk)) {
        skippedWorkDeptCollisions += 1;
        continue;
      }
      claimedWorkDept.add(wk);
    }
    rowsToInsert.push(cand.payload);
  }

  // ── UPDATEs in parallel chunks ──
  // Sequential per-row updates were taking ~3 min for ~700 rows
  // (~250ms/round-trip × 700). Each row's update touches a distinct id, so
  // there's no deadlock risk in running a chunk concurrently. Keep concurrency
  // modest to avoid Supabase pool starvation; 20 is a comfortable middle.
  if (updateOps.length > 0) {
    const UPDATE_CONCURRENCY = 20;
    for (let start = 0; start < updateOps.length; start += UPDATE_CONCURRENCY) {
      const chunk = updateOps.slice(start, start + UPDATE_CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ id, payload }) => {
          const { error } = await supabase.from(table).update(payload).eq("id", id);
          if (error) {
            throw new Error(`Update failed for id ${String(id)}: ${error.message}`);
          }
        }),
      );
      updated += chunk.length;
    }
  }

  // ── INSERTs in serial batches (already efficient) ──
  if (rowsToInsert.length > 0) {
    const BATCH = 50;
    for (let start = 0; start < rowsToInsert.length; start += BATCH) {
      const batch = rowsToInsert.slice(start, start + BATCH);
      const { error } = await supabase.from(table).insert(batch);
      if (error) {
        throw new Error(
          `Insert failed (batch ${start}–${start + batch.length}): ${error.message}`,
        );
      }
      inserted += batch.length;
    }
  }

  await promoteMasterListUploadToCurrent(supabase, uploadId);

  // Stamp employee_id onto any row still missing one. New hires from this
  // upload land without an ID; persisted rows pass through unchanged. Failures
  // are logged but do not abort the upload — the admin backfill route can
  // retry. See src/lib/supabase/backfill-employee-ids.ts.
  try {
    const { backfillEmployeeIds } = await import("./backfill-employee-ids");
    const result = await backfillEmployeeIds(supabase);
    if (result.error) {
      console.warn(
        `[replaceGlobalMasterListFromCsvText] employee_id backfill skipped: ${result.error}`,
      );
    }
  } catch (e) {
    console.warn(
      `[replaceGlobalMasterListFromCsvText] employee_id backfill threw: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  return {
    rowCount: inserted + updated,
    uploadId,
    inserted,
    updated,
    rowsMissingPersonalEmail,
    duplicatesInCsv,
    reonboarded,
    reconciledViaWorkEmail,
    skippedWorkDeptCollisions,
  };
}

/**
 * After a master-sheet sync, `active_employees` filters to rows where
 * `last_seen_upload_id = (current upload)`. Employees that are legitimately
 * active but NOT in the Google sheet (e.g. manually-seeded US employees) still
 * point at the prior upload and drop out of the roster the moment the new upload
 * is promoted — even though they have never been offboarded.
 *
 * This function re-stamps every non-offboarded row onto `uploadId`, making them
 * visible in `active_employees` again. It MUST be called immediately after
 * `replaceGlobalMasterListFromCsvText` / `promoteMasterListUploadToCurrent`
 * so the current upload is already set before the count is read.
 *
 * Why UPDATE rather than changing the view:
 *   The `active_employees` view contract (last_seen = current AND not offboarded)
 *   is correct for PH employees — a row that vanishes from the sheet should stop
 *   being active unless explicitly re-onboarded. US employees are the exception:
 *   they are managed outside the sheet and should always stay active until HR
 *   explicitly offboards them. Re-stamping is the lightest fix with no schema change.
 *
 * Returns the number of rows re-stamped (0 on a clean sync where the sheet
 * covered everyone, > 0 when manual-seed employees exist outside the sheet).
 */
export async function restampActiveNonSheetRows(
  supabase: SupabaseClient,
  uploadId: string,
): Promise<number> {
  const table = getMasterTableName();

  // ONLY the manually-seeded US employees are legitimately active outside the
  // Google sheet. They're identified by `employee_ids.employee_id LIKE 'US-%'`
  // (the same set `getEmployees` / the Rates & Profiles builder UNION back in),
  // and the master-sheet sync never touches them, so without a re-stamp they'd
  // drop out of `active_employees` on every sync.
  //
  // IMPORTANT: this used to re-stamp EVERY non-offboarded row, which silently
  // defeated the sheet's authority — anyone removed from the Google sheet (left
  // the company but not yet marked off-boarded) kept getting re-stamped as
  // "current" forever and never fell out of the roster. That bloated
  // active_employees far past the sheet's real headcount. We now restrict the
  // re-stamp to the US employees only, so every PH row is governed by the sheet:
  // vanish from the sheet → drop from active_employees until re-onboarded.
  const { data: usIds, error: usErr } = await supabase
    .from("employee_ids")
    .select("work_email, personal_email")
    .like("employee_id", "US-%");
  if (usErr) {
    console.warn(`[restampActiveNonSheetRows] could not read US employee_ids: ${usErr.message}`);
    return 0;
  }
  const emails = new Set<string>();
  for (const r of (usIds ?? []) as Array<{ work_email?: string | null; personal_email?: string | null }>) {
    const we = r.work_email?.trim();
    const pe = r.personal_email?.trim();
    if (we) emails.add(we);
    if (pe) emails.add(pe);
  }
  if (emails.size === 0) return 0;

  // Match those US rows by Work Email then Personal Email. Two separate `.in()`
  // updates rather than a single `.or(...)`: PostgREST's `.or()` filter-string
  // grammar mis-parses a space-containing quoted column ("Work Email"), failing
  // with "column ... does not exist". The two-argument `.in(column, values)`
  // form takes the column as a parameter and handles the spaced/quoted name
  // correctly. The `.neq(last_seen, uploadId)` guard means the second pass skips
  // any row the first pass already stamped, so a row matched on both emails is
  // never counted twice.
  const list = [...emails];
  let total = 0;
  for (const column of ['"Work Email"', '"Personal Email"'] as const) {
    const { data, error } = await supabase
      .from(table)
      .update({ last_seen_upload_id: uploadId })
      .is("off_boarded_at", null)
      .neq("last_seen_upload_id", uploadId)
      .in(column, list)
      .select("id");
    if (error) {
      // Non-fatal: the sync already succeeded; log and continue.
      console.warn(`[restampActiveNonSheetRows] ${column} update failed: ${error.message}`);
      continue;
    }
    total += (data ?? []).length;
  }
  return total;
}

export async function countMasterAndRatesRows(): Promise<{
  masterCount: number | null;
  ratesCount: number | null;
  masterError: string | null;
  ratesError: string | null;
}> {
  const supabase = requireServiceRole();
  const ratesTable =
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || "employee_hourly_rates";

  // `active_employees` is the view created by the upload-archive migration — it filters
  // `global_master_list` to the current upload. Use it as the authoritative roster size.
  const [m, r] = await Promise.all([
    supabase.from("active_employees").select("*", { count: "exact", head: true }),
    supabase.from(ratesTable).select("*", { count: "exact", head: true }),
  ]);

  return {
    masterCount: m.count ?? null,
    ratesCount: r.count ?? null,
    masterError: m.error?.message ?? null,
    ratesError: r.error?.message ?? null,
  };
}

/**
 * Read EVERY row of the `active_employees` view, paging past PostgREST's default
 * `db.max-rows` cap (1000). A single `.range(0, 9999)` is silently capped at 1000
 * server-side, so a roster larger than 1000 dropped everyone past the first page
 * (e.g. HR's jamesc@simple.biz vanished from the transfer picker). Mirrors the
 * paginated readers elsewhere in this file (fetchAllMasterRowsForReconcile, etc.).
 */
async function fetchAllActiveEmployeeRows(
  supabase: SupabaseClient,
  selectCols: string,
): Promise<Record<string, unknown>[]> {
  const pageSize = 1000;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("active_employees")
      .select(selectCols)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...batch);
    if (batch.length < pageSize) break;
    if (from > 200000) break; // safety valve
  }
  return out;
}

/**
 * Distinct active-employee names from the Global Master List (`active_employees`
 * = the current master upload), sorted A→Z. Powers the New Hire Checklist
 * "Referred By" picker so a referrer is always checked against a real person on
 * the master list. Names only (no rates / PII beyond the name).
 */
export async function listActiveMasterListNames(): Promise<{ names: string[]; error: string | null }> {
  let supabase: SupabaseClient;
  try {
    supabase = requireServiceRole();
  } catch (e) {
    return { names: [], error: e instanceof Error ? e.message : "Supabase not configured" };
  }
  // `Name` is selected unquoted to match the roster reader in employees.ts
  // (PostgREST returns it under the "Name" key).
  let data: Record<string, unknown>[];
  try {
    data = await fetchAllActiveEmployeeRows(supabase, "Name");
  } catch (e) {
    return { names: [], error: e instanceof Error ? e.message : "Failed to read active_employees" };
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const raw = row["Name"] ?? row["name"];
    const n = typeof raw === "string" ? raw.trim() : "";
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(n);
  }
  names.sort((a, b) => a.localeCompare(b));
  return { names, error: null };
}

export interface ActiveMasterListPerson {
  name: string;
  department: string | null;
  work_email: string | null;
  personal_email: string | null;
}

/**
 * Active employees from the Global Master List with just the fields a manager
 * needs to pick a transfer target — Name, Department, Work/Personal Email.
 * Deliberately carries NO rate / pay / banking data: managers never see pay, and
 * this feeds the "Request transfer in" person picker across every department.
 */
export async function listActiveMasterListPeople(): Promise<{
  people: ActiveMasterListPerson[];
  error: string | null;
}> {
  let supabase: SupabaseClient;
  try {
    supabase = requireServiceRole();
  } catch (e) {
    return { people: [], error: e instanceof Error ? e.message : "Supabase not configured" };
  }
  let data: Record<string, unknown>[];
  try {
    data = await fetchAllActiveEmployeeRows(supabase, '"Name", "Department", "Work Email", "Personal Email"');
  } catch (e) {
    return { people: [], error: e instanceof Error ? e.message : "Failed to read active_employees" };
  }

  // Dedupe by (name, department) so a person holding rows in the same dept isn't
  // listed twice; distinct departments for the same human stay as separate rows.
  const seen = new Set<string>();
  const people: ActiveMasterListPerson[] = [];
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const name = typeof row["Name"] === "string" ? (row["Name"] as string).trim() : "";
    if (!name) continue;
    const department = normalizeDepartment(row["Department"] as string | null);
    const work_email = normalizeEmail(row["Work Email"] as string | null);
    const personal_email = normalizeEmail(row["Personal Email"] as string | null);
    const key = `${name.toLowerCase()}|${(department ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ name, department, work_email, personal_email });
  }
  people.sort((a, b) => a.name.localeCompare(b.name));
  return { people, error: null };
}

/** Shape consumed by `applyOffboardedFromSheetRows`. Mirror of `OffboardedSheetRow`
 *  in `src/lib/google-sheets/fetch-offboarded-sheet.ts` — kept structurally
 *  identical so the route can pass through the parsed sheet rows directly. */
export interface OffboardedRowInput {
  personal_email: string;
  work_email?: string | null;
  name?: string | null;
  department?: string | null;
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
  off_boarded_note: string | null;
  off_boarded_by: string | null;
}

/**
 * Marks rows in `global_master_list` as off-boarded based on parsed rows from the
 * "Offboarded" tab of the master Google Sheet. Match key: lowercased Personal Email.
 *
 * Behavior (from current product decisions):
 *   • Already off-boarded rows are skipped — preserves manual HR edits made via
 *     the Offboarding dashboard. Counted in `skippedAlreadyOffboarded`.
 *   • `off_boarded_at` = sheet date if parseable, else NOW().
 *   • `off_boarded_reason` defaults to 'sheet_sync' if the sheet didn't include one.
 *   • `off_boarded_by` defaults to 'GSheets Sync' if the sheet didn't include one.
 *   • Rows in the sheet whose Personal Email isn't in `global_master_list` are
 *     reported in `unmatchedEmails` (capped to the first 50 to keep audit logs sane).
 *
 * Does NOT delete or insert master-list rows — only updates the off_boarded_*
 * columns on existing rows. Add a row via the master-list sync first.
 */
export async function applyOffboardedFromSheetRows(rows: OffboardedRowInput[]): Promise<{
  matched: number;
  updated: number;
  skippedAlreadyOffboarded: number;
  notFound: number;
  unmatchedEmails: string[];
}> {
  const supabase = requireServiceRole();
  const table = getMasterTableName();

  if (rows.length === 0) {
    return { matched: 0, updated: 0, skippedAlreadyOffboarded: 0, notFound: 0, unmatchedEmails: [] };
  }

  // Paginate past Supabase's default 1000-row max — global_master_list can be
  // several thousand rows (active + offboarded), and a single `.range()` call
  // gets capped server-side regardless of the requested ceiling.
  const PAGE = 1000;
  const allRows: {
    id: string | number;
    "Personal Email": string | null;
    off_boarded_at: string | null;
  }[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select('id, "Personal Email", off_boarded_at')
      .not('"Personal Email"', "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Could not read ${table}: ${error.message}`);
    const batch = (data ?? []) as typeof allRows;
    allRows.push(...batch);
    if (batch.length < PAGE) break;
    if (offset > 100000) break;
  }

  const byEmail = new Map<
    string,
    { id: string | number; off_boarded_at: string | null }[]
  >();
  for (const r of allRows) {
    const pe = (r["Personal Email"] ?? "").trim().toLowerCase();
    if (!pe) continue;
    const list = byEmail.get(pe) ?? [];
    list.push({ id: r.id, off_boarded_at: r.off_boarded_at });
    byEmail.set(pe, list);
  }

  let matched = 0;
  let updated = 0;
  let skippedAlreadyOffboarded = 0;
  let notFound = 0;
  const unmatchedEmails: string[] = [];

  for (const sheetRow of rows) {
    const targets = byEmail.get(sheetRow.personal_email);
    if (!targets || targets.length === 0) {
      notFound += 1;
      if (unmatchedEmails.length < 50) unmatchedEmails.push(sheetRow.personal_email);
      continue;
    }
    matched += targets.length;

    const stamp = sheetRow.off_boarded_at ?? new Date().toISOString();
    const reason = sheetRow.off_boarded_reason ?? "sheet_sync";
    const by = sheetRow.off_boarded_by ?? "GSheets Sync";
    const note = sheetRow.off_boarded_note ?? null;

    for (const tgt of targets) {
      if (tgt.off_boarded_at) {
        skippedAlreadyOffboarded += 1;
        continue;
      }
      const { error: updErr } = await supabase
        .from(table)
        .update({
          off_boarded_at: stamp,
          off_boarded_reason: reason,
          off_boarded_by: by,
          off_boarded_note: note,
        })
        .eq("id", tgt.id);
      if (updErr) {
        console.error(
          `[applyOffboardedFromSheetRows] update failed for id=${tgt.id}:`,
          updErr.message,
        );
        continue;
      }
      updated += 1;
    }
  }

  return { matched, updated, skippedAlreadyOffboarded, notFound, unmatchedEmails };
}

/**
 * Replaces the contents of the `offboarded_sheet` table with a fresh snapshot
 * from the parsed Offboarded sheet rows. The HR Offboarded tab reads from this
 * table (decoupled from global_master_list).
 *
 * Behavior: TRUNCATE-equivalent (DELETE all) + INSERT all. We deliberately don't
 * upsert per-row because the sheet IS the source of truth — anyone removed from
 * the sheet should disappear from the tab on the next sync.
 */
export async function replaceOffboardedSheetSnapshot(rows: OffboardedRowInput[]): Promise<{
  inserted: number;
  cleared: number;
}> {
  const supabase = requireServiceRole();

  // Clear existing snapshot. `.gt('id', 0)` satisfies the supabase-js requirement
  // that DELETE always have a filter.
  const { count: prevCount, error: countErr } = await supabase
    .from("offboarded_sheet")
    .select("id", { count: "exact", head: true });
  if (countErr) {
    throw new Error(`Could not count offboarded_sheet: ${countErr.message}`);
  }

  const { error: delErr } = await supabase
    .from("offboarded_sheet")
    .delete()
    .gt("id", 0);
  if (delErr) {
    throw new Error(`Could not clear offboarded_sheet: ${delErr.message}`);
  }

  if (rows.length === 0) {
    return { inserted: 0, cleared: prevCount ?? 0 };
  }

  const payload = rows.map((r) => ({
    personal_email: r.personal_email,
    work_email: r.work_email ?? null,
    name: r.name ?? null,
    department: r.department ?? null,
    start_date: null,
    off_boarded_at: r.off_boarded_at,
    off_boarded_reason: r.off_boarded_reason,
    off_boarded_note: r.off_boarded_note,
    off_boarded_by: r.off_boarded_by,
  }));

  // Insert in 500-row chunks. Supabase / PostgREST will silently truncate / fail
  // on very large bulk inserts (payload size + db.max-rows limits), which is
  // why a 3000-row sheet can land as ~970 rows when sent as a single .insert().
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK);
    const { error: insErr } = await supabase.from("offboarded_sheet").insert(slice);
    if (insErr) {
      throw new Error(
        `Could not insert into offboarded_sheet (chunk ${i}-${i + slice.length}): ${insErr.message}`,
      );
    }
    inserted += slice.length;
  }

  return { inserted, cleared: prevCount ?? 0 };
}

/** Read all rows from the offboarded_sheet table — newest off-board first.
 *  Paginates manually because Supabase's default `db.max-rows` is 1000, so a
 *  3000+ row sheet won't come back in a single request even with `.range()`.
 *
 *  Enriches each row's `department` from `global_master_list` keyed on
 *  Personal Email (the Offboarded sheet doesn't have a Department column, so
 *  the synced rows have null department; the master list does). Skipped if
 *  the row already has a non-empty department from the sheet itself. */
export async function listOffboardedSheetRows(): Promise<{
  id: number;
  personal_email: string;
  work_email: string | null;
  name: string | null;
  department: string | null;
  start_date: string | null;
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
  off_boarded_note: string | null;
  off_boarded_by: string | null;
  synced_at: string;
}[]> {
  const supabase = requireServiceRole();
  const table = getMasterTableName();
  const PAGE = 1000;

  // 1. Pull offboarded_sheet rows (paginated — default max-rows is 1000).
  const all: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("offboarded_sheet")
      .select("*")
      .order("off_boarded_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Could not list offboarded_sheet: ${error.message}`);
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < PAGE) break;
    if (offset > 100000) break;
  }

  // 2. Build a personal_email_lc → department map from global_master_list.
  //    Sheet has no Department column → master list is the only source. Pick
  //    the first department alphabetically when an email has multiple
  //    assignments, so the column is at least stable run-to-run.
  const deptByEmail = new Map<string, string>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select('"Personal Email", "Department"')
      .not('"Personal Email"', "is", null)
      .not('"Department"', "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Could not read ${table} for dept lookup: ${error.message}`);
    const batch = (data ?? []) as { "Personal Email": string | null; "Department": string | null }[];
    for (const r of batch) {
      const pe = (r["Personal Email"] ?? "").trim().toLowerCase();
      const dept = (r["Department"] ?? "").trim();
      if (!pe || !dept) continue;
      const existing = deptByEmail.get(pe);
      if (!existing || dept.localeCompare(existing) < 0) {
        deptByEmail.set(pe, dept);
      }
    }
    if (batch.length < PAGE) break;
    if (offset > 100000) break;
  }

  // 3. Fill in department for any row whose sheet-side dept is empty.
  for (const r of all) {
    const existing = ((r.department as string | null) ?? "").trim();
    if (existing) continue;
    const pe = ((r.personal_email as string | null) ?? "").trim().toLowerCase();
    const dept = pe ? deptByEmail.get(pe) : undefined;
    if (dept) r.department = dept;
  }

  return all as never;
}

/** Delete a row from offboarded_sheet by work_email (case-insensitive). Returns
 *  the number of rows deleted. Used by the Restore flow. */
export async function deleteOffboardedSheetByWorkEmail(workEmail: string): Promise<number> {
  const supabase = requireServiceRole();
  const target = workEmail.trim().toLowerCase();
  if (!target) return 0;
  const { data, error } = await supabase
    .from("offboarded_sheet")
    .delete()
    .ilike("work_email", target)
    .select("id");
  if (error) throw new Error(`Could not delete from offboarded_sheet: ${error.message}`);
  return (data ?? []).length;
}

/**
 * Delete from offboarded_sheet matching EITHER work_email OR personal_email.
 * The snapshot's only guaranteed key is personal_email (work_email may be blank
 * for rows that came from the Offboarded sheet tab), so matching on both is
 * needed to fully purge a person from the HR Offboarded list immediately,
 * without waiting for the next sync.
 */
export async function deleteOffboardedSheetByEmails(
  workEmail: string,
  personalEmail: string,
): Promise<number> {
  const supabase = requireServiceRole();
  const work = workEmail.trim().toLowerCase();
  const personal = personalEmail.trim().toLowerCase();

  // Two sequential deletes rather than a single `.or(...)`: PostgREST's
  // logical-filter string parses `column.op.value`, and our email values
  // contain dots (e.g. "simple.biz"), which the parser mis-splits and reports
  // as a bogus "column ... does not exist". The two-argument `.ilike()` form
  // takes the value as a parameter and handles emails correctly. Deleting by
  // work_email first means the personal_email pass can't re-hit (and double
  // count) the same rows.
  let total = 0;
  if (work) {
    const { data, error } = await supabase
      .from("offboarded_sheet")
      .delete()
      .ilike("work_email", work)
      .select("id");
    if (error) throw new Error(`Could not delete from offboarded_sheet: ${error.message}`);
    total += (data ?? []).length;
  }
  if (personal) {
    const { data, error } = await supabase
      .from("offboarded_sheet")
      .delete()
      .ilike("personal_email", personal)
      .select("id");
    if (error) throw new Error(`Could not delete from offboarded_sheet: ${error.message}`);
    total += (data ?? []).length;
  }
  return total;
}
