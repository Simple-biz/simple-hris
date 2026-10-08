/**
 * The HRIS's own copy of the hiring database — `hr_new_hire_source_rows`
 * (references/sql/create/2026-10-08_hr_new_hire_source_rows.sql) — plus the
 * checklist reads the sync needs. Server-only, service role (RLS on, no policies).
 *
 * Nothing in this file deletes a row. The copy is upserted by `source_key` and
 * only ever moves FORWARD through placement states; a placed hire keeps its
 * `placed_at` even after HR deletes the checklist row (ON DELETE SET NULL), which
 * is what stops the next poll from listing it again.
 *
 * Doc: docs/features/new-hire-source-sync.md
 */

import { createSupabaseServiceRoleClient } from "./server";
import { selectAllPaged } from "./select-all-paged";
import { HIRES_SOURCE_FIELDS, type HiresSourceField } from "@/lib/hr/hires-source-config";
import type { ChecklistIndexRow, HireValues, HoldReason } from "@/lib/hr/hires-source-map";

const TABLE = "hr_new_hire_source_rows";
const CHECKLIST = "hr_new_hire_checklist";
const PERIODS = "hr_new_hire_checklist_periods";

export const HIRES_SYNC_MIGRATION_COMMAND =
  "node --import tsx scripts/apply-hr-new-hire-source-sync-migration.mts --apply";

/** Keep `.in()` lists short: a long id list overflows the PostgREST URL (postgrest-url-ceiling). */
const IN_CHUNK = 100;
const UPSERT_CHUNK = 500;

export type SourcePlacement = "pending" | "placed" | "linked" | "held";

export type SourceRow = HireValues & {
  source_key: string;
  interview_at: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  content_hash: string;
  first_pulled_at: string;
  last_changed_at: string;
  target_period_start: string | null;
  placement: SourcePlacement;
  hold_reason: HoldReason | null;
  checklist_row_id: string | null;
  placed_at: string | null;
  placed_by: string | null;
  applied_values: Partial<HireValues> | null;
};

/** What the sync writes for a new or changed source hire (never placement state). */
export type SourceRowWrite = HireValues & {
  source_key: string;
  interview_at: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  content_hash: string;
  last_changed_at: string;
};

/** Placement fields — written only by the sync's decisions and HR's manual placement. */
export type SourcePlacementPatch = {
  placement: SourcePlacement;
  hold_reason: HoldReason | null;
  target_period_start: string | null;
  checklist_row_id?: string | null;
  placed_at?: string | null;
  placed_by?: string | null;
  applied_values?: Partial<HireValues> | null;
};

function client() {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) throw new Error("Supabase service role is not configured");
  return sb;
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Is the migration applied? Probes BOTH halves — the copy table and the three
 * checklist columns — with `count: 'exact'` and no `head` (a HEAD count against
 * a missing table can come back as a clean zero:
 * memory/postgrest-head-true-hides-missing-table).
 */
export async function probeHiresSyncTables(): Promise<{ ready: boolean; reason: string | null }> {
  const sb = client();
  const [copy, cols] = await Promise.all([
    sb.from(TABLE).select("source_key", { count: "exact" }).limit(1),
    sb.from(CHECKLIST).select("origin, source_key, received_at").limit(1),
  ]);
  const err = copy.error ?? cols.error;
  if (err) {
    return {
      ready: false,
      reason: `The hires-sync migration is not applied yet (${err.message}). Run: ${HIRES_SYNC_MIGRATION_COMMAND}`,
    };
  }
  return { ready: true, reason: null };
}

const SOURCE_SELECT = [
  "source_key",
  ...HIRES_SOURCE_FIELDS,
  "interview_at",
  "source_created_at",
  "source_updated_at",
  "content_hash",
  "first_pulled_at",
  "last_changed_at",
  "target_period_start",
  "placement",
  "hold_reason",
  "checklist_row_id",
  "placed_at",
  "placed_by",
  "applied_values",
].join(", ");

/** Every row of the copy, paged on a total order. */
export async function listSourceRows(): Promise<{ rows: SourceRow[]; error: string | null }> {
  const sb = client();
  return selectAllPaged<SourceRow>((from, to) =>
    sb
      .from(TABLE)
      .select(SOURCE_SELECT)
      .order("source_key", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: SourceRow[] | null; error: { message: string } | null }>,
  );
}

/** The held hires, newest first — what HR places by hand. */
export async function listHeldSourceRows(): Promise<{ rows: SourceRow[]; error: string | null }> {
  const sb = client();
  return selectAllPaged<SourceRow>((from, to) =>
    sb
      .from(TABLE)
      .select(SOURCE_SELECT)
      .eq("placement", "held")
      .order("first_pulled_at", { ascending: false })
      .order("source_key", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: SourceRow[] | null; error: { message: string } | null }>,
  );
}

export async function getSourceRow(sourceKey: string): Promise<{ row: SourceRow | null; error: string | null }> {
  const { data, error } = await client().from(TABLE).select(SOURCE_SELECT).eq("source_key", sourceKey).maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: (data ?? null) as SourceRow | null, error: null };
}

/**
 * Upsert new and changed source hires by `source_key`. Only the value columns,
 * the hash and the stamps are sent, so an existing row keeps its
 * `first_pulled_at` and its placement state; a new row takes the defaults
 * (`first_pulled_at = now()`, `placement = 'pending'`).
 */
export async function upsertSourceRows(rows: SourceRowWrite[]): Promise<{ error: string | null }> {
  if (rows.length === 0) return { error: null };
  const sb = client();
  for (const part of chunks(rows, UPSERT_CHUNK)) {
    const { error } = await sb.from(TABLE).upsert(part, { onConflict: "source_key" });
    if (error) return { error: error.message };
  }
  return { error: null };
}

export async function updateSourcePlacement(
  sourceKey: string,
  patch: SourcePlacementPatch,
): Promise<{ error: string | null }> {
  const { error } = await client().from(TABLE).update(patch).eq("source_key", sourceKey);
  return { error: error?.message ?? null };
}

export type ChecklistContextRow = ChecklistIndexRow & {
  department: string | null;
  source: string | null;
};

/**
 * Every checklist row the placement decision compares against, paged on `id`
 * (the table is past 1,800 rows; an unpaged read silently stops at 1,000 and
 * would let a duplicate through).
 */
export async function listChecklistContext(): Promise<{ rows: ChecklistContextRow[]; error: string | null }> {
  const sb = client();
  return selectAllPaged<ChecklistContextRow>((from, to) =>
    sb
      .from(CHECKLIST)
      .select("id, period_start, personal_email, name, department, source")
      .not("period_start", "is", null)
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
      data: ChecklistContextRow[] | null;
      error: { message: string } | null;
    }>,
  );
}

/** The weeks that are locked right now. */
export async function listLockedChecklistWeeks(): Promise<{ weeks: Set<string>; error: string | null }> {
  const sb = client();
  const { rows, error } = await selectAllPaged<{ period_start: string }>((from, to) =>
    sb
      .from(PERIODS)
      .select("period_start")
      .eq("status", "locked")
      .order("period_start", { ascending: true })
      .range(from, to),
  );
  if (error) return { weeks: new Set(), error };
  return { weeks: new Set(rows.map((r) => r.period_start)), error: null };
}

export type ChecklistCells = { id: string; period_start: string | null } & Partial<
  Record<HiresSourceField, string | null>
>;

/** The current cells of the named checklist rows (chunked `.in()`). */
export async function getChecklistCells(ids: string[]): Promise<{ rows: Map<string, ChecklistCells>; error: string | null }> {
  const out = new Map<string, ChecklistCells>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return { rows: out, error: null };
  const sb = client();
  for (const part of chunks(unique, IN_CHUNK)) {
    const { data, error } = await sb
      .from(CHECKLIST)
      .select(["id", "period_start", ...HIRES_SOURCE_FIELDS].join(", "))
      .in("id", part);
    if (error) return { rows: out, error: error.message };
    for (const r of (data ?? []) as unknown as ChecklistCells[]) out.set(r.id, r);
  }
  return { rows: out, error: null };
}

/** The checklist row a source hire was placed as (after losing an insert race). */
export async function findChecklistRowBySourceKey(
  sourceKey: string,
): Promise<{ row: { id: string; period_start: string | null } | null; error: string | null }> {
  const { data, error } = await client()
    .from(CHECKLIST)
    .select("id, period_start")
    .eq("source_key", sourceKey)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: (data ?? null) as { id: string; period_start: string | null } | null, error: null };
}
