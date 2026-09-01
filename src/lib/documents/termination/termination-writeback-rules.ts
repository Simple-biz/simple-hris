/** [TERMINATION-DOCS]
 * PURE core of the blank-only write-back AND of its reverse.
 *
 * WHY THIS FILE EXISTS, and not one big module: `termination-writeback.ts`
 * opens `import 'server-only'`, and `server-only` is NOT resolvable by Node —
 * it is a build-time alias Next supplies (`node_modules/next/dist/compiled/server-only`;
 * `require.resolve('server-only')` fails, and there is no top-level
 * `node_modules/server-only`). `npm test` is
 * `node --import tsx --test "src/**\/*.test.ts"`, so a test file that imported
 * the write-back module would fail to load and take the whole run with it. The
 * shipped precedent for the split is `src/lib/anthropic/employee-tools.ts`
 * (server-only) beside `employee-tool-defs.ts` (pure, and what the test imports).
 *
 * So the LOOP ITSELF lives here, over a tiny injected port, and
 * `termination-writeback.ts` is nothing but the Supabase adapter that supplies
 * it. The tests therefore run the function that ships, not a mirror of it: a
 * mirror inside a test file is how a deleted skip branch stays green.
 *
 * The reverse lives here too — `readStoredWritebackRecord` +
 * `reverseValueForRecord` — because `scripts/revert-termination-doc-writebacks.mts`
 * imports them. When the script owned its own copy of that validation, the two
 * answered differently for the same stored data and only the unused copy was
 * tested.
 *
 * BLANK-NESS IS PROVED IN THE FILTER CHAIN, NEVER BY READING THEN WRITING.
 * `.is(col, null)` proves NULL and `.eq(col, '')` proves the empty string, both
 * atomically, inside the same statement that writes. A cell is read ONLY to
 * word a SKIP line. That is the whole guarantee: another session writing between
 * a read and a write can never be clobbered, and no undo record can therefore
 * claim a `before` that was never there.
 */
import {
  TERMINATION_WRITEBACK_COLUMNS,
  isBlankCell,
  type TerminationWritebackColumn,
  type TerminationWritebackRecord,
} from './types';

/** Re-exported so the tests reach the exact predicate the write-back runs. */
export { isBlankCell };

/** The one table the write-back and its reverse may name. Typed from the record
 *  so a change here is a type error rather than a silent second literal. */
export const TERMINATION_WRITEBACK_TABLE: TerminationWritebackRecord['table'] = 'global_master_list';

/** A target the write-back refused to touch, with the reason a rep can read. */
export interface TerminationWritebackSkip {
  column: TerminationWritebackColumn;
  rowId: string;
  reason: string;
}

/**
 * Which filter proved the cell blank. There is one guarded UPDATE per value:
 *   'null'         → `.eq('id', rowId).is(col, null)`
 *   'empty_string' → `.eq('id', rowId).eq(col, '')`
 * Both are decided by the DATABASE, in the statement that writes.
 */
export type TerminationWritebackGuard = 'null' | 'empty_string';

/**
 * What to do with one column after a guarded UPDATE has run.
 *
 * `before` is the prior state the reverse must restore, and `null` vs `''` are
 * DIFFERENT prior states that must never collapse. Which one it is comes from
 * WHICH GUARD MATCHED, so the record cannot claim a blank the cell did not hold.
 */
export type TerminationWritebackDecision =
  | { kind: 'apply'; before: null | '' }
  | { kind: 'skip'; reason: string };

/**
 * Columns where `''` is a legal blank, so the empty-string guard is worth a
 * round trip. `off_boarded_at` is TIMESTAMPTZ
 * (references/sql/alter/global_master_list_offboarded_columns.sql:17): `''` is
 * not a value it can hold, a blank there is always NULL, and `.eq(col, '')`
 * against it raises 22007 `invalid input syntax`. Excluding it also makes
 * `before: ''` unreachable for that column, which is what kept the old reverse
 * from ever writing `''` into a timestamp.
 *
 * `off_boarded_reason` and `"Start Date"` are TEXT and genuinely hold `''`
 * (references/sql/seed/seed_global_master_list_addresses.sql:1052 exists purely
 * to COALESCE(NULLIF(TRIM(x),''), old) around that fact).
 */
export const TERMINATION_EMPTY_STRING_COLUMNS = ['off_boarded_reason', 'Start Date'] as const;
const EMPTY_STRING_COLUMN_SET: ReadonlySet<string> = new Set(TERMINATION_EMPTY_STRING_COLUMNS);

/** True when `''` is a value this column can hold, i.e. when the empty-string
 *  guard is worth attempting after the NULL guard matched nothing. */
export function canHoldEmptyString(column: TerminationWritebackColumn): boolean {
  return EMPTY_STRING_COLUMN_SET.has(column);
}

const WRITEBACK_COLUMN_SET: ReadonlySet<string> = new Set(TERMINATION_WRITEBACK_COLUMNS);

/** `global_master_list.id`. The reverse keys on this and nothing else. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `guardedRowCount` is `data.length` from one guarded
 * `.update(…).eq('id', …).<guard>.select('id')`. Zero is a SKIP, never a
 * success: a guard-filtered UPDATE that matches nothing returns
 * `{ data: [], error: null }`.
 *
 * The cell is NOT an input. Whether it was blank is settled by which guard
 * matched, inside the statement that wrote — a read-then-write races the master
 * sync (POST /api/update-employee-profile and the sheet sync both write these
 * cells unguarded) and would let an undo record claim a `before` that belonged
 * to somebody else's value.
 */
export function decideWriteback(args: {
  guardedRowCount: number;
  guard: TerminationWritebackGuard;
}): TerminationWritebackDecision {
  const { guardedRowCount, guard } = args;

  if (guardedRowCount === 1) return { kind: 'apply', before: guard === 'null' ? null : '' };
  if (guardedRowCount > 1) {
    // Unreachable: `id` is the primary key. If PostgREST ever answers with more
    // than one row for it, the write is no longer attributable to a single
    // master row, so no undo record may claim it.
    return { kind: 'skip', reason: `guarded update matched ${guardedRowCount} rows` };
  }

  return {
    kind: 'skip',
    reason:
      guard === 'null'
        ? 'the cell was not NULL when the write ran'
        : "the cell was not '' when the write ran",
  };
}

/**
 * The two probes the loop needs, and nothing else. Implemented over Supabase in
 * `termination-writeback.ts`; implemented as a recorder in the tests, which is
 * how the exact filter chain each UPDATE carried is asserted.
 */
export interface TerminationWritebackPort {
  /**
   * ONE guarded UPDATE: set `column` to `value` where the row id matches AND
   * the guard holds, returning the rows it matched. `.select()` is mandatory on
   * the implementation side — without it a zero-row UPDATE reports success.
   */
  updateBlankCell(args: {
    column: TerminationWritebackColumn;
    value: string;
    guard: TerminationWritebackGuard;
  }): Promise<{ rows: number; error: string | null }>;

  /**
   * Read one cell. Used ONLY to word a SKIP line and to notice a master row
   * that is gone. Never consulted to decide whether a write may happen.
   */
  readCell(
    column: TerminationWritebackColumn,
  ): Promise<{ found: boolean; value: unknown; error: string | null }>;
}

/**
 * Persist the undo trail as it grows. Called with the WHOLE accumulated array
 * immediately after each cell lands, so what is on disk is never behind the
 * mutations it describes; returns an error message, or null on success.
 *
 * Required, not optional: `termination_documents.field_writebacks` is the only
 * undo data that exists, and the failure mode this closes is a crash between
 * the first master write and a single trailing UPDATE, which used to lose every
 * record with no trace.
 */
export type TerminationWritebackTrailSink = (
  records: readonly TerminationWritebackRecord[],
) => Promise<string | null>;

export interface TerminationWritebackOutcome {
  /** Cells actually written, in allowlist order. */
  applied: TerminationWritebackRecord[];
  /** The subset the sink CONFIRMED on disk. This is what the DB row holds. */
  persistedTrail: TerminationWritebackRecord[];
  skipped: TerminationWritebackSkip[];
  /** First database error from a master-list write or read. */
  error: string | null;
  /** The sink's failure, if any. A written cell whose record is not on disk. */
  trailError: string | null;
}

/** Word a SKIP line from the cell as it reads NOW. Diagnostic only. */
async function describeSkip(
  port: TerminationWritebackPort,
  column: TerminationWritebackColumn,
  guardReason: string,
): Promise<{ reason: string; error: string | null }> {
  const cur = await port.readCell(column);
  if (cur.error) {
    return {
      reason: `${guardReason} (the cell could not be re-read to name its value: ${cur.error})`,
      error: cur.error,
    };
  }
  if (!cur.found) return { reason: 'master row not found', error: null };

  if (isBlankCell(cur.value)) {
    // Either whitespace-only, or blanked by another writer between the guard and
    // this read. Only NULL and '' can be PROVED blank inside a filter chain, and
    // `TerminationWritebackRecord.before` can express only those two, so a cell
    // holding '   ' is left alone rather than rewritten with a `before` that
    // claims it was ''. Clearing whitespace is a People edit, not a side effect
    // of printing a letter.
    return {
      reason:
        `not provably blank at write time: the cell reads ${JSON.stringify(String(cur.value ?? ''))}` +
        " now — a whitespace-only cell is never overwritten (only NULL and '' can be proved blank" +
        ' inside the filter chain), and a value that changed under us belongs to whoever wrote it',
      error: null,
    };
  }
  return { reason: `filled since selection ('${String(cur.value)}')`, error: null };
}

/**
 * Fill the blank master cells the rep just supplied answers for.
 *
 * Iterates the ALLOWLIST, not the caller's keys, so an unexpected key in
 * `values` can never become a column name. Per column, in order:
 *   1. guarded UPDATE with the NULL guard  ⇒ one row back means applied, `before: null`
 *   2. zero rows and the column can hold '' ⇒ guarded UPDATE with the
 *      EMPTY-STRING guard ⇒ one row back means applied, `before: ''`
 *   3. still zero rows ⇒ SKIP, and the cell is read to say what won
 *   4. after each applied cell, the trail is persisted BEFORE the next column is
 *      attempted; if that fails, no further cell is written, so the worst case
 *      is one unrecorded cell rather than three.
 *
 * The guard is NEVER widened to a bare `.eq('id', …)` to make a skip go away —
 * a skip means someone else's value is in the cell, and their value wins.
 */
export async function applyTerminationWriteBackWith(
  port: TerminationWritebackPort,
  args: {
    rowId: string;
    values: Partial<Record<TerminationWritebackColumn, string>>;
    persistTrail: TerminationWritebackTrailSink;
    /** Injectable clock, so a test can pin `appliedAt`. */
    nowIso?: () => string;
  },
): Promise<TerminationWritebackOutcome> {
  const applied: TerminationWritebackRecord[] = [];
  let persistedTrail: TerminationWritebackRecord[] = [];
  const skipped: TerminationWritebackSkip[] = [];
  let firstError: string | null = null;
  let trailError: string | null = null;
  /** Set once the trail could not be saved: every later column is refused. */
  let halted: string | null = null;

  const rowId = args.rowId;
  const nowIso = args.nowIso ?? (() => new Date().toISOString());

  for (const column of TERMINATION_WRITEBACK_COLUMNS) {
    const value = args.values[column]?.trim();
    // Nothing supplied, or a blank supplied: a blank never overwrites a blank.
    if (!value) continue;

    if (halted) {
      skipped.push({ column, rowId, reason: halted });
      continue;
    }

    const nullGuard = await port.updateBlankCell({ column, value, guard: 'null' });
    if (nullGuard.error) {
      if (!firstError) firstError = nullGuard.error;
      skipped.push({ column, rowId, reason: `guarded update failed: ${nullGuard.error}` });
      continue;
    }

    let decision = decideWriteback({ guardedRowCount: nullGuard.rows, guard: 'null' });
    /** Rows matched by the guard that produced `decision`. */
    let guardedRows = nullGuard.rows;

    if (decision.kind === 'skip' && nullGuard.rows === 0 && canHoldEmptyString(column)) {
      // The second guarded UPDATE. `.is(col, null)` cannot express `col = ''`,
      // and these TEXT columns genuinely hold ''. Still the database deciding.
      const emptyGuard = await port.updateBlankCell({ column, value, guard: 'empty_string' });
      if (emptyGuard.error) {
        if (!firstError) firstError = emptyGuard.error;
        skipped.push({
          column,
          rowId,
          reason: `empty-string guarded update failed: ${emptyGuard.error}`,
        });
        continue;
      }
      decision = decideWriteback({ guardedRowCount: emptyGuard.rows, guard: 'empty_string' });
      guardedRows = emptyGuard.rows;
    }

    if (decision.kind === 'skip') {
      if (guardedRows !== 0) {
        // The unreachable >1-rows case. Its reason names the real problem — the
        // write is no longer attributable to one master row — and must not be
        // replaced by a description of one cell.
        skipped.push({ column, rowId, reason: decision.reason });
        continue;
      }
      const described = await describeSkip(port, column, decision.reason);
      if (described.error && !firstError) firstError = described.error;
      skipped.push({ column, rowId, reason: described.reason });
      continue;
    }

    const record: TerminationWritebackRecord = {
      table: TERMINATION_WRITEBACK_TABLE,
      rowId,
      column,
      before: decision.before,
      after: value,
      appliedAt: nowIso(),
    };
    applied.push(record);

    // The trail goes to disk before the next cell is touched.
    const persistErr = await args.persistTrail(applied);
    if (persistErr) {
      if (!trailError) trailError = persistErr;
      skipped.push({
        column,
        rowId,
        reason: `WRITTEN but the undo record could not be saved (${persistErr}) — revert this cell by hand`,
      });
      halted = `not attempted: the undo trail could not be saved for ${column}, so nothing further was written`;
      continue;
    }
    persistedTrail = [...applied];
  }

  // A DB error is surfaced even when other columns landed. `applied` comes back
  // regardless, so the caller can still report what did.
  return { applied, persistedTrail, skipped, error: firstError, trailError };
}

/**
 * The exact value the reverse must write back for one record.
 *
 * `record.before` is typed `null | ''`, but the value round-trips through jsonb
 * and the reverse script runs outside these types. Anything that is not exactly
 * `''` restores `null`; `''` restores `''`. A reverse written as
 * `record.before || null` collapses `''` into `null`, turning "this cell held an
 * empty string" into "this cell did not exist".
 */
export function reverseValueForRecord(record: { before?: unknown }): null | '' {
  return record?.before === '' ? '' : null;
}

/** One validated restore instruction, read back out of `field_writebacks`. */
export interface StoredWritebackTarget {
  rowId: string;
  column: TerminationWritebackColumn;
  /** Exactly `null` or `''`. Never coalesced — different prior states. */
  before: null | '';
  after: string;
}

/**
 * Validate one stored `field_writebacks` entry into the restore instruction, or
 * return the reason it is unusable.
 *
 * THE REVERSE SCRIPT IMPORTS THIS. It used to carry its own copy, which drifted:
 * the copy refused `before: '  '` while `reverseValueForRecord` answered `null`
 * for the same data, and only the unused one had tests. Every field is read as
 * `unknown` because this is stored data, not a literal.
 */
export function readStoredWritebackRecord(raw: unknown): StoredWritebackTarget | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';
  const rec = raw as {
    table?: unknown;
    rowId?: unknown;
    column?: unknown;
    before?: unknown;
    after?: unknown;
  };

  if (rec.table !== undefined && rec.table !== TERMINATION_WRITEBACK_TABLE) {
    return `table is ${JSON.stringify(rec.table)}, expected '${TERMINATION_WRITEBACK_TABLE}'`;
  }
  if (typeof rec.rowId !== 'string' || !UUID_SHAPE.test(rec.rowId.trim())) {
    // `global_master_list.id` is a uuid. Anything else — an email above all — is
    // a record this code will not act on: the reverse is keyed on the ROW, never
    // on an address, because one work email owns several master rows.
    return `rowId is ${JSON.stringify(rec.rowId)} — the reverse is keyed on ${TERMINATION_WRITEBACK_TABLE}.id, which is a uuid`;
  }
  if (typeof rec.column !== 'string' || !WRITEBACK_COLUMN_SET.has(rec.column)) {
    return `column ${JSON.stringify(rec.column)} is not in the write-back allowlist [${TERMINATION_WRITEBACK_COLUMNS.join(', ')}]`;
  }
  // Without `after` there is nothing to verify the current value against, and a
  // write with no verification is exactly what the reverse exists to avoid.
  if (typeof rec.after !== 'string' || rec.after === '') {
    return `after is ${JSON.stringify(rec.after)} — cannot verify the cell without it`;
  }
  // `null` and `''` are different prior states and both are legal. Anything else
  // is a record this code does not understand, so it does not guess.
  if (rec.before !== null && rec.before !== '') {
    return `before is ${JSON.stringify(rec.before)} — expected null or an empty string`;
  }

  return {
    rowId: rec.rowId,
    column: rec.column as TerminationWritebackColumn,
    // The one function that decides a restore value, for both callers.
    before: reverseValueForRecord(rec),
    after: rec.after,
  };
}
