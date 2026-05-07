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

  csvHeaders.forEach((rawH, csvIdx) => {
    const h = normHeader(rawH);
    if (!h) return;
    const match = specWithoutId.find(
      (db) => normHeader(db) === h && !usedSpec.has(db),
    );
    if (match) {
      usedSpec.add(match);
      insertCols.push({ csvIdx, dbCol: match });
    }
  });

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
): Promise<{
  rowCount: number;
  uploadId: string;
  inserted: number;
  updated: number;
  rowsMissingPersonalEmail: number;
  /** Count of rows that shared a `(personal_email, department)` key with another row in the same CSV.
   *  Last occurrence wins; earlier ones are dropped silently to avoid violating the partial unique index. */
  duplicatesInCsv: number;
}> {
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

  // Fetch ALL rows with non-null email + department, then index them by the
  // lowercased identity key. The previous chunked `.in('"Personal Email"', …)`
  // approach was case-sensitive (PostgREST does exact string equality), so DB
  // rows with mixed-case emails (legacy backfill, manual edits) were invisible
  // to the lookup — those rows then hit the partial unique index on
  // (LOWER("Personal Email"), LOWER("Department")) when we tried to INSERT
  // their CSV counterparts. Doing the case fold in memory removes the gap.
  //
  // For roster sizes the system targets (≤ a few thousand rows) the single
  // pass is faster than chunked queries anyway. The 0-9999 range matches the
  // ceiling used by `fetchActiveEmployees`.
  const existingByKey = new Map<
    string,
    { id: unknown; first_seen_upload_id: string | null }
  >();
  {
    const { data, error } = await supabase
      .from(table)
      .select('id, "Personal Email", "Department", first_seen_upload_id')
      .not('"Personal Email"', "is", null)
      .not('"Department"', "is", null)
      .range(0, 9999);
    if (error) throw new Error(`Could not read ${table} for reconciliation: ${error.message}`);
    for (const r of (data ?? []) as {
      id: unknown;
      "Personal Email": string | null;
      "Department": string | null;
      first_seen_upload_id: string | null;
    }[]) {
      const pe = normalizeEmail(r["Personal Email"]);
      const dep = normalizeDepartment(r["Department"]);
      if (pe && dep) {
        existingByKey.set(composeIdentityKey(pe, dep), {
          id: r.id,
          first_seen_upload_id: r.first_seen_upload_id,
        });
      }
    }
  }

  let inserted = 0;
  let updated = 0;
  const rowsToInsert: Record<string, string | null>[] = [];

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
    if (existing) {
      updateOps.push({
        id: existing.id as string | number,
        payload: { ...payload, last_seen_upload_id: uploadId },
      });
    } else {
      rowsToInsert.push({
        ...payload,
        first_seen_upload_id: uploadId,
        last_seen_upload_id: uploadId,
        source_file: sourceFile || null,
      });
    }
  }

  // Orphan rows (missing personal_email or department): inserted fresh every upload.
  // They have no stable identity so we can't dedupe them; HR should patch and re-upload.
  for (const row of orphanRows) {
    const payload = csvRowToObject(row, insertCols);
    rowsToInsert.push({
      ...payload,
      first_seen_upload_id: uploadId,
      last_seen_upload_id: uploadId,
      source_file: sourceFile || null,
    });
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

  return {
    rowCount: inserted + updated,
    uploadId,
    inserted,
    updated,
    rowsMissingPersonalEmail,
    duplicatesInCsv,
  };
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
