import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseCsv } from "@/lib/csv/parse-csv";

const RATES_UPLOADS_TABLE = "rates_uploads";

function getRatesTableName(): string {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() ||
    "employee_hourly_rates"
  );
}

function requireServiceRole(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required to sync employee_hourly_rates. Add it to .env (Supabase → Project Settings → API → service_role key).",
    );
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function normHeader(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeEmail(v: unknown): string | null {
  if (v == null) return null;
  const trimmed = String(v).trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

function findHeaderIndex(headers: string[], ...targets: string[]): number {
  const norms = headers.map(normHeader);
  for (const target of targets) {
    const t = normHeader(target);
    const idx = norms.indexOf(t);
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Parses a "Week M/D/YY - M/D/YY" cell into the start date's epoch ms. Returns
 * Number.NEGATIVE_INFINITY when absent/unparseable so those rows sort to the
 * bottom during latest-week selection (they lose to any row with a real week).
 */
function parseWeekStartTs(week: unknown): number {
  if (week == null) return Number.NEGATIVE_INFINITY;
  const m = /Week\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*[-–]/i.exec(String(week).trim());
  if (!m) return Number.NEGATIVE_INFINITY;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  const ts = Date.UTC(year, month - 1, day);
  return Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY;
}

function parseRate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const cleaned = s.replace(/[^\d.\-]/g, "");
  if (!cleaned) return null;
  if (Number.isNaN(Number(cleaned))) return null;
  return cleaned;
}

async function createPendingRatesUpload(
  supabase: SupabaseClient,
  sourceFile: string | undefined,
  rowCount: number,
): Promise<string> {
  const { data, error } = await supabase
    .from(RATES_UPLOADS_TABLE)
    .insert({
      source_file: sourceFile ?? null,
      row_count: rowCount,
      is_current: false,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not create rates_uploads row: ${error.message}`);
  const id = (data as { id?: string }).id;
  if (!id) throw new Error("rates_uploads insert returned no id");
  return id;
}

async function promoteRatesUploadToCurrent(
  supabase: SupabaseClient,
  newUploadId: string,
): Promise<void> {
  const { error: clearErr } = await supabase
    .from(RATES_UPLOADS_TABLE)
    .update({ is_current: false })
    .eq("is_current", true)
    .neq("id", newUploadId);
  if (clearErr) throw new Error(`Failed to clear prior current uploads: ${clearErr.message}`);

  const { error: setErr } = await supabase
    .from(RATES_UPLOADS_TABLE)
    .update({ is_current: true })
    .eq("id", newUploadId);
  if (setErr) throw new Error(`Failed to mark upload ${newUploadId} current: ${setErr.message}`);
}

/** Newest-first list of rates upload batches (for the admin CSV imports tab). */
export async function listRatesUploads(): Promise<
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
    .from(RATES_UPLOADS_TABLE)
    .select("id, source_file, uploaded_at, uploaded_by, row_count, is_current")
    .order("uploaded_at", { ascending: false });
  if (error) throw new Error(`Could not list rates_uploads: ${error.message}`);
  return (data ?? []) as {
    id: string;
    source_file: string | null;
    uploaded_at: string;
    uploaded_by: string | null;
    row_count: number | null;
    is_current: boolean;
  }[];
}

/** Id of the rates upload currently flagged `is_current`, or null if none. */
export async function getCurrentRatesUploadId(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { data, error } = await supabase
    .from(RATES_UPLOADS_TABLE)
    .select("id")
    .eq("is_current", true)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  const id = (data as { id?: string } | null)?.id;
  return id ?? null;
}

/**
 * Archives a rates CSV (the xlsx "All Dept" sheet export — weekly payroll ledger)
 * and reconciles `employee_hourly_rates` by `work_email`, falling back to
 * `personal_email` when an employee's work email has drifted between tables.
 *
 * The CSV has one row per (employee, pay week). For each work_email we keep the
 * rate from the LATEST week's row (parsed from the "Week" column). Only 5 columns
 * are read: Work Email, Personal Email, Week, Regular Rate, OT Rate. Everything
 * else (hours, bonuses, totals, bank info, transaction IDs) is ignored — the UI
 * computes pay totals from hours × rate.
 *
 * No rows deleted. Prior rates rows stay tagged with their old `upload_id` for
 * historical lineage; the new upload becomes `is_current=true`.
 */
export async function replaceEmployeeHourlyRatesFromCsv(
  csvText: string,
  sourceFile: string,
): Promise<{
  rowCount: number;
  uploadId: string;
  inserted: number;
  updated: number;
  uniqueEmployees: number;
  skippedNoWorkEmail: number;
  skippedNoRate: number;
}> {
  const supabase = requireServiceRole();
  const table = getRatesTableName();

  const grid = parseCsv(csvText);
  if (grid.length < 2) {
    throw new Error("CSV must include a header row and at least one data row.");
  }

  const headers = grid[0].map((h) => (h ?? "").toString());
  const workEmailIdx = findHeaderIndex(headers, "Work Email");
  const personalEmailIdx = findHeaderIndex(headers, "Personal Email");
  const regularRateIdx = findHeaderIndex(headers, "Regular Rate");
  const otRateIdx = findHeaderIndex(headers, "OT Rate");
  const weekIdx = findHeaderIndex(headers, "Week");
  // "Bank Preferred" is the HR-set fallback used by Payment Dispatch when an
  // employee hasn't picked a processor in their dashboard. We sync it here but
  // never touch employee_ids columns — those are written exclusively from the
  // employee profile UI (`/api/update-employee-ids`) and outrank this value
  // inside `mock-queue.ts:174`. Aliases cover the most plausible label
  // variations on the All Dept sheet.
  const bankPreferredIdx = findHeaderIndex(
    headers,
    "Bank Preferred",
    "Preferred Bank",
    "bank_preferred",
    "BankPreferred",
  );
  const mesaParticipantIdx = findHeaderIndex(
    headers,
    "MESA Participant",
    "Mesa Participant",
    "mesa_participant",
    "MESA Member",
    "Mesa Member",
  );

  const missing: string[] = [];
  if (workEmailIdx < 0) missing.push("Work Email");
  if (personalEmailIdx < 0) missing.push("Personal Email");
  if (regularRateIdx < 0) missing.push("Regular Rate");
  if (otRateIdx < 0) missing.push("OT Rate");
  if (missing.length > 0) {
    throw new Error(
      `Rates CSV is missing required columns: ${missing.join(", ")}. Export the "All Dept" sheet with headers on row 1.`,
    );
  }

  type Candidate = {
    workEmail: string;
    personalEmail: string | null;
    regularRate: string;
    otRate: string | null;
    weekTs: number;
    /** Free-text bank label from the sheet (e.g. "Wise", "BPI"). Null when the
     *  cell is blank — payload below skips the field entirely so a blank cell
     *  never clobbers an existing DB value. */
    bankPreferred: string | null;
    /** True when the sheet cell is "Yes" (case-insensitive). Null when blank —
     *  blank is treated as no-change so a missing cell never un-enrolls someone. */
    mesaMember: boolean | null;
  };

  let skippedNoWorkEmail = 0;
  let skippedNoRate = 0;
  const candidates: Candidate[] = [];

  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row || row.every((c) => (c ?? "").toString().trim() === "")) continue;

    const workEmail = normalizeEmail(row[workEmailIdx]);
    if (!workEmail) {
      skippedNoWorkEmail += 1;
      continue;
    }
    const regularRate = parseRate(row[regularRateIdx]);
    if (!regularRate) {
      skippedNoRate += 1;
      continue;
    }

    let bankPreferred: string | null = null;
    if (bankPreferredIdx >= 0) {
      const raw = String(row[bankPreferredIdx] ?? "").trim();
      bankPreferred = raw === "" ? null : raw;
    }

    let mesaMember: boolean | null = null;
    if (mesaParticipantIdx >= 0) {
      const raw = String(row[mesaParticipantIdx] ?? "").trim().toLowerCase();
      if (raw !== "") mesaMember = raw === "yes";
    }

    candidates.push({
      workEmail,
      personalEmail: normalizeEmail(row[personalEmailIdx]),
      regularRate,
      otRate: parseRate(row[otRateIdx]),
      weekTs: weekIdx >= 0 ? parseWeekStartTs(row[weekIdx]) : 0,
      bankPreferred,
      mesaMember,
    });
  }

  if (candidates.length === 0) {
    throw new Error(
      "No rows with a usable Work Email + Regular Rate. Check the CSV export and header row.",
    );
  }

  const byEmail = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = byEmail.get(c.workEmail);
    if (!prev || c.weekTs > prev.weekTs) {
      // Carry forward mesa=true from any older row — a blank cell in the latest
      // week must not silently un-enroll someone who had "Yes" in a prior week.
      const mesaMember = (prev?.mesaMember === true && c.mesaMember !== true)
        ? true
        : c.mesaMember;
      byEmail.set(c.workEmail, { ...c, mesaMember });
    } else if (c.mesaMember === true && prev.mesaMember !== true) {
      // Older row but has "Yes" — propagate it onto the already-kept latest row.
      byEmail.set(c.workEmail, { ...prev, mesaMember: true });
    }
  }

  const finalRows = [...byEmail.values()];
  const uniqueEmployees = finalRows.length;

  const uploadId = await createPendingRatesUpload(supabase, sourceFile, uniqueEmployees);

  // Fetch ALL rows with a non-null Work Email and index by lowercased identity
  // in memory. The previous chunked `.in('"Work Email"', …)` lookup was
  // case-sensitive, so DB rows whose email had any case variance (legacy
  // backfill, manual edits) were invisible — those rows then collided with
  // the unique index when we tried to INSERT their CSV counterparts.
  // For roster sizes the system targets (≤ a few thousand rows) one full pass
  // is faster than chunked queries anyway.
  const existingByWorkEmail = new Map<string, { id: unknown }>();
  const existingByPersonalEmail = new Map<string, { id: unknown }>();
  {
    const { data, error } = await supabase
      .from(table)
      .select('id, "Work Email", "Personal Email"')
      .not('"Work Email"', "is", null)
      .range(0, 9999);
    if (error) throw new Error(`Could not read ${table} for reconciliation: ${error.message}`);
    for (const r of (data ?? []) as {
      id: unknown;
      "Work Email": string | null;
      "Personal Email": string | null;
    }[]) {
      const workEmail = normalizeEmail(r["Work Email"]);
      const personalEmail = normalizeEmail(r["Personal Email"]);
      if (workEmail) existingByWorkEmail.set(workEmail, { id: r.id });
      if (personalEmail) existingByPersonalEmail.set(personalEmail, { id: r.id });
    }
  }

  // Partition into UPDATE-targets and INSERT-payloads.
  const updateOps: { id: string | number; payload: Record<string, string | null> }[] = [];
  const rowsToInsert: Record<string, string | null>[] = [];

  for (const c of finalRows) {
    const payload: Record<string, string | null> = {
      "Work Email": c.workEmail,
      "Personal Email": c.personalEmail,
      "Regular Rate": c.regularRate,
      "OT Rate": c.otRate,
    };
    // No-clobber guard: only write Bank Preferred when the sheet cell has a
    // value. A blank cell leaves the existing DB value alone — covers the case
    // where HR has only some employees filled in on the sheet, or where an
    // admin already set the value through Supabase directly. Employee-set
    // bank info lives on `employee_ids` and is never touched here.
    if (c.bankPreferred != null) {
      payload["Bank Preferred"] = c.bankPreferred;
    }
    (payload as Record<string, unknown>)["mesa_member"] = c.mesaMember ?? false;

    const existing =
      existingByWorkEmail.get(c.workEmail) ??
      (c.personalEmail ? existingByPersonalEmail.get(c.personalEmail) : undefined);
    if (existing) {
      updateOps.push({
        id: existing.id as string | number,
        payload: { ...payload, upload_id: uploadId },
      });
    } else {
      rowsToInsert.push({ ...payload, upload_id: uploadId });
    }
  }

  // UPDATEs in parallel chunks — each row touches a distinct primary key, so
  // there's no deadlock risk. Concurrency of 20 keeps things fast without
  // starving the Supabase connection pool.
  let inserted = 0;
  let updated = 0;
  if (updateOps.length > 0) {
    const UPDATE_CONCURRENCY = 20;
    for (let start = 0; start < updateOps.length; start += UPDATE_CONCURRENCY) {
      const chunk = updateOps.slice(start, start + UPDATE_CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ id, payload }) => {
          const { error } = await supabase.from(table).update(payload).eq("id", id);
          if (error) throw new Error(`Update failed for id ${String(id)}: ${error.message}`);
        }),
      );
      updated += chunk.length;
    }
  }

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

  await promoteRatesUploadToCurrent(supabase, uploadId);

  return {
    rowCount: inserted + updated,
    uploadId,
    inserted,
    updated,
    uniqueEmployees,
    skippedNoWorkEmail,
    skippedNoRate,
  };
}
