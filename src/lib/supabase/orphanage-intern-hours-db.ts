import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from './select-all-paged';
import { parseInternHoursCsv, type InternHoursRefusedRow } from '@/lib/interns/intern-hours-csv';
import type { OrphanageInternHoursUploadRow } from '@/lib/interns/intern-types';

/**
 * The interns' own weekly Hubstaff report — the database half of the upload.
 *
 * SAME COLUMNS as hubstaff_hours, DIFFERENT TABLE, on purpose: the hubstaff_hours
 * ingest promotes the batch to is_current and then fires MESA deposits,
 * payroll.available / zero-hours notifications and the disbursement seeder. An
 * intern file through that door would flip Simple's current week and seed
 * money readers with intern rows. This path does none of that: it parses,
 * refuses non-interns, stores the rows verbatim under the file's name, and
 * records the upload. Re-uploading a file REPLACES that file (idempotent).
 */

export interface InternHoursUploadResult {
  upload: OrphanageInternHoursUploadRow;
  stored: number;
  refused: InternHoursRefusedRow[];
  replaced: boolean;
}

function mapUpload(r: Record<string, unknown>): OrphanageInternHoursUploadRow {
  return {
    id: String(r.id),
    source_file: String(r.source_file ?? ''),
    week_start: String(r.week_start ?? ''),
    week_end: String(r.week_end ?? ''),
    row_count: Number(r.row_count ?? 0),
    refused_count: Number(r.refused_count ?? 0),
    uploaded_by: (r.uploaded_by as string | null) ?? null,
    uploaded_at: String(r.uploaded_at ?? ''),
  };
}

export async function replaceInternHoursFromCsvText(
  csvText: string,
  sourceFile: string | null | undefined,
  uploadedBy: string | null,
): Promise<{ result: InternHoursUploadResult | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { result: null, error: 'Supabase not configured' };

  const parsed = parseInternHoursCsv(csvText, sourceFile);
  if (!parsed.ok) return { result: null, error: parsed.reason };
  if (parsed.rows.length === 0) {
    return {
      result: null,
      error:
        parsed.refused.length > 0
          ? `No @pathway.ph rows in this file (${parsed.refused.length} Simple rows refused). This looks like the Simple report — upload it in the Payroll Wizard instead.`
          : 'No data rows with an intern email were found.',
    };
  }

  // Replace-in-place: an existing upload for this file goes first (rows cascade).
  const { data: existing, error: exErr } = await supabase
    .from('orphanage_intern_hours_uploads')
    .select('id')
    .eq('source_file', parsed.sourceFile)
    .maybeSingle();
  if (exErr) return { result: null, error: exErr.message };
  const replaced = !!existing;
  if (existing) {
    const { error: delErr } = await supabase.from('orphanage_intern_hours_uploads').delete().eq('id', (existing as { id: string }).id);
    if (delErr) return { result: null, error: delErr.message };
  }

  const { data: up, error: upErr } = await supabase
    .from('orphanage_intern_hours_uploads')
    .insert({
      source_file: parsed.sourceFile,
      week_start: parsed.weekStart,
      week_end: parsed.weekEnd,
      row_count: parsed.rows.length,
      refused_count: parsed.refused.length,
      uploaded_by: uploadedBy,
    })
    .select('id, source_file, week_start, week_end, row_count, refused_count, uploaded_by, uploaded_at')
    .single();
  if (upErr || !up) return { result: null, error: upErr?.message ?? 'Could not record the upload' };
  const upload = mapUpload(up as Record<string, unknown>);

  const CHUNK = 200;
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    const chunk = parsed.rows.slice(i, i + CHUNK).map((r) => ({
      upload_id: upload.id,
      source_file: parsed.sourceFile,
      row_index: r.rowIndex,
      email: r.email,
      row: r.row,
    }));
    const { error } = await supabase.from('orphanage_intern_hours').insert(chunk);
    if (error) {
      // Leave nothing half-written: the upload row cascades its rows.
      await supabase.from('orphanage_intern_hours_uploads').delete().eq('id', upload.id);
      return { result: null, error: `Row insert failed: ${error.message}` };
    }
  }

  return { result: { upload, stored: parsed.rows.length, refused: parsed.refused, replaced }, error: null };
}

export async function listInternHoursUploads(): Promise<{ uploads: OrphanageInternHoursUploadRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { uploads: [], error: 'Supabase not configured' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase
      .from('orphanage_intern_hours_uploads')
      .select('id, source_file, week_start, week_end, row_count, refused_count, uploaded_by, uploaded_at')
      .order('week_start', { ascending: false })
      .order('id')
      .range(from, to),
  );
  if (error) return { uploads: [], error };
  return { uploads: rows.map(mapUpload), error: null };
}

export async function getInternHoursUpload(sourceFile: string): Promise<{ upload: OrphanageInternHoursUploadRow | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { upload: null, error: 'Supabase not configured' };
  const { data, error } = await supabase
    .from('orphanage_intern_hours_uploads')
    .select('id, source_file, week_start, week_end, row_count, refused_count, uploaded_by, uploaded_at')
    .eq('source_file', sourceFile)
    .maybeSingle();
  if (error) return { upload: null, error: error.message };
  return { upload: data ? mapUpload(data as Record<string, unknown>) : null, error: null };
}

export interface InternHoursStoredRow {
  rowIndex: number;
  email: string;
  row: Record<string, unknown>;
}

/** Every stored row of one intern report. Paged. */
export async function fetchInternHoursBySourceFile(sourceFile: string): Promise<{ rows: InternHoursStoredRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase.from('orphanage_intern_hours').select('row_index, email, row').eq('source_file', sourceFile).order('row_index').range(from, to),
  );
  if (error) return { rows: [], error };
  return {
    rows: rows.map((r) => ({ rowIndex: Number(r.row_index), email: String(r.email), row: (r.row as Record<string, unknown>) ?? {} })),
    error: null,
  };
}

export async function deleteInternHoursUpload(sourceFile: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };
  const { error } = await supabase.from('orphanage_intern_hours_uploads').delete().eq('source_file', sourceFile);
  return { error: error ? error.message : null };
}
