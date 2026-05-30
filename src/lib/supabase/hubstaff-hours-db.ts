import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseCsv } from "@/lib/csv/parse-csv";
import { upsertAppSetting } from "@/lib/supabase/app-settings";
import { mapHubstaffHoursRow, type PayrollHubstaffRow } from "@/lib/supabase/hubstaff-hours";

function getTableName(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || "hubstaff_hours";
}

function requireServiceRole(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required to sync hubstaff_hours. Add it to .env (Supabase → Project Settings → API → service_role key).",
    );
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Deletes every row in the table. PostgREST requires a filter on `.delete()`; a single
 * `.not('id','is',null)` can fail to remove all rows in some setups. Batching by `id`
 * matches how a full replace is expected to behave (no leftover rows from prior uploads).
 */
/** Clears a table by paging deletes on `id` — used by hubstaff replace and legacy master-list import. */
export async function deleteAllRowsInTable(supabase: SupabaseClient, table: string): Promise<void> {
  const PAGE = 1000;
  let safety = 0;
  const maxIterations = 100_000;
  while (safety < maxIterations) {
    safety += 1;
    const { data, error } = await supabase.from(table).select("id").limit(PAGE);
    if (error) {
      throw new Error(`Cannot read ${table} for clear: ${error.message}`);
    }
    const batch = (data ?? []) as { id: unknown }[];
    if (batch.length === 0) return;

    const ids = batch.map((r) => r.id).filter((id) => id != null) as (string | number)[];
    if (ids.length === 0) {
      const { error: delNull } = await supabase.from(table).delete().is("id", null);
      if (delNull) {
        const { error: fallback } = await supabase.from(table).delete().not("id", "is", null);
        if (fallback) throw new Error(`Failed to clear ${table}: ${fallback.message}`);
      }
      continue;
    }

    const { error: delErr } = await supabase.from(table).delete().in("id", ids);
    if (delErr) throw new Error(`Failed to clear ${table}: ${delErr.message}`);
    if (batch.length < PAGE) return;
  }
  throw new Error(`Failed to fully clear ${table}: too many rows or loop limit reached`);
}

/** Dedupe OpenAPI spec fetches — every hubstaff source_file query used to repeat this. */
const tableColumnsFromSpecCache = new Map<string, Promise<string[]>>();

/**
 * Fetches column names from the PostgREST OpenAPI spec.
 * Returns them in the order PostgREST exposes them (alphabetical from the spec),
 * which is used as a fallback when the table is empty.
 */
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

/** A row is considered empty only if every single column value is null/undefined/blank. */
function rowIsEmpty(row: Record<string, unknown>): boolean {
  return Object.values(row).every((v) => v == null || String(v).trim() === "");
}

/**
 * Try to parse a CSV column header into an ISO date string (YYYY-MM-DD).
 * Handles:
 *   • "2026-03-24"              → "2026-03-24"
 *   • "Mon 3/24", "Mon 3/24/26" → "2026-03-24"
 *   • "Monday 3/24/2026"        → "2026-03-24"
 * Returns null if the column isn't a date.
 */
function csvColToIsoDate(col: string): string | null {
  const s = col.trim();

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Hubstaff format: <DayName> M/D[/YY|YYYY]
  const hub =
    /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/i.exec(
      s,
    );
  if (hub) {
    const month = parseInt(hub[1], 10);
    const day = parseInt(hub[2], 10);
    let year = hub[3] ? parseInt(hub[3], 10) : new Date().getFullYear();
    if (year < 100) year += 2000;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  return null;
}

/** Canonical weekday keys (UTC), used for stable DB columns `monday`…`sunday`. */
const CANONICAL_WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/**
 * Maps a hubstaff_hours column name to a canonical weekday (e.g. `mon`, `Monday` → `monday`).
 * Returns null for non–day columns (Email, Total worked, ISO dates, etc.).
 */
function dbColumnToWeekdayKey(dbCol: string): string | null {
  const n = dbCol.toLowerCase().trim();
  const map: Record<string, string> = {
    sun: "sunday",
    sunday: "sunday",
    mon: "monday",
    monday: "monday",
    tue: "tuesday",
    tues: "tuesday",
    tuesday: "tuesday",
    wed: "wednesday",
    weds: "wednesday",
    wednesday: "wednesday",
    thu: "thursday",
    thur: "thursday",
    thurs: "thursday",
    thursday: "thursday",
    fri: "friday",
    friday: "friday",
    sat: "saturday",
    saturday: "saturday",
  };
  return map[n] ?? null;
}

/** ISO calendar date → canonical weekday key (uses UTC date parts to avoid TZ shifts). */
function isoDateToWeekdayKey(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10) - 1;
  const d = parseInt(m[3], 10);
  const dt = new Date(Date.UTC(y, mo, d));
  if (Number.isNaN(dt.getTime())) return null;
  return CANONICAL_WEEKDAYS[dt.getUTCDay()] ?? null;
}

/**
 * Hubstaff weekly exports list days Sunday → Saturday (e.g. ISO columns 2026-03-22 … 2026-03-28).
 * Stable DB columns are sunday…saturday. This index matches that order (0 = Sun … 6 = Sat).
 */
function weekSortIndexForColumn(col: string): number | null {
  const trimmed = col.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const wk = isoDateToWeekdayKey(trimmed);
    if (wk) return CANONICAL_WEEKDAYS.indexOf(wk as (typeof CANONICAL_WEEKDAYS)[number]);
    return null;
  }
  const named = dbColumnToWeekdayKey(trimmed);
  if (named) return CANONICAL_WEEKDAYS.indexOf(named as (typeof CANONICAL_WEEKDAYS)[number]);
  return null;
}

/** Matches Hubstaff daily report column order (reference CSV). */
const HUBSTAFF_LEADING_COLS = [
  "Organization",
  "Time Zone",
  "Member",
  "Email",
  "Job title",
  "Job type",
  "Employee ID",
  "Tax info",
  "Location",
  "Time zone",
  "Date added",
] as const;

const HUBSTAFF_TRAILING_COLS = ["Total worked", "Activity", "Spent total", "Currency"] as const;

function leadingColOrder(col: string): number | null {
  const lower = col.toLowerCase();
  const i = HUBSTAFF_LEADING_COLS.findIndex((k) => k.toLowerCase() === lower);
  return i >= 0 ? i : null;
}

function trailingColOrder(col: string): number | null {
  const lower = col.toLowerCase();
  const i = HUBSTAFF_TRAILING_COLS.findIndex((k) => k.toLowerCase() === lower);
  return i >= 0 ? i : null;
}

/**
 * Column order for API/UI: `id` (if present) → Hubstaff metadata → Sunday…Saturday → totals → other.
 * Matches Hubstaff CSV order when headers are ISO dates or named weekdays.
 */
export function sortHubstaffColumnsForDisplay(columns: string[]): string[] {
  const group = (col: string): number => {
    if (col.toLowerCase() === "id") return -1;
    if (leadingColOrder(col) !== null) return 0;
    if (weekSortIndexForColumn(col) !== null) return 1;
    if (trailingColOrder(col) !== null) return 2;
    return 3;
  };

  return [...columns].sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;

    if (ga === -1) return 0;

    const la = leadingColOrder(a);
    const lb = leadingColOrder(b);
    if (la !== null && lb !== null && la !== lb) return la - lb;

    const wa = weekSortIndexForColumn(a);
    const wb = weekSortIndexForColumn(b);
    if (wa !== null && wb !== null && wa !== wb) return wa - wb;

    const ta = trailingColOrder(a);
    const tb = trailingColOrder(b);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;

    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
}

/**
 * Fetches rows from hubstaff_hours for the **current upload only** (the latest CSV
 * the operator pushed). Older uploads remain in the table but are hidden from
 * the Payroll Wizard's default view — use `fetchHubstaffRowsBySourceFile` to inspect them.
 */
export async function fetchHubstaffRowsOrdered(): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
}> {
  const supabase = requireServiceRole();
  const table = getTableName();

  const currentUploadId = await getCurrentHubstaffUploadId(supabase);

  const PAGE = 1000;
  const allRows: Record<string, unknown>[] = [];
  let from = 0;

  while (true) {
    let q = supabase.from(table).select("*").range(from, from + PAGE - 1);
    if (currentUploadId) q = q.eq("upload_id", currentUploadId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Record<string, unknown>[];
    allRows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }

  const rows = allRows.filter((r) => !rowIsEmpty(r));

  let columns =
    rows.length > 0
      ? Object.keys(rows[0])
      : allRows.length > 0
        ? Object.keys(allRows[0])
        : await getTableColumnsFromSpec(table);

  columns = sortHubstaffColumnsForDisplay(columns);

  return { columns, rows };
}

/**
 * Resolves CSV → DB column mappings for the hubstaff_hours table.
 */
async function resolveColumnMapping(
  csvHeaders: string[],
  table: string,
): Promise<{ csvIdx: number; dbCol: string }[]> {
  const dbColumns = await getTableColumnsFromSpec(table);
  const insertCols: { csvIdx: number; dbCol: string }[] = [];

  if (dbColumns.length > 0) {
    const usedCsvIdx = new Set<number>();

    // ── Pass 1: exact case-insensitive match (handles "Email", "Total worked", etc.) ──
    for (const dbCol of dbColumns) {
      if (dbCol === "id") continue; // auto-generated; skip unless CSV explicitly has it
      const csvIdx = csvHeaders.findIndex(
        (h) => h.toLowerCase() === dbCol.toLowerCase(),
      );
      if (csvIdx >= 0) {
        insertCols.push({ csvIdx, dbCol });
        usedCsvIdx.add(csvIdx);
      }
    }

    // ── Pass 2: date-aware match ──
    const unmatchedDbDateCols = dbColumns.filter(
      (c) =>
        c !== "id" &&
        !insertCols.some((ic) => ic.dbCol === c) &&
        /^\d{4}-\d{2}-\d{2}$/.test(c),
    );
    if (unmatchedDbDateCols.length > 0) {
      const csvDateMap = new Map<string, number>();
      csvHeaders.forEach((h, i) => {
        if (usedCsvIdx.has(i)) return;
        const iso = csvColToIsoDate(h);
        if (iso) csvDateMap.set(iso, i);
      });
      for (const dbCol of unmatchedDbDateCols) {
        const csvIdx = csvDateMap.get(dbCol);
        if (csvIdx !== undefined) {
          insertCols.push({ csvIdx, dbCol });
          usedCsvIdx.add(csvIdx);
        }
      }
    }

    // ── Pass 3: stable weekday columns (monday…sunday) ↔ any CSV date column ──
    const unmatchedWeekdayCols = dbColumns.filter(
      (c) =>
        c !== "id" &&
        !insertCols.some((ic) => ic.dbCol === c) &&
        dbColumnToWeekdayKey(c) !== null,
    );
    if (unmatchedWeekdayCols.length > 0) {
      const weekdayKeyToCsvIdx = new Map<string, number>();
      csvHeaders.forEach((h, i) => {
        if (usedCsvIdx.has(i)) return;
        const iso = csvColToIsoDate(h);
        if (!iso) return;
        const wk = isoDateToWeekdayKey(iso);
        if (!wk) return;
        weekdayKeyToCsvIdx.set(wk, i);
      });
      for (const dbCol of unmatchedWeekdayCols) {
        const wk = dbColumnToWeekdayKey(dbCol);
        if (!wk) continue;
        const csvIdx = weekdayKeyToCsvIdx.get(wk);
        if (csvIdx !== undefined) {
          insertCols.push({ csvIdx, dbCol });
          usedCsvIdx.add(csvIdx);
        }
      }
    }
  } else {
    // Spec unavailable — use CSV headers directly, omitting 'id'
    csvHeaders.forEach((h, i) => {
      if (h.toLowerCase() !== "id") insertCols.push({ csvIdx: i, dbCol: h });
    });
  }

  return insertCols;
}

/**
 * Batch-inserts parsed CSV rows into the hubstaff_hours table.
 * Extra columns like `source_file` and `upload_id` are applied to every row.
 */
async function batchInsertRows(
  supabase: SupabaseClient,
  table: string,
  dataRows: string[][],
  insertCols: { csvIdx: number; dbCol: string }[],
  rowExtras?: Record<string, string | null>,
): Promise<number> {
  const batchSize = 50;
  let rowCount = 0;

  for (let start = 0; start < dataRows.length; start += batchSize) {
    const batch = dataRows.slice(start, start + batchSize);
    const rows = batch.map((row) => {
      const obj: Record<string, string | null> = {};
      for (const { csvIdx, dbCol } of insertCols) {
        const val = row[csvIdx] ?? "";
        obj[dbCol] = val === "" ? null : String(val);
      }
      if (rowExtras) Object.assign(obj, rowExtras);
      return obj;
    });

    const { error } = await supabase.from(table).insert(rows);
    if (error) throw new Error(`Insert failed (batch ${start}–${start + batch.length}): ${error.message}`);
    rowCount += batch.length;
  }

  return rowCount;
}

const HUBSTAFF_UPLOADS_TABLE = "hubstaff_uploads";

/** Returns the `id` of the upload currently flagged `is_current`, or null when none is flagged yet. */
export async function getCurrentHubstaffUploadId(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from(HUBSTAFF_UPLOADS_TABLE)
    .select("id")
    .eq("is_current", true)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  const id = (data as { id?: string } | null)?.id;
  return id ?? null;
}

/**
 * Creates a new `hubstaff_uploads` row (not yet current). Caller must later call
 * `promoteHubstaffUploadToCurrent` once the data rows are safely inserted.
 */
async function createPendingHubstaffUpload(
  supabase: SupabaseClient,
  sourceFile: string | undefined,
  rowCount: number,
  uploadedBy?: string | null,
): Promise<string> {
  const { data, error } = await supabase
    .from(HUBSTAFF_UPLOADS_TABLE)
    .insert({
      source_file: sourceFile ?? null,
      row_count: rowCount,
      is_current: false,
      uploaded_by: uploadedBy ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not create hubstaff_uploads row: ${error.message}`);
  const id = (data as { id?: string }).id;
  if (!id) throw new Error("hubstaff_uploads insert returned no id");
  return id;
}

/**
 * Lists Hubstaff upload history from `hubstaff_uploads`, newest first. Each row
 * has the metadata shown in the Payroll Wizard's "Source Files" panel: filename,
 * when it was uploaded, how many rows it carried, and whether it's the current
 * (active) upload.
 */
export async function listHubstaffUploads(): Promise<
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
    .from(HUBSTAFF_UPLOADS_TABLE)
    .select("id, source_file, uploaded_at, uploaded_by, row_count, is_current")
    .order("uploaded_at", { ascending: false });
  if (error) throw new Error(`Could not list hubstaff_uploads: ${error.message}`);
  return (data ?? []) as {
    id: string;
    source_file: string | null;
    uploaded_at: string;
    uploaded_by: string | null;
    row_count: number | null;
    is_current: boolean;
  }[];
}

/** Flips all other uploads to `is_current=false` and sets this one to `true`. */
async function promoteHubstaffUploadToCurrent(
  supabase: SupabaseClient,
  newUploadId: string,
): Promise<void> {
  const { error: clearErr } = await supabase
    .from(HUBSTAFF_UPLOADS_TABLE)
    .update({ is_current: false })
    .eq("is_current", true)
    .neq("id", newUploadId);
  if (clearErr) throw new Error(`Failed to clear prior current uploads: ${clearErr.message}`);

  const { error: setErr } = await supabase
    .from(HUBSTAFF_UPLOADS_TABLE)
    .update({ is_current: true })
    .eq("id", newUploadId);
  if (setErr) throw new Error(`Failed to mark upload ${newUploadId} current: ${setErr.message}`);
}

/**
 * Archives the Hubstaff weekly CSV as a new `hubstaff_uploads` row and tags the inserted
 * `hubstaff_hours` rows with that upload's id. The new upload becomes `is_current=true`;
 * prior uploads remain in the table but stop being visible to the Payroll Wizard.
 *
 * No rows are deleted — historical uploads are preserved for audit and rollback.
 */
export async function replaceHubstaffHoursFromCsvText(
  csvText: string,
  sourceFile?: string,
  uploadedBy?: string | null,
): Promise<{ rowCount: number; uploadId: string }> {
  const supabase = requireServiceRole();
  const table = getTableName();

  const grid = parseCsv(csvText);
  if (grid.length < 2) {
    throw new Error("CSV must include a header row and at least one data row.");
  }

  const csvHeaders = grid[0].map((h) => h.trim());
  const dataRows = grid.slice(1).filter((row) => row.some((cell) => cell.trim() !== ""));

  const insertCols = await resolveColumnMapping(csvHeaders, table);
  if (insertCols.length === 0) {
    throw new Error(
      "No CSV columns match public.hubstaff_hours. Ensure CSV column names match your Supabase table (case-insensitive).",
    );
  }

  const uploadId = await createPendingHubstaffUpload(supabase, sourceFile, dataRows.length, uploadedBy);

  const extras: Record<string, string | null> = { upload_id: uploadId };
  if (sourceFile) extras.source_file = sourceFile;

  const rowCount = await batchInsertRows(supabase, table, dataRows, insertCols, extras);
  await promoteHubstaffUploadToCurrent(supabase, uploadId);

  // Clear any derived daily-breakdown cache so readers recompute from the new upload.
  const { error: settingsErr } = await upsertAppSetting("hubstaff_daily_breakdown", "");
  if (settingsErr) {
    console.warn("[hubstaff_hours] could not clear hubstaff_daily_breakdown:", settingsErr);
  }

  return { rowCount, uploadId };
}

/**
 * Deletes all rows whose `source_file` matches (for removing one uploaded CSV batch).
 */
export async function deleteHubstaffRowsBySourceFile(sourceFile: string): Promise<{ deleted: number }> {
  const supabase = requireServiceRole();
  const table = getTableName();
  const specCols = await getTableColumnsFromSpec(table);
  if (!specCols.includes("source_file")) {
    throw new Error(
      "public.hubstaff_hours has no source_file column. Add a text column `source_file` in Supabase to track and delete uploads.",
    );
  }

  const { count: nMatch, error: countErr } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("source_file", sourceFile);
  if (countErr) throw new Error(countErr.message);
  const toDelete = nMatch ?? 0;
  if (toDelete === 0) {
    return { deleted: 0 };
  }

  const { error: delErr } = await supabase.from(table).delete().eq("source_file", sourceFile);
  if (delErr) throw new Error(delErr.message);
  return { deleted: toDelete };
}

/**
 * Back-compat shim: append mode no longer exists as distinct behavior — every upload
 * is archived and becomes the new current (latest always wins in the Payroll Wizard).
 * The API route still accepts `mode=append`; it routes here.
 */
export async function appendHubstaffHoursFromCsvText(
  csvText: string,
  sourceFile?: string,
): Promise<{ rowCount: number; uploadId: string }> {
  return replaceHubstaffHoursFromCsvText(csvText, sourceFile);
}

/**
 * Returns distinct source_file values from hubstaff_hours, **newest upload first**
 * (by max row `id` per `source_file`). Older files are kept for reference; the Payroll
 * Wizard uses `files[0]` as the active timesheet batch.
 */
export async function getUploadedSourceFiles(): Promise<string[]> {
  const supabase = requireServiceRole();
  const table = getTableName();

  const specCols = await getTableColumnsFromSpec(table);
  if (!specCols.includes("source_file")) {
    return [];
  }

  const PAGE = 1000;
  /** source_file → max(id) for that upload batch */
  const maxIdByFile = new Map<string, number>();
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("id,source_file")
      .not("source_file", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as { id: unknown; source_file: string }[];
    for (const r of page) {
      const fn = (r.source_file ?? "").trim();
      if (!fn) continue;
      const idNum = Number(r.id);
      if (!Number.isFinite(idNum)) continue;
      const prev = maxIdByFile.get(fn) ?? 0;
      if (idNum > prev) maxIdByFile.set(fn, idNum);
    }
    if (page.length < PAGE) break;
    from += PAGE;
  }

  return [...maxIdByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file);
}

/**
 * Fetches rows from hubstaff_hours filtered by source_file.
 */
export async function fetchHubstaffRowsBySourceFile(sourceFile: string): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
}> {
  const supabase = requireServiceRole();
  const table = getTableName();

  const specCols = await getTableColumnsFromSpec(table);
  if (!specCols.includes("source_file")) {
    return { columns: [], rows: [] };
  }

  const PAGE = 1000;
  const allRows: Record<string, unknown>[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .eq("source_file", sourceFile)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Record<string, unknown>[];
    allRows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }

  const rows = allRows.filter((r) => !rowIsEmpty(r));

  let columns =
    rows.length > 0
      ? Object.keys(rows[0])
      : allRows.length > 0
        ? Object.keys(allRows[0])
        : await getTableColumnsFromSpec(table);

  columns = sortHubstaffColumnsForDisplay(columns);

  return { columns, rows };
}

export function rowsToPayrollRows(rows: Record<string, unknown>[]): PayrollHubstaffRow[] {
  return rows.map((r) => mapHubstaffHoursRow(r));
}
