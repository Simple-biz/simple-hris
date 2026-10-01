/**
 * HRIS vs NPD "Save output" persistence. Server-only (service role).
 * Tables + function: references/sql/create/2026-10-01_payroll_wizard_npd_comparisons.sql.
 * Governing doc: docs/features/payroll-wizard-hris-vs-npd.md § Saving the output.
 *
 * Reads are HEADER-ONLY and one row (the newest version of a week), so the PostgREST
 * 1000-row cap cannot bite them. Nothing here updates or deletes: a saved output never
 * changes (the database refuses an UPDATE), and cleanup is Kane's call.
 *
 * A failed read is an ERROR, never "nothing saved" — the Output would then tell the
 * clerk the week has no saved output when it has one.
 */
import { classifyTableProbe } from '@/lib/db/probe-verdict';
import type { HrisNpdSaveMeta, HrisNpdSnapshot } from '@/lib/payroll/hris-npd-snapshot';
import { createSupabaseServiceRoleClient } from './server';

export const HRIS_NPD_SAVE_NOT_SET_UP =
  'Saving the HRIS vs NPD output is not set up yet: its tables are not in the database. Run scripts/apply-payroll-wizard-npd-comparisons-migration.mts --apply.';

export type HrisNpdSaveFailure = { ok: false; missing: boolean; error: string };

function failure(error: { code?: string | null; message: string }): HrisNpdSaveFailure {
  // PGRST202 = the function is not in PostgREST's schema cache.
  const missing = classifyTableProbe(error) === 'MISSING' || error.code === 'PGRST202';
  return { ok: false, missing, error: missing ? HRIS_NPD_SAVE_NOT_SET_UP : error.message };
}

const HEADER_COLUMNS =
  'id, version, saved_at, saved_by, tolerance_cents, row_count, left_out_count, match_count, mismatch_count, not_in_hris_count, not_in_npd_count';

type HeaderRow = {
  id: string;
  version: number;
  saved_at: string;
  saved_by: string;
  tolerance_cents: number;
  row_count: number;
  left_out_count: number;
  match_count: number;
  mismatch_count: number;
  not_in_hris_count: number;
  not_in_npd_count: number;
};

function metaOf(h: HeaderRow): HrisNpdSaveMeta {
  return {
    id: h.id,
    version: Number(h.version),
    savedAt: h.saved_at,
    savedBy: h.saved_by,
    toleranceCents: Number(h.tolerance_cents),
    rowCount: Number(h.row_count),
    leftOutCount: Number(h.left_out_count),
    counts: {
      match: Number(h.match_count),
      mismatch: Number(h.mismatch_count),
      not_in_hris: Number(h.not_in_hris_count),
      not_in_npd: Number(h.not_in_npd_count),
    },
  };
}

/** The newest saved output of a week, or null when the week has none. */
export async function readLatestHrisNpdSave(
  sourceFile: string,
): Promise<{ ok: true; latest: HrisNpdSaveMeta | null } | HrisNpdSaveFailure> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, missing: false, error: 'Supabase is not configured' };
  const { data, error } = await supabase
    .from('payroll_wizard_npd_comparisons')
    .select(HEADER_COLUMNS)
    .eq('source_file', sourceFile)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return failure(error);
  return { ok: true, latest: data ? metaOf(data as HeaderRow) : null };
}

/**
 * Append one validated snapshot as the week's next version — or, when its hash equals the
 * newest version's, get that version back with `unchanged: true` and write nothing. One
 * transaction in `payroll_wizard_save_npd_comparison`, which also proves the counts,
 * totals and every verdict before it returns.
 */
export async function saveHrisNpdSnapshot(args: {
  sourceFile: string;
  savedBy: string;
  contentSha256: string;
  snapshot: HrisNpdSnapshot;
}): Promise<{ ok: true; latest: HrisNpdSaveMeta; unchanged: boolean } | HrisNpdSaveFailure> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, missing: false, error: 'Supabase is not configured' };
  const { data, error } = await supabase.rpc('payroll_wizard_save_npd_comparison', {
    p_source_file: args.sourceFile,
    p_saved_by: args.savedBy,
    p_content_sha256: args.contentSha256,
    p_snapshot: args.snapshot,
  });
  if (error) return failure(error);
  const row = (Array.isArray(data) ? data[0] : data) as { comparison_id?: string; unchanged?: boolean } | null;
  if (!row?.comparison_id) return { ok: false, missing: false, error: 'The save returned nothing' };

  // Read the saved header back rather than echo the request: what the Output then shows
  // is what the database holds.
  const { data: head, error: readError } = await supabase
    .from('payroll_wizard_npd_comparisons')
    .select(HEADER_COLUMNS)
    .eq('id', row.comparison_id)
    .maybeSingle();
  if (readError) return failure(readError);
  if (!head) return { ok: false, missing: false, error: 'The saved output could not be read back' };
  return { ok: true, latest: metaOf(head as HeaderRow), unchanged: row.unchanged === true };
}
