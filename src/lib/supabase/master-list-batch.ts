import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * True when `import_batch_id` exists on the employees / master list table (PostgREST can select it).
 */
export async function masterListHasImportBatchColumn(
  supabase: SupabaseClient,
  table: string,
): Promise<boolean> {
  const { error } = await supabase.from(table).select("import_batch_id").limit(1);
  return !error;
}

/** Latest non-null import_batch_id (current roster CSV), or null if column missing / no batched rows. */
export async function getActiveMasterImportBatchId(
  supabase: SupabaseClient,
  table: string,
): Promise<number | null> {
  if (!(await masterListHasImportBatchColumn(supabase, table))) return null;
  const { data, error } = await supabase
    .from(table)
    .select("import_batch_id")
    .not("import_batch_id", "is", null)
    .order("import_batch_id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const id = (data as { import_batch_id?: number }).import_batch_id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

/** Next batch id for a new CSV append (max existing + 1, or 1 on empty table). */
export async function getNextMasterImportBatchId(
  supabase: SupabaseClient,
  table: string,
): Promise<number> {
  if (!(await masterListHasImportBatchColumn(supabase, table))) return 1;
  const { data, error } = await supabase
    .from(table)
    .select("import_batch_id")
    .order("import_batch_id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return 1;
  const id = (data as { import_batch_id?: number | null }).import_batch_id;
  return (typeof id === "number" && Number.isFinite(id) ? id : 0) + 1;
}

/** Batch id for add-employee / edits: same as latest CSV batch, or 1 before any CSV. */
export async function getCurrentMasterImportBatchForManualRow(
  supabase: SupabaseClient,
  table: string,
): Promise<number> {
  const active = await getActiveMasterImportBatchId(supabase, table);
  if (active != null) return active;
  if (!(await masterListHasImportBatchColumn(supabase, table))) return 1;
  return 1;
}
