import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseCsv } from "@/lib/csv/parse-csv";
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
 * Fetches column names from the PostgREST OpenAPI spec.
 * Returns them in the order PostgREST exposes them (alphabetical from the spec),
 * which is used as a fallback when the table is empty.
 */
async function getTableColumnsFromSpec(table: string): Promise<string[]> {
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

  const columns =
    rows.length > 0
      ? Object.keys(rows[0])
      : allRows.length > 0
        ? Object.keys(allRows[0])
        : await getTableColumnsFromSpec(table);

  return { columns, rows };
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
  // Drop rows where every cell is empty or whitespace-only
  const dataRows = grid.slice(1).filter((row) => row.some((cell) => cell.trim() !== ""));

  // Determine which CSV columns map to DB columns.
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
    // The DB may have ISO date columns ("2026-03-24") while the CSV uses
    // Hubstaff-format names ("Mon 3/24"). Parse both to ISO and match.
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
        const csvIdx = csvDateMap.get(dbCol); // dbCol is already ISO
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

  if (insertCols.length === 0) {
    throw new Error(
      "No CSV columns match public.hubstaff_hours. Ensure CSV column names match your Supabase table (case-insensitive).",
    );
  }

  // Delete all existing rows (service_role bypasses RLS).
  const { error: deleteError } = await supabase
    .from(table)
    .delete()
    .not("id", "is", null);

  if (deleteError) {
    throw new Error(`Failed to clear ${table}: ${deleteError.message}`);
  }

  // Batch insert
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
      return obj;
    });

    const { error } = await supabase.from(table).insert(rows);
    if (error) throw new Error(`Insert failed (batch ${start}–${start + batch.length}): ${error.message}`);
    rowCount += batch.length;
  }

  return { rowCount };
}

export function rowsToPayrollRows(rows: Record<string, unknown>[]): PayrollHubstaffRow[] {
  return rows.map((r) => mapHubstaffHoursRow(r));
}
