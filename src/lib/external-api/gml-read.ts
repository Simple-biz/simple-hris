/**
 * The ONE read pipeline both surfaces run — the REST route and the MCP tool.
 *
 *   grant ──▶ refused filters? ──▶ select built from the grant ──▶ rows
 *         ──▶ leaver filter + visible-column filters + page ──▶ PROJECT ──▶ out
 *
 * It exists so a REST answer and an MCP tool result cannot disagree about what a
 * key may see: both call `executeGmlRead` with the same grant, and the
 * projection happens HERE, after the query, before anything is serialised.
 * Pure apart from the injected `readRows` (the route passes the service-role
 * read; the tests pass an array).
 */
import { applyGmlQuery, MAX_LIMIT, type GmlQuery, type GmlRow } from './gml-query';
import { filterVisibility, projectRows, refusedFilters, selectFor, visibleColumns, type Grant } from './grants';

export type ReadRows = (select: string) => Promise<{ rows: GmlRow[]; error: string | null }>;

export type GmlReadPage = {
  limit: number;
  max_limit: number;
  returned: number;
  total: number;
  /** Opaque: the last row's UUID id. Echo it back as `cursor` to continue. */
  next_cursor: string | null;
};

export type GmlReadOutcome =
  | { ok: true; data: Record<string, unknown>[]; page: GmlReadPage; columns: string[] }
  | { ok: false; status: 400 | 500; denial: 'column_not_granted' | 'read_failed'; error: string; details?: unknown };

export async function executeGmlRead(readRows: ReadRows, q: GmlQuery, grant: Grant): Promise<GmlReadOutcome> {
  const refused = refusedFilters(q, grant);
  if (refused.length) {
    return {
      ok: false,
      status: 400,
      denial: 'column_not_granted',
      error: 'This key cannot filter on a column it was not granted',
      details: refused.map((field) => ({ field, message: 'filters a column this key cannot see' })),
    };
  }

  const { rows, error } = await readRows(selectFor(grant));
  if (error) return { ok: false, status: 500, denial: 'read_failed', error: 'Could not read the master list' };

  const page = applyGmlQuery(rows, q, filterVisibility(grant));
  return {
    ok: true,
    data: projectRows(page.rows, grant),
    columns: visibleColumns(grant),
    page: {
      limit: q.limit,
      max_limit: MAX_LIMIT,
      returned: page.rows.length,
      total: page.total,
      next_cursor: page.nextCursor,
    },
  };
}
