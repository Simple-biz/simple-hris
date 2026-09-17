/**
 * Per-client column grants for the Global Master List read.
 *
 * A grant is `null` (the WHOLE table — every offerable column) or a list of
 * offerable column names (ONLY those). Kane, 2026-09-17: *"I can give them a whole
 * table … or hide some of those columns to protect data."* The default is the whole
 * table; the admin hides by unticking.
 *
 * Rules this module owns, and the reason each exists:
 *
 *  - **The select is BUILT from the grant — never `*`.** `selectFor` names every
 *    column PostgREST may return. A hidden column is not fetched and then dropped;
 *    it is not fetched. `projectRow` is the belt to that brace, applied to every row
 *    on the way out of BOTH the REST route and the MCP tools (`grants.test.ts`
 *    asserts a hidden column never appears).
 *  - **`id` always, `off_boarded_at` read-then-dropped.** `id` is the cursor. The
 *    leaver filter (`applyGmlQuery`) re-checks `off_boarded_at` in memory, so it is
 *    always SELECTed and never projected out to the caller.
 *  - **A filter on a hidden column is refused (400 `column_not_granted`).** Otherwise
 *    `?email=someone@gmail.com` against a key that cannot see Personal Email would
 *    still confirm that the address belongs to an active person. `filterVisibility`
 *    tells the query layer which email columns and which search columns it may
 *    match on; `refusedFilters` names what the caller asked for that it may not.
 *  - **An empty list is an error, not "nothing".** NULL means everything; `[]` would
 *    mean nothing to one reader and everything to another (the SQL CHECK agrees).
 *  - **A list that covers every offerable column collapses to NULL** so "whole table"
 *    has one spelling in the row and the UI.
 *
 * Pure — no server-only imports; the picker uses `normalizeGrant` too.
 */
import { ALWAYS_COLUMNS, GML_CATALOG, OFFERABLE_COLUMNS, isAlways, isOfferable } from './catalog';
import { GML_EMAIL_COLUMNS, type FilterVisibility, type GmlQuery, type GmlRow } from './gml-query';

export type { FilterVisibility } from './gml-query';

/** null = the whole table (every offerable column). */
export type Grant = null | string[];

export type GrantParse = { ok: true; grant: Grant } | { ok: false; error: string };

/**
 * Turn what an admin (or a stored row) says into a grant. Accepts `null` /
 * `undefined` (whole table) or an array of column names. Unknown or never-offerable
 * columns are named in the error — never silently dropped, because a dropped name
 * would make the admin believe a column is hidden or shown when it is not.
 */
export function normalizeGrant(input: unknown): GrantParse {
  if (input == null) return { ok: true, grant: null };
  if (!Array.isArray(input)) return { ok: false, error: 'granted_columns must be a list of column names or null' };
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') {
      bad.push(String(raw));
      continue;
    }
    const name = raw.trim();
    if (!name) continue;
    if (isAlways(name)) continue; // implicit — never stored, never an error
    if (!isOfferable(name)) {
      bad.push(name);
      continue;
    }
    seen.add(name);
  }
  if (bad.length) return { ok: false, error: `Not a column this API can offer: ${bad.join(', ')}` };
  if (seen.size === 0) {
    return { ok: false, error: 'Pick at least one column, or leave the whole table on' };
  }
  if (seen.size === OFFERABLE_COLUMNS.length) return { ok: true, grant: null };
  // Catalog order, so two admins ticking the same boxes store the same list.
  return { ok: true, grant: OFFERABLE_COLUMNS.filter((c) => seen.has(c)) };
}

/** The columns the caller will actually receive, in catalog order — `id` first. */
export function visibleColumns(grant: Grant): string[] {
  const chosen = grant ?? OFFERABLE_COLUMNS;
  const set = new Set(chosen);
  return [...ALWAYS_COLUMNS, ...GML_CATALOG.map((c) => c.name).filter((c) => set.has(c))];
}

export function isVisible(grant: Grant, column: string): boolean {
  if (isAlways(column)) return true;
  if (grant === null) return isOfferable(column);
  return grant.includes(column);
}

/** How many of the offerable columns this grant hides. 0 = whole table. */
export function hiddenCount(grant: Grant): number {
  return grant === null ? 0 : OFFERABLE_COLUMNS.length - grant.length;
}

const BARE_IDENT = /^[a-z_][a-z0-9_]*$/;

/** PostgREST needs identifiers with spaces or capitals double-quoted. */
export function quoteIdent(column: string): string {
  return BARE_IDENT.test(column) ? column : `"${column.replace(/"/g, '""')}"`;
}

/**
 * The PostgREST `select` for this grant. Always includes `id` (cursor) and
 * `off_boarded_at` (the in-memory leaver check); never `*`.
 */
export function selectFor(grant: Grant): string {
  const cols = new Set<string>([...ALWAYS_COLUMNS, 'off_boarded_at', ...(grant ?? OFFERABLE_COLUMNS)]);
  return [...cols].map(quoteIdent).join(',');
}

/** Only the visible columns survive. Missing values are kept as `null` so the shape is stable. */
export function projectRow(row: GmlRow, grant: Grant): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of visibleColumns(grant)) out[c] = c in row ? row[c] : null;
  return out;
}

export function projectRows(rows: readonly GmlRow[], grant: Grant): Record<string, unknown>[] {
  return rows.map((r) => projectRow(r, grant));
}

export function filterVisibility(grant: Grant): FilterVisibility {
  return {
    emailColumns: GML_EMAIL_COLUMNS.filter((c) => isVisible(grant, c)),
    name: isVisible(grant, 'Name'),
    department: isVisible(grant, 'Department'),
  };
}

/**
 * The filters in `q` this grant does not allow, by parameter name. Empty = fine.
 * `search` is allowed as long as SOME searchable column is visible; it then
 * searches only those.
 */
export function refusedFilters(q: GmlQuery, grant: Grant): string[] {
  const v = filterVisibility(grant);
  const refused: string[] = [];
  if (q.department != null && !v.department) refused.push('department');
  if (q.email != null && v.emailColumns.length === 0) refused.push('email');
  if (q.search != null && !v.name && v.emailColumns.length === 0) refused.push('search');
  return refused;
}
