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
async function deleteAllRowsInTable(supabase: SupabaseClient, table: string): Promise<void> {
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

/** Fetches ALL rows from hubstaff_hours (paginated, no hard cap), drops rows that are empty in every preview column. */
export async function fetchHubstaffRowsOrdered(): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
}> {
  const supabase = requireServiceRole();
  const table = getTableName();

  const PAGE = 1000; // PostgREST max per request
  const allRows: Record<string, unknown>[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as Record<string, unknown>[];
    allRows.push(...page);
    if (page.length < PAGE) break; // last page
    from += PAGE;
  }

  // Drop rows where every preview column is null / empty string
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
 * If sourceFile is provided, it is written to the `source_file` column on every row.
 */
async function batchInsertRows(
  supabase: SupabaseClient,
  table: string,
  dataRows: string[][],
  insertCols: { csvIdx: number; dbCol: string }[],
  sourceFile?: string,
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
      if (sourceFile) {
        obj["source_file"] = sourceFile;
      }
      return obj;
    });

    const { error } = await supabase.from(table).insert(rows);
    if (error) throw new Error(`Insert failed (batch ${start}–${start + batch.length}): ${error.message}`);
    rowCount += batch.length;
  }

  return rowCount;
}

/**
 * Replaces all rows in `public.hubstaff_hours` with data from the Hubstaff weekly CSV.
 * Uses SUPABASE_SERVICE_ROLE_KEY (bypasses RLS); works over HTTPS — no direct Postgres needed.
 */
export async function replaceHubstaffHoursFromCsvText(csvText: string): Promise<{ rowCount: number }> {
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

  // Remove prior upload completely, then clear saved daily fallback so reloads do not
  // merge old week columns with the new file.
  await deleteAllRowsInTable(supabase, table);
  const { error: settingsErr } = await upsertAppSetting("hubstaff_daily_breakdown", "");
  if (settingsErr) {
    console.warn("[hubstaff_hours] could not clear hubstaff_daily_breakdown:", settingsErr);
  }

  const rowCount = await batchInsertRows(supabase, table, dataRows, insertCols);
  return { rowCount };
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
 * Appends rows from the Hubstaff CSV to `public.hubstaff_hours` WITHOUT deleting existing data.
 * This allows continuously uploading weekly CSV files without overwriting previous uploads.
 * Stores the original filename in the `source_file` column for tracking.
 */
export async function appendHubstaffHoursFromCsvText(
  csvText: string,
  sourceFile?: string,
): Promise<{ rowCount: number }> {
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

  const specCols = await getTableColumnsFromSpec(table);
  const canStoreSourceFile = specCols.includes("source_file");
  const rowCount = await batchInsertRows(
    supabase,
    table,
    dataRows,
    insertCols,
    canStoreSourceFile ? sourceFile : undefined,
  );
  return { rowCount };
}

/**
 * Returns distinct source_file values from the hubstaff_hours table, ordered by filename.
 */
export async function getUploadedSourceFiles(): Promise<string[]> {
  const supabase = requireServiceRole();
  const table = getTableName();

  const specCols = await getTableColumnsFromSpec(table);
  if (!specCols.includes("source_file")) {
    return [];
  }

  // Paginate through all rows to collect every distinct source_file value.
  // PostgREST defaults to 1000 rows per request, which can miss files when
  // the table has more rows than that limit.
  const PAGE = 1000;
  const allSourceFiles = new Set<string>();
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("source_file")
      .not("source_file", "is", null)
      .order("source_file")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as { source_file: string }[];
    for (const r of page) {
      if (r.source_file && r.source_file.trim() !== "") {
        allSourceFiles.add(r.source_file);
      }
    }
    if (page.length < PAGE) break;
    from += PAGE;
  }

  return [...allSourceFiles].sort();
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
