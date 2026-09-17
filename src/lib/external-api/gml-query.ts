/**
 * The Global Master List read that outside systems get — query parsing and the
 * in-memory filter/page step. Pure: the route reads the rows (service-role,
 * `selectAllPaged`, `off_boarded_at IS NULL` in SQL) and hands them here.
 *
 * Rules this module owns:
 *
 *  - **Off-boarded people are unreachable** (Kane, 2026-09-16). `applyGmlQuery`
 *    drops any row with `off_boarded_at` set BEFORE any filter runs, so even if
 *    the SQL filter were ever removed a leaver could not be reached by email,
 *    department or search. There is no parameter that turns this off.
 *  - **Columns are the client's GRANT** (2026-09-17, superseding "all columns" of
 *    2026-09-16): the route selects and projects by `grants.ts`; this module only
 *    filters, and only on columns the grant makes visible (`FilterVisibility`).
 *  - **`limit` <= 500**, below the PostgREST 1000-row cap by construction; the
 *    read itself is paged anyway. Paging is keyset on `id` (stable, no shear
 *    when a sync inserts mid-walk); the cursor is exclusive.
 *  - `email` matches ANY of the four email columns, case-insensitively — the
 *    master list treats alternates as aliases (identity-resolution.md).
 */

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 100;

/** Every column on `global_master_list` that can carry an email for the same human. */
export const GML_EMAIL_COLUMNS = [
  'Work Email',
  'Personal Email',
  'Alternate Work Email',
  'Alternate Work Email 2',
] as const;

const KNOWN_PARAMS = ['department', 'email', 'search', 'limit', 'cursor'];

export type GmlRow = Record<string, unknown> & { id: number };

export type GmlQuery = {
  department: string | null;
  email: string | null;
  /** Case-insensitive substring over Name and the four email columns. */
  search: string | null;
  limit: number;
  /** Exclusive: rows with `id > cursor`. */
  cursor: number | null;
};

export type GmlQueryError = { field: string; message: string };

export type ParsedGmlQuery = { ok: true; query: GmlQuery } | { ok: false; errors: GmlQueryError[] };

function str(params: URLSearchParams, name: string): string | null {
  const v = params.get(name);
  if (v == null) return null;
  const t = v.trim();
  return t ? t : null;
}

export function parseGmlQuery(params: URLSearchParams): ParsedGmlQuery {
  const errors: GmlQueryError[] = [];

  let limit = DEFAULT_LIMIT;
  const rawLimit = str(params, 'limit');
  if (rawLimit != null) {
    if (!/^\d+$/.test(rawLimit)) {
      errors.push({ field: 'limit', message: `limit must be an integer between 1 and ${MAX_LIMIT}` });
    } else {
      const n = Number(rawLimit);
      if (n < 1 || n > MAX_LIMIT) errors.push({ field: 'limit', message: `limit must be between 1 and ${MAX_LIMIT}` });
      else limit = n;
    }
  }

  let cursor: number | null = null;
  const rawCursor = str(params, 'cursor');
  if (rawCursor != null) {
    if (!/^\d+$/.test(rawCursor)) {
      errors.push({ field: 'cursor', message: 'cursor must be the next_cursor value from a previous page' });
    } else {
      cursor = Number(rawCursor);
    }
  }

  const email = str(params, 'email');
  if (email != null && (!email.includes('@') || email.length > 320)) {
    errors.push({ field: 'email', message: 'email must be a single email address' });
  }

  const search = str(params, 'search');
  if (search != null && search.length > 120) {
    errors.push({ field: 'search', message: 'search is limited to 120 characters' });
  }

  const department = str(params, 'department');
  if (department != null && department.length > 120) {
    errors.push({ field: 'department', message: 'department is limited to 120 characters' });
  }

  for (const key of params.keys()) {
    if (!KNOWN_PARAMS.includes(key)) errors.push({ field: key, message: 'unknown parameter' });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    query: { department, email: email ? email.toLowerCase() : null, search, limit, cursor },
  };
}

function text(v: unknown): string {
  return v == null ? '' : String(v);
}

function isOffBoarded(row: GmlRow): boolean {
  const v = row['off_boarded_at'];
  return v != null && String(v).trim() !== '';
}

/**
 * Which columns a filter may look at — derived from the client's column grant
 * (`grants.ts`). A key that cannot SEE Personal Email must not be able to match on
 * it either, or `?email=` would confirm that a private address belongs to an
 * active person. The default is everything, for callers with a whole-table grant.
 */
export type FilterVisibility = {
  /** Email columns `?email=` and `?search=` may match against. */
  emailColumns: readonly string[];
  /** May `?search=` look at Name? */
  name: boolean;
  /** May `?department=` be used? (The route refuses it before this runs; here it is just honoured.) */
  department: boolean;
};

export const ALL_VISIBLE: FilterVisibility = { emailColumns: GML_EMAIL_COLUMNS, name: true, department: true };

export type GmlPage = {
  rows: GmlRow[];
  /** `id` of the last row returned, or null when this was the final page. */
  nextCursor: number | null;
  /** Active rows matching the filters, before paging. */
  total: number;
};

export function applyGmlQuery(rows: readonly GmlRow[], q: GmlQuery, visible: FilterVisibility = ALL_VISIBLE): GmlPage {
  // 1. Leavers out first, unconditionally. Nothing below can see them.
  let out = rows.filter((r) => !isOffBoarded(r));

  // 2. Filters — each one looks only at columns the caller may see.
  if (q.department) {
    const dept = q.department.toLowerCase();
    out = visible.department ? out.filter((r) => text(r['Department']).trim().toLowerCase() === dept) : [];
  }
  if (q.email) {
    const em = q.email;
    out = out.filter((r) => visible.emailColumns.some((c) => text(r[c]).trim().toLowerCase() === em));
  }
  if (q.search) {
    const needle = q.search.toLowerCase();
    out = out.filter(
      (r) =>
        (visible.name && text(r['Name']).toLowerCase().includes(needle)) ||
        visible.emailColumns.some((c) => text(r[c]).toLowerCase().includes(needle)),
    );
  }

  // 3. Stable order, keyset cursor, page.
  out.sort((a, b) => a.id - b.id);
  const total = out.length;
  if (q.cursor != null) {
    const c = q.cursor;
    out = out.filter((r) => r.id > c);
  }
  const page = out.slice(0, q.limit);
  const hasMore = out.length > q.limit;
  return { rows: page, nextCursor: hasMore && page.length ? page[page.length - 1].id : null, total };
}
