import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { HslAgentRow } from "@/lib/google-sheets/fetch-hsl-sheet";

const HSL_AGENTS_TABLE = "hsl_team_members";
const HSL_UPLOADS_TABLE = "hsl_agent_uploads";

function requireServiceRole(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required to sync HSL agents. Add it to .env (Supabase → Project Settings → API → service_role key).",
    );
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function createPendingHslUpload(
  supabase: SupabaseClient,
  sourceFile: string,
  rowCount: number,
): Promise<string> {
  const { data, error } = await supabase
    .from(HSL_UPLOADS_TABLE)
    .insert({
      source_file: sourceFile || null,
      row_count: rowCount,
      is_current: false,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not create ${HSL_UPLOADS_TABLE} row: ${error.message}`);
  const id = (data as { id?: string }).id;
  if (!id) throw new Error(`${HSL_UPLOADS_TABLE} insert returned no id`);
  return id;
}

async function promoteHslUploadToCurrent(
  supabase: SupabaseClient,
  newUploadId: string,
): Promise<void> {
  const { error: clearErr } = await supabase
    .from(HSL_UPLOADS_TABLE)
    .update({ is_current: false })
    .eq("is_current", true)
    .neq("id", newUploadId);
  if (clearErr) throw new Error(`Failed to clear prior current uploads: ${clearErr.message}`);

  const { error: setErr } = await supabase
    .from(HSL_UPLOADS_TABLE)
    .update({ is_current: true })
    .eq("id", newUploadId);
  if (setErr) throw new Error(`Failed to mark upload ${newUploadId} current: ${setErr.message}`);
}

export interface ReplaceHslAgentsResult {
  rowCount: number;
  uploadId: string;
  inserted: number;
  updated: number;
  /** Rows in the input that shared a `LOWER(email)` with another input row.
   *  Last occurrence wins. */
  duplicatesInInput: number;
}

/**
 * Upsert a fully-fetched batch of HSL agent rows into `hsl_team_members`,
 * stamped with a new row in `hsl_agent_uploads` that becomes `is_current`.
 *
 * Mirrors the master/rates ingest pattern (case-insensitive lookup via a
 * single full-table SELECT, parallel UPDATE chunks, batched INSERTs):
 *   1. Insert pending upload row (is_current=false).
 *   2. Dedupe input by LOWER(email) — last wins.
 *   3. Single full-table SELECT of existing rows; build email→id map.
 *   4. Partition into UPDATE / INSERT batches.
 *   5. Run UPDATEs in parallel chunks of 20; INSERTs in batches of 50.
 *   6. Promote the new upload to is_current=true.
 *
 * `dept_key` and `is_manager` are intentionally NOT touched on UPDATE — they
 * live on the existing seed rows and there is no reliable way to derive them
 * from the role text alone (e.g. "Case Manager" is is_manager=false despite
 * the title). On INSERT they default to NULL / false; manual classification
 * still happens in Supabase or via `references/seed_hsl_team_members.sql`.
 */
export async function replaceHslAgentsFromRows(
  rows: HslAgentRow[],
  sourceFile: string,
): Promise<ReplaceHslAgentsResult> {
  const supabase = requireServiceRole();

  // Dedupe input by lowercased email — last occurrence wins.
  const byEmail = new Map<string, HslAgentRow>();
  for (const r of rows) byEmail.set(r.email, r);
  const duplicatesInInput = rows.length - byEmail.size;
  const finalRows = [...byEmail.values()];
  if (finalRows.length === 0) {
    throw new Error("No usable rows in the HSL sheet (every row was missing an email).");
  }

  const uploadId = await createPendingHslUpload(supabase, sourceFile, finalRows.length);

  // Fetch ALL existing hsl_team_members rows, index by LOWER(email).
  // Same case-insensitive-in-memory pattern we use for master + rates ingests.
  const existingByEmail = new Map<string, { email: string }>();
  {
    const { data, error } = await supabase
      .from(HSL_AGENTS_TABLE)
      .select("email")
      .range(0, 9999);
    if (error) throw new Error(`Could not read ${HSL_AGENTS_TABLE} for reconciliation: ${error.message}`);
    for (const r of (data ?? []) as { email: string | null }[]) {
      const e = (r.email ?? "").trim().toLowerCase();
      if (e) existingByEmail.set(e, { email: r.email ?? "" });
    }
  }

  const updateOps: { existingEmail: string; payload: Record<string, unknown> }[] = [];
  const rowsToInsert: Record<string, unknown>[] = [];

  for (const r of finalRows) {
    const payload: Record<string, unknown> = {
      // Sheet-sourced fields:
      role_raw: r.role,
      full_name: r.fullName,
      hsl_name: r.hslName,
      hourly_rate: r.hourlyRate,
      ot_rate: r.otRate,
      kpi_bonus: r.kpiBonus,
      upload_id: uploadId,
      updated_at: new Date().toISOString(),
    };

    const hit = existingByEmail.get(r.email);
    if (hit) {
      updateOps.push({ existingEmail: hit.email, payload });
    } else {
      // New row — set the primary key (email column on hsl_team_members).
      // dept_key + is_manager intentionally left at table defaults (NULL / false).
      rowsToInsert.push({ email: r.email, ...payload });
    }
  }

  // UPDATEs in parallel chunks (avoid the per-row sequential Supabase round-trips).
  let inserted = 0;
  let updated = 0;
  if (updateOps.length > 0) {
    const UPDATE_CONCURRENCY = 20;
    for (let start = 0; start < updateOps.length; start += UPDATE_CONCURRENCY) {
      const chunk = updateOps.slice(start, start + UPDATE_CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ existingEmail, payload }) => {
          const { error } = await supabase
            .from(HSL_AGENTS_TABLE)
            .update(payload)
            .eq("email", existingEmail);
          if (error) {
            throw new Error(`Update failed for ${existingEmail}: ${error.message}`);
          }
        }),
      );
      updated += chunk.length;
    }
  }

  if (rowsToInsert.length > 0) {
    const BATCH = 50;
    for (let start = 0; start < rowsToInsert.length; start += BATCH) {
      const batch = rowsToInsert.slice(start, start + BATCH);
      const { error } = await supabase.from(HSL_AGENTS_TABLE).insert(batch);
      if (error) {
        throw new Error(`Insert failed (batch ${start}–${start + batch.length}): ${error.message}`);
      }
      inserted += batch.length;
    }
  }

  await promoteHslUploadToCurrent(supabase, uploadId);

  return {
    rowCount: inserted + updated,
    uploadId,
    inserted,
    updated,
    duplicatesInInput,
  };
}

/** Newest-first list of HSL upload batches — for the Files tab. */
export async function listHslUploads(): Promise<
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
    .from(HSL_UPLOADS_TABLE)
    .select("id, source_file, uploaded_at, uploaded_by, row_count, is_current")
    .order("uploaded_at", { ascending: false });
  if (error) throw new Error(`Could not list ${HSL_UPLOADS_TABLE}: ${error.message}`);
  return (data ?? []) as {
    id: string;
    source_file: string | null;
    uploaded_at: string;
    uploaded_by: string | null;
    row_count: number | null;
    is_current: boolean;
  }[];
}
