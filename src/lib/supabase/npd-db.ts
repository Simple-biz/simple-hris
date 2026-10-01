/**
 * NPD (Accounting → New Payroll Dashboard) persistence. Server-only (service role).
 * Tables + function: references/sql/create/2026-10-01_npd_sheets.sql.
 * Governing doc: docs/features/npd-dashboard.md.
 *
 * Every read pages (`selectAllPaged`, total order on `row_no`): PostgREST cuts a
 * result at 1000 rows even with `.range()`, and a sheet may hold up to 2,000.
 * A failed read is an ERROR, never an empty sheet — an empty grid would invite
 * Accounting to paste the week again over rows that are really there.
 */
import { classifyTableProbe } from '@/lib/db/probe-verdict';
import { NPD_ROW_TABLES, type NpdSheetKind } from '@/lib/npd/columns';
import { fromDbRecord, toDbRecords, type NpdRow } from '@/lib/npd/sheet';
import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from './select-all-paged';

export type NpdSheetMeta = {
  /** null until the first save of that tab + week. */
  sheetId: string | null;
  /** 0 until the first save; the CAS token every save must carry. */
  version: number;
  rowCount: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type NpdWeekEntry = {
  sheet: NpdSheetKind;
  week: string;
  version: number;
  rowCount: number;
  updatedAt: string;
  updatedBy: string;
};

export type NpdFailure = { ok: false; missing: boolean; error: string };

export const NPD_NOT_SET_UP =
  'NPD is not set up yet: its tables are not in the database. Run scripts/apply-npd-sheets-migration.mts --apply.';

type HeaderRow = { id: string; version: number; row_count: number; updated_at: string; updated_by: string };

function failure(error: { code?: string | null; message: string }): NpdFailure {
  // PGRST202 = the function is not in PostgREST's schema cache.
  const missing = classifyTableProbe(error) === 'MISSING' || error.code === 'PGRST202';
  return { ok: false, missing, error: missing ? NPD_NOT_SET_UP : error.message };
}

const EMPTY_META: NpdSheetMeta = { sheetId: null, version: 0, rowCount: 0, updatedAt: null, updatedBy: null };

function metaOf(h: HeaderRow): NpdSheetMeta {
  return {
    sheetId: h.id,
    version: Number(h.version),
    rowCount: Number(h.row_count),
    updatedAt: h.updated_at,
    updatedBy: h.updated_by,
  };
}

export async function readNpdSheetMeta(
  sheet: NpdSheetKind,
  week: string,
): Promise<{ ok: true; meta: NpdSheetMeta } | NpdFailure> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, missing: false, error: 'Supabase client unavailable' };
  const { data, error } = await supabase
    .from('npd_sheets')
    .select('id, version, row_count, updated_at, updated_by')
    .eq('sheet', sheet)
    .eq('week_start', week)
    .maybeSingle();
  if (error) return failure(error);
  return { ok: true, meta: data ? metaOf(data as HeaderRow) : EMPTY_META };
}

/**
 * One sheet, whole. The header and the rows are two requests, so a save landing
 * between them could pair version N with version N+1's rows — and the next save
 * would then be refused as a conflict the editor cannot explain. So the header
 * is read again after the rows and the read retried until the two agree.
 */
export async function readNpdSheet(
  sheet: NpdSheetKind,
  week: string,
): Promise<{ ok: true; meta: NpdSheetMeta; rows: NpdRow[] } | NpdFailure> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, missing: false, error: 'Supabase client unavailable' };
  const table = NPD_ROW_TABLES[sheet];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const before = await readNpdSheetMeta(sheet, week);
    if (!before.ok) return before;
    if (!before.meta.sheetId) return { ok: true, meta: before.meta, rows: [] };
    const sheetId = before.meta.sheetId;

    const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
      // `*`: fromDbRecord reads exactly this tab's columns (columns.ts) and ignores the rest.
      supabase.from(table).select('*').eq('sheet_id', sheetId).order('row_no', { ascending: true }).range(from, to),
    );
    if (error) return failure({ message: error });

    const after = await readNpdSheetMeta(sheet, week);
    if (!after.ok) return after;
    if (after.meta.version === before.meta.version) {
      return { ok: true, meta: before.meta, rows: rows.map((r) => fromDbRecord(sheet, r)) };
    }
  }
  return { ok: false, missing: false, error: 'The sheet kept changing while it was being read. Try again.' };
}

/** Every tab + week that has a sheet, newest week first. */
export async function listNpdWeeks(): Promise<{ ok: true; weeks: NpdWeekEntry[] } | NpdFailure> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, missing: false, error: 'Supabase client unavailable' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase
      .from('npd_sheets')
      .select('id, sheet, week_start, version, row_count, updated_at, updated_by')
      .order('week_start', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (error) return failure({ message: error });
  return {
    ok: true,
    weeks: rows.map((r) => ({
      sheet: r.sheet as NpdSheetKind,
      week: String(r.week_start),
      version: Number(r.version),
      rowCount: Number(r.row_count),
      updatedAt: String(r.updated_at),
      updatedBy: String(r.updated_by),
    })),
  };
}

export type NpdSaveOutcome =
  | { ok: true; meta: NpdSheetMeta }
  | { ok: false; conflict: true; currentVersion: number }
  | (NpdFailure & { conflict?: false });

/** Replace one sheet's rows atomically under the version check (npd_save_sheet). */
export async function saveNpdSheet(args: {
  sheet: NpdSheetKind;
  week: string;
  expectedVersion: number;
  savedBy: string;
  rows: readonly NpdRow[];
}): Promise<NpdSaveOutcome> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, missing: false, error: 'Supabase client unavailable' };
  const { data, error } = await supabase.rpc('npd_save_sheet', {
    p_sheet: args.sheet,
    p_week_start: args.week,
    p_expected_version: args.expectedVersion,
    p_saved_by: args.savedBy,
    p_rows: toDbRecords(args.sheet, args.rows),
  });
  if (error) {
    const conflict = /npd_version_conflict:(\d+)/.exec(error.message);
    if (conflict) return { ok: false, conflict: true, currentVersion: Number(conflict[1]) };
    return failure(error);
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { sheet_id: string; version: number; row_count: number; updated_at: string; updated_by: string }
    | undefined;
  if (!row) return { ok: false, missing: false, error: 'The save returned nothing' };
  return {
    ok: true,
    meta: {
      sheetId: row.sheet_id,
      version: Number(row.version),
      rowCount: Number(row.row_count),
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    },
  };
}
