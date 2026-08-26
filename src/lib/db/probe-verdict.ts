/**
 * How to read a PostgREST error when asking "does this object exist?".
 *
 * Extracted from `scripts/audit-pending-migrations.mts` on 2026-08-26 so the classification is
 * testable without a live database. The script is the only caller today; the rules it encodes are
 * the ones documented in `docs/features/INDEX.md` (Migrations & deploy state) and the
 * `postgrest-head-true-hides-missing-table` memory entry.
 *
 * THE RULE THAT MADE THIS A MODULE: an existence probe must never use `{ head: true }`.
 * PostgREST answers a `head: true` select against a table that does not exist with `error: null`
 * and `count: null` — no `42P01`, no `PGRST205`, nothing — so "no error" means "the object exists"
 * ONLY for a probe that actually asked for a row. Every function here assumes the caller used a
 * plain `.select(...).limit(1)`; feeding it the result of a `head: true` probe reintroduces exactly
 * the bug it exists to prevent.
 */

/** The shape supabase-js returns. Deliberately structural — this module never imports the client. */
export interface ProbeError {
  code?: string | null;
  message?: string | null;
}

export type Existence =
  /** The object is there. */
  | 'PRESENT'
  /** The object is definitively absent — the migration did not run. */
  | 'MISSING'
  /** Something else went wrong. Never report this as either APPLIED or NOT APPLIED. */
  | 'UNKNOWN';

/** `42P01` undefined_table · `PGRST205` = absent from PostgREST's schema cache (also "missing"). */
const TABLE_MISSING_CODES = new Set(['42P01', 'PGRST205']);
const TABLE_MISSING_TEXT = /does not exist|Could not find the table/i;

/** `42703` undefined_column · `PGRST204` = column absent from the schema cache. */
const COLUMN_MISSING_CODES = new Set(['42703', 'PGRST204']);
const COLUMN_MISSING_TEXT = /column .* does not exist|Could not find the '.*' column/i;

/**
 * A missing column probed WITH `head: true` errors with `code: undefined` and an EMPTY message, so
 * anything branching on the code or regex-matching the message falls through to its catch-all and
 * lands INCONCLUSIVE. That is a probe reporting "I could not tell" about a fact it did detect.
 * An error object carrying neither a code nor a message is not a transport failure — a network or
 * auth problem always says something — so it is read as absence.
 */
const isEmptyError = (error: ProbeError): boolean =>
  !error.code?.trim() && !error.message?.trim();

/** Does a TABLE (or view) exist? `error` is whatever a plain `.select(...).limit(1)` returned. */
export function classifyTableProbe(error: ProbeError | null | undefined): Existence {
  if (!error) return 'PRESENT';
  if (error.code && TABLE_MISSING_CODES.has(error.code)) return 'MISSING';
  if (error.message && TABLE_MISSING_TEXT.test(error.message)) return 'MISSING';
  if (isEmptyError(error)) return 'MISSING';
  return 'UNKNOWN';
}

/**
 * Does a COLUMN exist on a table? Returns `'MISSING'` for a missing PARENT table too — a column on
 * a table that does not exist is, unambiguously, not applied.
 */
export function classifyColumnProbe(error: ProbeError | null | undefined): Existence {
  if (!error) return 'PRESENT';
  if (error.code && COLUMN_MISSING_CODES.has(error.code)) return 'MISSING';
  if (error.message && COLUMN_MISSING_TEXT.test(error.message)) return 'MISSING';
  if (error.code && TABLE_MISSING_CODES.has(error.code)) return 'MISSING';
  if (error.message && TABLE_MISSING_TEXT.test(error.message)) return 'MISSING';
  if (isEmptyError(error)) return 'MISSING';
  return 'UNKNOWN';
}

/**
 * A row count that is only trustworthy when it is a real number.
 *
 * `head: true` returns `count: null` with no error for an object that is not there, so treating a
 * null count as a zero converts "this table is missing" into "this table is empty" — which read
 * `zero opt_in rows remain` as APPLIED on the MESA cleanup probe. Callers must branch on `null`
 * explicitly; there is no `?? 0` anywhere in this file on purpose.
 */
export function readCount(error: ProbeError | null | undefined, count: number | null | undefined): number | null {
  if (error) return null;
  return typeof count === 'number' ? count : null;
}
