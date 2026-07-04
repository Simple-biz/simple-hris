/**
 * The "Screening" feature mirrors the "Screenings 2.0" Google Sheet the same way
 * the Global Master List mirrors its master sheet. This module is the SINGLE
 * source of truth for the columns we pull — imported by:
 *   - the sheet fetcher   (src/lib/google-sheets/fetch-screening-sheet.ts)
 *   - the reconcile engine (src/lib/supabase/screening-db.ts)
 *   - the DB migration     (references/sql/create/create_screening.sql — kept in sync by hand)
 *   - the HR UI tab        (src/components/hr/HrScreening.tsx)
 *
 * It is intentionally framework-free (no `server-only`, no React) so it is safe
 * to import from both server code and the client bundle.
 *
 * ── Sheet layout (real "Screenings2.0" tab, gid 224659689) ────────────────────
 * The wanted range is "Name" (col B) → "Referral" (col N). "Name" is NOT column A
 * (a "Team" column precedes it), and the range also contains UNLABELED columns we
 * skip: a blank-header column between "Scheduled" and "2nd Interviewer" (it holds
 * the scheduled interview date), plus a trailing blank + a "Grid ID" column after
 * "Referral". So we ANCHOR on header TEXT, not a fixed offset — mapping is by
 * header NAME, consumed left→right, which naturally skips "Team", the blank
 * columns, and "Grid ID". (If you ever want the scheduled-date or Team columns,
 * add entries below + columns in create_screening.sql.)
 *
 * ── The duplicate "Remarks" gotcha ────────────────────────────────────────────
 * The sheet has TWO columns both titled "Remarks" (one after "Initial", one
 * after "No Show"). A plain name→column map would collapse them into one. We
 * disambiguate by CONSUMING header matches left→right: the first "Remarks" cell
 * fills `Initial Remarks`, the second fills `Remarks 2`. That's why two entries
 * below share `sheetHeader: 'Remarks'` but have distinct `db` names.
 *
 * ⚠️ If you rename a DB column here, also change it in create_screening.sql (the
 * quoted column name) and re-run the migration — the two must match exactly.
 */

export interface ScreeningColumn {
  /** Exact DB column name (quoted PascalCase, matches create_screening.sql). */
  db: string;
  /** The sheet header this column comes from (matched case/space-insensitively). */
  sheetHeader: string;
  /** Extra header spellings that should also map here (normalized-compared). */
  aliases?: string[];
  /** Column label shown in the HR table (defaults to `db`). */
  label?: string;
  /** For a column with a BLANK header on the sheet: resolve it positionally as
   *  the cell immediately to the RIGHT of the column whose `db` equals this value
   *  (e.g. the scheduled-interview date sits right after "Scheduled" with no
   *  header). Only accepted if that neighbor's header is actually blank, so a
   *  layout change can't silently capture the wrong (named) column. Never
   *  contributes to the "missing column" error — a blank-anchored column that
   *  isn't present just stays empty. */
  blankAfter?: string;
}

/**
 * The 12 columns synced, in left→right sheet order (Name … Referral).
 * Order matters: it drives left→right consumption of duplicate headers.
 */
export const SCREENING_COLUMNS: readonly ScreeningColumn[] = [
  { db: 'Name',            sheetHeader: 'Name' },
  { db: 'Email Address',   sheetHeader: 'Email Address', aliases: ['email', 'email address', 'work email'], label: 'Email' },
  { db: 'Screener',        sheetHeader: 'Screener' },
  { db: 'Date',            sheetHeader: 'Date' },
  { db: 'Initial',         sheetHeader: 'Initial' },
  { db: 'Initial Remarks', sheetHeader: 'Remarks', label: 'Initial remarks' },
  { db: 'Scheduled',       sheetHeader: 'Scheduled' },
  { db: 'Scheduled Date',  sheetHeader: '', blankAfter: 'Scheduled', label: 'Scheduled date' },
  { db: '2nd Interviewer', sheetHeader: '2nd Interviewer', aliases: ['2nd interviewer', 'second interviewer'] },
  { db: 'No Show',         sheetHeader: 'No Show', aliases: ['no show', 'no-show', 'noshow'] },
  { db: 'Remarks 2',       sheetHeader: 'Remarks', label: 'Remarks' },
  { db: 'Source',          sheetHeader: 'Source' },
  { db: 'Referral',        sheetHeader: 'Referral' },
] as const;

/** All DB column names, in sheet order. */
export const SCREENING_DB_COLUMNS: readonly string[] = SCREENING_COLUMNS.map((c) => c.db);

/**
 * The column used to match a sheet row to an existing DB row on sync (upsert
 * key). Chosen as the email column: stable per-candidate identity. Rows whose
 * email is blank can't be matched and are inserted fresh on every sync.
 */
export const SCREENING_MATCH_COLUMN = 'Email Address';

/**
 * The sheet's own monotonic sequence column ("Grid ID"). Captured as a numeric
 * `grid_id` purely to order the board "latest scanned first" (highest = newest).
 * It sits OUTSIDE the Name→Referral display range, so it is not in
 * SCREENING_COLUMNS — the fetcher stashes it under SCREENING_ORDER_FIELD.
 */
export const SCREENING_ORDER_HEADER = 'Grid ID';
export const SCREENING_ORDER_FIELD = '__grid_id';

/** A screening row as returned by the API / read view (dynamic PascalCase keys). */
export type ScreeningRow = {
  id: number;
  synced_at?: string | null;
} & Partial<Record<string, string | null>>;

/**
 * Normalize a header (or any string) for tolerant comparison: lowercased, with
 * every run of non-alphanumeric characters collapsed to a single space, trimmed.
 * So "No-Show", "No Show", and "no  show" all normalize to "no show".
 */
export function normalizeHeader(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Every accepted (normalized) spelling for a column — its header plus aliases. */
export function acceptedHeaders(col: ScreeningColumn): string[] {
  return [col.sheetHeader, ...(col.aliases ?? [])].map(normalizeHeader);
}
