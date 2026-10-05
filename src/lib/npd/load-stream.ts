/**
 * GET /api/accounting/npd?sheet&week streams the read of one sheet as NDJSON (one JSON
 * object per line), so the loading card can say what is really happening
 * (load-progress.ts). Pure: the route encodes with it, the browser assembles with it,
 * and both are tested here (load-stream.test.ts). Governing doc:
 * docs/features/npd-dashboard.md § Loading a sheet.
 *
 * Lines, in order:
 *   header   attempt N's header: { version, rowCount }        (one per attempt)
 *   read     attempt N read { rows } rows from the database
 *   retry    a save landed mid-read; attempt N starts          (then header, read again)
 *   sheet    the read is consistent: the sheet's meta + how many rows follow
 *   rows     up to NPD_STREAM_ROWS_PER_LINE rows               (zero or more lines)
 *   end      { rows }: the count sent, which must match
 *   error    { error, missing }: the read failed; nothing else follows
 *
 * The assembler FAILS CLOSED, because a partial sheet is worse than none: an editor who
 * sees 300 of 613 rows and saves would remove the other 313. A stream that stops early,
 * sends rows before the sheet line, sends more or fewer rows than it announced, sends
 * a line it cannot read, or a sheet for another tab or week, is a failed load, never a
 * shorter grid. The assembled sheet is re-checked with the cache's own validator
 * (parseNpdSheetPayload) before anything uses it.
 */

import { isNpdSheetKind, type NpdSheetKind } from './columns';
import type { NpdRow } from './sheet';
import type { NpdLoadEvent } from './load-progress';
import { parseNpdSheetPayload, type NpdSheetPayload } from './npd-cache';

export const NPD_STREAM_ROWS_PER_LINE = 50;

export type NpdSheetMetaLine = Omit<NpdSheetPayload, 'rows'> & { sheet: NpdSheetKind; week: string };

export type NpdStreamLine =
  | { type: 'header'; attempt: number; version: number; rowCount: number }
  | { type: 'read'; attempt: number; rows: number }
  | { type: 'retry'; attempt: number }
  | (NpdSheetMetaLine & { type: 'sheet'; rows: number })
  | { type: 'rows'; rows: readonly NpdRow[] }
  | { type: 'end'; rows: number }
  | { type: 'error'; error: string; missing: boolean };

export function encodeNpdStreamLine(line: NpdStreamLine): string {
  return `${JSON.stringify(line)}\n`;
}

export function chunkNpdRows<T>(rows: readonly T[], size = NPD_STREAM_ROWS_PER_LINE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export type NpdAssembled =
  | { ok: true; payload: NpdSheetPayload }
  | { ok: false; error: string; missing: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isAttempt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

export const NPD_STREAM_CUT_SHORT =
  'The sheet stopped arriving part-way through, so none of it is shown. Nothing was changed. Try again.';
const UNREADABLE = 'The sheet arrived in a form this page could not read, so none of it is shown. Nothing was changed.';

/**
 * Assemble one sheet from its stream. `push` takes one line of text and returns the
 * progress event it means (or null for none); `finish` says whether a whole, valid
 * sheet arrived. After the first problem every later line is ignored.
 */
export function createNpdStreamAssembler(sheet: NpdSheetKind, week: string) {
  let meta: NpdSheetMetaLine | null = null;
  let announced = -1;
  const rows: unknown[] = [];
  let ended = false;
  let failure: { error: string; missing: boolean } | null = null;

  const fail = (error: string, missing = false): NpdLoadEvent => {
    failure = { error, missing };
    return { kind: 'failed', error };
  };

  function push(text: string): NpdLoadEvent | null {
    if (failure || ended) return null;
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      return fail(UNREADABLE);
    }
    if (!isObj(line) || typeof line.type !== 'string') return fail(UNREADABLE);
    switch (line.type) {
      case 'error':
        return fail(typeof line.error === 'string' && line.error ? line.error : 'Could not load the sheet', line.missing === true);
      case 'header':
        if (meta || !isAttempt(line.attempt) || !isCount(line.rowCount)) return fail(UNREADABLE);
        return { kind: 'header', attempt: line.attempt, rowCount: line.rowCount };
      case 'read':
        if (meta || !isAttempt(line.attempt) || !isCount(line.rows)) return fail(UNREADABLE);
        return { kind: 'read', attempt: line.attempt, rows: line.rows };
      case 'retry':
        if (meta || !isAttempt(line.attempt)) return fail(UNREADABLE);
        return { kind: 'retry', attempt: line.attempt };
      case 'sheet': {
        if (meta || !isCount(line.rows)) return fail(UNREADABLE);
        if (line.sheet !== sheet || line.week !== week || !isNpdSheetKind(line.sheet)) {
          return fail('The server sent a different sheet than the one asked for, so none of it is shown.');
        }
        const { type: _t, rows: count, ...rest } = line;
        void _t;
        meta = rest as unknown as NpdSheetMetaLine;
        announced = count;
        return { kind: 'sheet', rows: count };
      }
      case 'rows': {
        if (!meta || !Array.isArray(line.rows)) return fail(UNREADABLE);
        if (rows.length + line.rows.length > announced) return fail(UNREADABLE);
        rows.push(...line.rows);
        return { kind: 'rows', count: line.rows.length };
      }
      case 'end':
        if (!meta || !isCount(line.rows) || line.rows !== announced || rows.length !== announced) {
          return fail(NPD_STREAM_CUT_SHORT);
        }
        ended = true;
        return null;
      default:
        return fail(UNREADABLE);
    }
  }

  function finish(): NpdAssembled {
    if (failure) return { ok: false, ...(failure as { error: string; missing: boolean }) };
    if (!ended || !meta) return { ok: false, error: NPD_STREAM_CUT_SHORT, missing: false };
    const { sheet: _s, week: _w, ...head } = meta;
    void _s;
    void _w;
    // The cache's validator: right width, text cells, known columns. Anything off is refused.
    const payload = parseNpdSheetPayload(sheet, { ...head, rows });
    if (!payload) return { ok: false, error: UNREADABLE, missing: false };
    return { ok: true, payload };
  }

  return { push, finish, failed: () => failure !== null };
}
