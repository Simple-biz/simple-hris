/**
 * The Offboarded dataset — the leavers list outside systems may read with the
 * `offboarded.read` scope (Kane, 2026-10-07: "lets add the offboarded list so that a key
 * can be used to access this"). Query parsing, the exclusion + filter + page step, the
 * projection, and the one read pipeline REST and MCP both run. Pure apart from the
 * injected `readRows` (the route passes the service-role ledger read; tests pass arrays).
 *
 * Rules this module owns, and why each exists:
 *
 *  - **The source is `offboarded_sheet` alone** — the ledger HR → Offboarding → Offboarded
 *    lists. `/api/hr/offboard` writes it on every offboard, so it is the superset. The
 *    `global_master_list.off_boarded_*` stamps are NOT unioned in: measured 2026-10-07, 349
 *    of the 355 stamped master rows with no ledger row are `duplicate_cleanup` markers, not
 *    departures.
 *  - **One row per ledger record.** A re-hire who left twice has two rows, and a recycled
 *    work email can carry a previous holder's departure. A row says "this departure was
 *    recorded", never "this person is gone today" — current status is the roster's job.
 *  - **Not-a-departure labels are never served** (`NOT_DEPARTURE`): `temporary_pause` is a
 *    suspension for approved leave (the person returns via re-onboard), `active` says so in
 *    words, `duplicate_cleanup` / `sheet_sync` are synthetic markers. Dropped BEFORE any
 *    filter runs, so no parameter can reach them.
 *  - **The reason goes out as a CATEGORY, never the stored label.** `off_boarded_reason` is
 *    free text off the old sheet: 29 distinct keys on 2026-10-07, some of them whole
 *    sentences of performance commentary about a named person. Canonical keys pass through,
 *    a short explicit synonym table maps the sheet's high-volume labels, anything else is
 *    `other`, and a blank is `null` (not recorded). The raw label is read only to categorise.
 *  - **Fixed fields.** No per-field grant: every holder receives `OFFBOARDED_COLUMNS`.
 *    `personal_email`, `off_boarded_note`, `off_boarded_by` and `synced_at` are never
 *    SELECTed, so they cannot leak through a projection bug.
 *  - **`work_email` is served only on a company domain** (`COMPANY_EMAIL_DOMAINS`), else
 *    null. Measured 2026-10-07: ~110 sheet-era rows hold a PERSONAL inbox (gmail, yahoo,
 *    outlook) in `work_email`, and one row has a gmail address typed as the name (a name
 *    holding an `@` is served null). The filters match only the SERVED values, so
 *    `?email=someone@gmail.com` cannot confirm a personal address is on the list.
 *  - **Paging is keyset on the ledger's bigint `id`, ascending.** New offboards get higher
 *    ids, so a stored `next_cursor` resumes at exactly the departures recorded since. The
 *    cursor is opaque digits; anything else is refused.
 *  - `limit` ≤ `MAX_LIMIT` (500), below the PostgREST 1000-row cap by construction; the read
 *    itself is paged anyway (`selectAllPaged`).
 */
import { MAX_LIMIT, DEFAULT_LIMIT } from './gml-query';
import { normalizeMasterDate } from '../roster/master-date';
import { WORK_EMAIL_DOMAIN } from '../hr/work-email';

export const OFFBOARDED_TABLE = 'offboarded_sheet';
export const OFFBOARDED_LABEL = 'Offboarded';

/** What the DB read selects — never `*`. `off_boarded_reason` is read to categorise, never served. */
export const OFFBOARDED_SELECT = 'id,name,work_email,department,start_date,off_boarded_at,off_boarded_reason,origin';

/** Columns NO key receives. Not selected at all, so a projection bug cannot leak them. */
export const OFFBOARDED_NEVER = [
  'personal_email',
  'off_boarded_note',
  'off_boarded_by',
  'synced_at',
  'off_boarded_reason (the stored label; served as the reason category)',
] as const;

/** Every key receives these, in this order. `id` is the page cursor. */
export const OFFBOARDED_COLUMNS = [
  'id',
  'name',
  'work_email',
  'department',
  'start_date',
  'off_boarded_at',
  'reason',
  'origin',
] as const;

export type OffboardedLedgerRow = {
  id: number;
  name: string | null;
  work_email: string | null;
  department: string | null;
  start_date: string | null;
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
  origin: string | null;
};

// ─── Company addresses only ───────────────────────────────────────────────────

/**
 * Domains whose addresses are company Workspace accounts. `simple.biz` is today's
 * (`WORK_EMAIL_DOMAIN`); the other two are the earlier company domains the old sheet
 * carries (253 and 5 ledger rows on 2026-10-07). Anything else in `work_email` is a
 * personal inbox the sheet put in the wrong column.
 */
export const COMPANY_EMAIL_DOMAINS: readonly string[] = [WORK_EMAIL_DOMAIN, 'simplesitecompany.com', 'simplebizteam.com'];

/** The work email as served: lower-cased, and only on a company domain — otherwise null. */
export function servedWorkEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return null;
  return COMPANY_EMAIL_DOMAINS.includes(e.slice(at + 1)) ? e : null;
}

/** The name as served: trimmed; a cell holding an address (an `@`) is not a name and is null. */
export function servedName(raw: string | null | undefined): string | null {
  const n = (raw ?? '').trim();
  return n && !n.includes('@') ? n : null;
}

// ─── Reason categories ────────────────────────────────────────────────────────

export const REASON_CATEGORIES = [
  'ncns',
  'resigned',
  'end_of_contract',
  'performance',
  'attendance',
  'time_manipulation',
  'policy_violation',
  'no_show',
  'declined_offer',
  'rescheduled',
  'other',
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

/** Labels that say the person did NOT leave. Never served. */
export const NOT_DEPARTURE: ReadonlySet<string> = new Set(['temporary_pause', 'active', 'duplicate_cleanup', 'sheet_sync']);

/**
 * Sheet-authored labels → category. Exact keys only (after `reasonKey`); anything not
 * here and not itself a category is `other`. Measured 2026-10-07: these cover every label
 * with more than 10 rows.
 */
const SYNONYMS: Readonly<Record<string, ReasonCategory>> = {
  no_show_during_orientation: 'no_show',
  underperformance: 'performance',
  productivity: 'performance',
  reschedule_for_next_week: 'rescheduled',
  need_to_reschedule: 'rescheduled',
};

/** Free text → comparable key — the same normalisation `catalog-roster-visibility.ts` applies. */
export function reasonKey(raw: string | null | undefined): string | null {
  const k = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return k || null;
}

export type ReasonOutcome = { kind: 'excluded' } | { kind: 'category'; value: ReasonCategory | null };

export function categorizeReason(raw: string | null | undefined): ReasonOutcome {
  const k = reasonKey(raw);
  if (k === null) return { kind: 'category', value: null };
  if (NOT_DEPARTURE.has(k)) return { kind: 'excluded' };
  if ((REASON_CATEGORIES as readonly string[]).includes(k)) return { kind: 'category', value: k as ReasonCategory };
  return { kind: 'category', value: SYNONYMS[k] ?? 'other' };
}

// ─── Query ────────────────────────────────────────────────────────────────────

const KNOWN_PARAMS = ['email', 'department', 'reason', 'since', 'until', 'search', 'limit', 'cursor'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_RE = /^\d{1,15}$/;

export type OffboardedQuery = {
  /** Exact work email, case-insensitive. */
  email: string | null;
  /** Exact department label, case-insensitive. */
  department: string | null;
  reason: ReasonCategory | null;
  /** Inclusive, on the UTC calendar date of `off_boarded_at`. A row with no date never matches. */
  since: string | null;
  until: string | null;
  /** Case-insensitive substring over name + work email. */
  search: string | null;
  limit: number;
  /** Exclusive: rows with `id > cursor`. */
  cursor: number | null;
};

export type OffboardedQueryError = { field: string; message: string };
export type ParsedOffboardedQuery = { ok: true; query: OffboardedQuery } | { ok: false; errors: OffboardedQueryError[] };

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Shared by REST (`URLSearchParams`) and MCP (tool arguments, stringified). */
export function parseOffboardedQuery(params: URLSearchParams): ParsedOffboardedQuery {
  const errors: OffboardedQueryError[] = [];
  const str = (name: string): string | null => {
    const v = params.get(name);
    if (v == null) return null;
    const t = v.trim();
    return t ? t : null;
  };

  let limit = DEFAULT_LIMIT;
  const rawLimit = str('limit');
  if (rawLimit != null) {
    if (!/^\d+$/.test(rawLimit)) errors.push({ field: 'limit', message: `limit must be an integer between 1 and ${MAX_LIMIT}` });
    else {
      const n = Number(rawLimit);
      if (n < 1 || n > MAX_LIMIT) errors.push({ field: 'limit', message: `limit must be between 1 and ${MAX_LIMIT}` });
      else limit = n;
    }
  }

  let cursor: number | null = null;
  const rawCursor = str('cursor');
  if (rawCursor != null) {
    if (!CURSOR_RE.test(rawCursor)) errors.push({ field: 'cursor', message: 'cursor must be the next_cursor value from a previous page' });
    else cursor = Number(rawCursor);
  }

  const email = str('email');
  if (email != null && (!email.includes('@') || email.length > 320)) {
    errors.push({ field: 'email', message: 'email must be a single email address' });
  }

  const department = str('department');
  if (department != null && department.length > 120) {
    errors.push({ field: 'department', message: 'department is limited to 120 characters' });
  }

  const search = str('search');
  if (search != null && search.length > 120) errors.push({ field: 'search', message: 'search is limited to 120 characters' });

  let reason: ReasonCategory | null = null;
  const rawReason = str('reason');
  if (rawReason != null) {
    const k = rawReason.toLowerCase();
    if ((REASON_CATEGORIES as readonly string[]).includes(k)) reason = k as ReasonCategory;
    else errors.push({ field: 'reason', message: `reason must be one of ${REASON_CATEGORIES.join(', ')}` });
  }

  const since = str('since');
  if (since != null && !isRealDate(since)) errors.push({ field: 'since', message: 'since must be a date, YYYY-MM-DD' });
  const until = str('until');
  if (until != null && !isRealDate(until)) errors.push({ field: 'until', message: 'until must be a date, YYYY-MM-DD' });
  if (since && until && isRealDate(since) && isRealDate(until) && since > until) {
    errors.push({ field: 'until', message: 'until must be on or after since' });
  }

  for (const key of params.keys()) {
    if (!KNOWN_PARAMS.includes(key)) errors.push({ field: key, message: 'unknown parameter' });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    query: {
      email: email ? email.toLowerCase() : null,
      department,
      reason,
      since,
      until,
      search,
      limit,
      cursor,
    },
  };
}

// ─── Filter + page ────────────────────────────────────────────────────────────

/** A ledger row that IS served, with what goes out resolved once — filters match these, never the raw row. */
type Served = {
  row: OffboardedLedgerRow;
  name: string | null;
  workEmail: string | null;
  reason: ReasonCategory | null;
  leftOn: string | null;
};

export type OffboardedPage = {
  rows: Served[];
  nextCursor: string | null;
  /** Served rows matching the filters, before paging. */
  total: number;
};

function lower(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

export function applyOffboardedQuery(rows: readonly OffboardedLedgerRow[], q: OffboardedQuery): OffboardedPage {
  // 1. Not-a-departure rows out first, unconditionally. Nothing below can see them.
  let out: Served[] = [];
  for (const row of rows) {
    const r = categorizeReason(row.off_boarded_reason);
    if (r.kind === 'excluded') continue;
    out.push({
      row,
      name: servedName(row.name),
      workEmail: servedWorkEmail(row.work_email),
      reason: r.value,
      leftOn: normalizeMasterDate(row.off_boarded_at),
    });
  }

  // 2. Filters — on the SERVED values only, so a filter cannot confirm what is not served.
  if (q.email) out = out.filter((s) => s.workEmail === q.email);
  if (q.department) {
    const d = q.department.toLowerCase();
    out = out.filter((s) => lower(s.row.department) === d);
  }
  if (q.reason) out = out.filter((s) => s.reason === q.reason);
  if (q.since) out = out.filter((s) => s.leftOn !== null && s.leftOn >= q.since!);
  if (q.until) out = out.filter((s) => s.leftOn !== null && s.leftOn <= q.until!);
  if (q.search) {
    const needle = q.search.toLowerCase();
    out = out.filter((s) => lower(s.name).includes(needle) || lower(s.workEmail).includes(needle));
  }

  // 3. Stable numeric order, keyset cursor, page. Matches the SQL `.order('id')`.
  out.sort((a, b) => a.row.id - b.row.id);
  const total = out.length;
  if (q.cursor != null) {
    const c = q.cursor;
    out = out.filter((s) => s.row.id > c);
  }
  const page = out.slice(0, q.limit);
  const hasMore = out.length > q.limit;
  return { rows: page, nextCursor: hasMore && page.length ? String(page[page.length - 1].row.id) : null, total };
}

export type OffboardedOut = {
  id: number;
  name: string | null;
  work_email: string | null;
  department: string | null;
  start_date: string | null;
  off_boarded_at: string | null;
  reason: ReasonCategory | null;
  origin: 'hris' | 'google_sheet' | null;
};

/** The served shape — built field by field, so nothing the row happens to carry rides along. */
export function projectOffboarded(s: Served): OffboardedOut {
  const origin = s.row.origin === 'hris' || s.row.origin === 'google_sheet' ? s.row.origin : null;
  return {
    id: s.row.id,
    name: s.name,
    work_email: s.workEmail,
    department: s.row.department?.trim() || null,
    start_date: normalizeMasterDate(s.row.start_date),
    off_boarded_at: s.row.off_boarded_at ?? null,
    reason: s.reason,
    origin,
  };
}

// ─── The one pipeline REST and MCP share ──────────────────────────────────────

export type ReadOffboardedRows = () => Promise<{ rows: OffboardedLedgerRow[]; error: string | null }>;

export type OffboardedReadPage = {
  limit: number;
  max_limit: number;
  returned: number;
  total: number;
  /** Opaque: the last row's ledger id. Echo it back as `cursor` to continue. */
  next_cursor: string | null;
};

export type OffboardedReadOutcome =
  | { ok: true; data: OffboardedOut[]; page: OffboardedReadPage; columns: string[] }
  | { ok: false; status: 500; denial: 'read_failed'; error: string };

export async function executeOffboardedRead(readRows: ReadOffboardedRows, q: OffboardedQuery): Promise<OffboardedReadOutcome> {
  const { rows, error } = await readRows();
  if (error) return { ok: false, status: 500, denial: 'read_failed', error: 'Could not read the offboarded list' };
  const page = applyOffboardedQuery(rows, q);
  return {
    ok: true,
    data: page.rows.map(projectOffboarded),
    columns: [...OFFBOARDED_COLUMNS],
    page: {
      limit: q.limit,
      max_limit: MAX_LIMIT,
      returned: page.rows.length,
      total: page.total,
      next_cursor: page.nextCursor,
    },
  };
}
