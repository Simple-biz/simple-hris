/**
 * NPD (Accounting → New Payroll Dashboard) persistence. Server-only (service role).
 * Tables + function: references/sql/create/2026-10-01_npd_sheets.sql; Lock in:
 * references/sql/alter/2026-10-01_npd_sheets_lock.sql.
 * Governing doc: docs/features/npd-dashboard.md.
 *
 * The header is read with `select('*')` and the lock fields are optional, so the
 * page still loads and saves in the window between deploying this code and
 * applying the Lock in migration. With no lock columns nothing can be locked, so
 * "unlocked" is the truth, not a guess.
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
  /** Lock in: both set or both null. */
  lockedAt: string | null;
  lockedBy: string | null;
};

export type NpdWeekEntry = {
  sheet: NpdSheetKind;
  week: string;
  version: number;
  rowCount: number;
  updatedAt: string;
  updatedBy: string;
  lockedAt: string | null;
};

export type NpdFailure = { ok: false; missing: boolean; error: string };

export const NPD_NOT_SET_UP =
  'NPD is not set up yet: its tables are not in the database. Run scripts/apply-npd-sheets-migration.mts --apply.';

export const NPD_LOCK_NOT_SET_UP =
  'Lock in is not set up yet: its database functions are missing. Run scripts/apply-npd-sheets-lock-migration.mts --apply.';

type HeaderRow = {
  id: string;
  version: number;
  row_count: number;
  updated_at: string;
  updated_by: string;
  locked_at?: string | null;
  locked_by?: string | null;
};

function failure(error: { code?: string | null; message: string }): NpdFailure {
  // PGRST202 = the function is not in PostgREST's schema cache.
  const missing = classifyTableProbe(error) === 'MISSING' || error.code === 'PGRST202';
  return { ok: false, missing, error: missing ? NPD_NOT_SET_UP : error.message };
}

const EMPTY_META: NpdSheetMeta = {
  sheetId: null,
  version: 0,
  rowCount: 0,
  updatedAt: null,
  updatedBy: null,
  lockedAt: null,
  lockedBy: null,
};

function metaOf(h: HeaderRow): NpdSheetMeta {
  return {
    sheetId: h.id,
    version: Number(h.version),
    rowCount: Number(h.row_count),
    updatedAt: h.updated_at,
    updatedBy: h.updated_by,
    lockedAt: h.locked_at ?? null,
    lockedBy: h.locked_by ?? null,
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
    // `*`, not a column list: see the header note on the lock columns.
    .select('*')
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
      .select('*')
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
      lockedAt: typeof r.locked_at === 'string' ? r.locked_at : null,
    })),
  };
}

export type NpdSaveOutcome =
  | { ok: true; meta: NpdSheetMeta }
  | { ok: false; conflict: true; currentVersion: number; locked?: false }
  | { ok: false; locked: true; conflict?: false }
  | (NpdFailure & { conflict?: false; locked?: false });

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
    // Locked first: npd_save_sheet checks the lock before the version.
    if (/npd_sheet_locked/.test(error.message)) return { ok: false, locked: true };
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
      // A save never runs on a locked sheet, so a saved sheet is unlocked.
      lockedAt: null,
      lockedBy: null,
    },
  };
}

// ─── Lock in ─────────────────────────────────────────────────────────────────

export type NpdLockRefusal = 'locked' | 'conflict' | 'empty' | 'not_locked' | 'missing';

type LockFailure = { ok: false; refusal: NpdLockRefusal | null; currentVersion?: number; error: string };

function lockFailure(error: { code?: string | null; message: string }): LockFailure {
  const m = error.message;
  if (/npd_sheet_locked/.test(m)) return { ok: false, refusal: 'locked', error: m };
  const conflict = /npd_version_conflict:(\d+)/.exec(m);
  if (conflict) return { ok: false, refusal: 'conflict', currentVersion: Number(conflict[1]), error: m };
  if (/npd_sheet_empty/.test(m)) return { ok: false, refusal: 'empty', error: m };
  if (/npd_sheet_not_locked/.test(m)) return { ok: false, refusal: 'not_locked', error: m };
  // PGRST202: the function is not in PostgREST's schema cache — the Lock in
  // migration has not been applied (or the cache has not reloaded since).
  if (error.code === 'PGRST202' || classifyTableProbe(error) === 'MISSING') {
    return { ok: false, refusal: 'missing', error: NPD_LOCK_NOT_SET_UP };
  }
  return { ok: false, refusal: null, error: m };
}

/** Lock one sheet at the version the editor saw (npd_lock_sheet). */
export async function lockNpdSheet(args: {
  sheet: NpdSheetKind;
  week: string;
  expectedVersion: number;
  lockedBy: string;
}): Promise<{ ok: true; version: number; rowCount: number; lockedAt: string; lockedBy: string } | LockFailure> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, refusal: null, error: 'Supabase client unavailable' };
  const { data, error } = await supabase.rpc('npd_lock_sheet', {
    p_sheet: args.sheet,
    p_week_start: args.week,
    p_expected_version: args.expectedVersion,
    p_locked_by: args.lockedBy,
  });
  if (error) return lockFailure(error);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { version: number; row_count: number; locked_at: string; locked_by: string }
    | undefined;
  if (!row) return { ok: false, refusal: null, error: 'The lock returned nothing' };
  return {
    ok: true,
    version: Number(row.version),
    rowCount: Number(row.row_count),
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
  };
}

/** Clear a sheet's lock (npd_unlock_sheet). The route audits the reason BEFORE calling this. */
export async function unlockNpdSheet(args: {
  sheet: NpdSheetKind;
  week: string;
  unlockedBy: string;
}): Promise<{ ok: true; version: number } | LockFailure> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ok: false, refusal: null, error: 'Supabase client unavailable' };
  const { data, error } = await supabase.rpc('npd_unlock_sheet', {
    p_sheet: args.sheet,
    p_week_start: args.week,
    p_unlocked_by: args.unlockedBy,
  });
  if (error) return lockFailure(error);
  const row = (Array.isArray(data) ? data[0] : data) as { version: number } | undefined;
  if (!row) return { ok: false, refusal: null, error: 'The unlock returned nothing' };
  return { ok: true, version: Number(row.version) };
}
