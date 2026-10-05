/**
 * What the Manager KPI cache (`kpi-cache.ts`) may hold from two read routes the
 * department calculator calls on every mount, and when a response counts as an
 * answer at all.
 *
 * Both were added after the 2026-09-01 cache and painted cold on every visit:
 *
 *   - `GET /api/qc/assignments` → the **QC first pass** rail (`QcOfficerLog`).
 *     The slowest read on the Lead Gen card, because the route DEALS the week
 *     before it answers (`docs/features/qc-scoring.md` → *The period key is a
 *     SUNDAY*), and the rail sat on "Loading…" for the whole of it.
 *   - `GET /api/manager/departed-members` → who to drop from the table
 *     (`useDepartedMembers`). Uncached, a cached Lead Gen table painted with
 *     every departed person in it, then lost ~158 rows when the live set landed.
 *
 * Pure and client-safe. Same rule as the rest of that store: **a cached value
 * paints, it never decides** — both call sites keep their unconditional fetch.
 */

/** One officer as the rail labels them (`summarizeOfficers` on the server). */
export interface QcLogOfficer {
  email: string;
  index: number;
  memberCount: number;
  name: string | null;
}

/** One dealt slot: which officer is responsible for which member. */
export interface QcLogAssignment {
  qc_officer_email: string;
  member_email: string;
  member_name: string | null;
  department: string;
}

export interface QcLogLock {
  qc_officer_email: string;
  status: 'draft' | 'locked';
  member_count: number;
  locked_at: string | null;
}

export interface QcLogReview {
  department: string;
  status: 'pending' | 'accepted' | 'returned';
  reviewed_by: string | null;
  reviewed_at: string | null;
  note: string | null;
}

/** Everything the rail draws, and the only part of the route's answer it keeps. */
export interface QcOfficerLogPayload {
  officers: QcLogOfficer[];
  assignments: QcLogAssignment[];
  locks: QcLogLock[];
  review: QcLogReview[];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Projects one list field. A field the response LEFT OUT reads as `[]` — the
 * rail has always treated it that way — but a field that is present and not an
 * array, or a row that cannot be drawn, refuses the whole payload: a log with
 * half its rows silently missing would show an officer with fewer people than
 * they were dealt.
 */
function list<T>(v: unknown, row: (r: Obj) => T | null): T[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const r of v) {
    const projected = isObj(r) ? row(r) : null;
    if (projected === null) return null;
    out.push(projected);
  }
  return out;
}

function officerRow(r: Obj): QcLogOfficer | null {
  const email = str(r.email);
  if (email === null || typeof r.index !== 'number' || typeof r.memberCount !== 'number') return null;
  return { email, index: r.index, memberCount: r.memberCount, name: strOrNull(r.name) };
}

function assignmentRow(r: Obj): QcLogAssignment | null {
  const officer = str(r.qc_officer_email);
  const member = str(r.member_email);
  const department = str(r.department);
  if (officer === null || member === null || department === null) return null;
  return { qc_officer_email: officer, member_email: member, member_name: strOrNull(r.member_name), department };
}

function lockRow(r: Obj): QcLogLock | null {
  const officer = str(r.qc_officer_email);
  if (officer === null || (r.status !== 'draft' && r.status !== 'locked')) return null;
  return {
    qc_officer_email: officer,
    status: r.status,
    member_count: typeof r.member_count === 'number' ? r.member_count : 0,
    locked_at: strOrNull(r.locked_at),
  };
}

function reviewRow(r: Obj): QcLogReview | null {
  const department = str(r.department);
  if (department === null) return null;
  if (r.status !== 'pending' && r.status !== 'accepted' && r.status !== 'returned') return null;
  return {
    department,
    status: r.status,
    reviewed_by: strOrNull(r.reviewed_by),
    reviewed_at: strOrNull(r.reviewed_at),
    note: strOrNull(r.note),
  };
}

/**
 * The rail's payload from one `/api/qc/assignments` response, or `null` when the
 * response is not an answer.
 *
 * `null` for a non-2xx status, an `error` body, or a malformed list. Before this,
 * the rail parsed a 500's `{ error }` as four empty lists and told the manager
 * *"No QC officer is assigned to score this department yet"* — a failed read
 * presented as an empty answer, and exactly what must never reach the cache.
 *
 * An allow-list, field by field: the route also returns `mine` (the caller's own
 * slots, with full `EmployeeRow`s for an officer) and each slot's lifecycle
 * columns. The rail draws neither, so neither may be written to `sessionStorage`.
 */
export function qcOfficerLogPayload(ok: boolean, json: unknown): QcOfficerLogPayload | null {
  if (!ok || !isObj(json)) return null;
  if (json.error !== undefined && json.error !== null) return null;
  const officers = list(json.officers, officerRow);
  const assignments = list(json.assignments, assignmentRow);
  const locks = list(json.locks, lockRow);
  const review = list(json.review, reviewRow);
  if (officers === null || assignments === null || locks === null || review === null) return null;
  return { officers, assignments, locks, review };
}

/**
 * One `/api/manager/departed-members` response, read the way the calculator must
 * read it.
 *
 * - `emails` — what to hide NOW: lower-cased, de-duplicated, sorted. **Empty on
 *   any failure**, never the previous answer: hiding a live person means their
 *   KPI bonus is never scored and never paid, while showing a departed one is
 *   noise (`useDepartedMembers.ts`).
 * - `cacheable` — whether this answer may be painted on the next visit. Only a
 *   2xx that is NOT `degraded`. The route fails OPEN with a 200 (`emails: []`
 *   plus a `degraded` reason) when its evidence or timesheet read fails; caching
 *   that would paint a hide-nobody list over a good one, and caching a 4xx's
 *   empty list would do the same.
 */
export function departedMembersResponse(
  ok: boolean,
  json: unknown,
): { emails: string[]; cacheable: boolean } {
  if (!ok || !isObj(json) || !Array.isArray(json.emails)) return { emails: [], cacheable: false };
  if (json.error !== undefined && json.error !== null) return { emails: [], cacheable: false };
  const set = new Set<string>();
  for (const e of json.emails) {
    if (typeof e !== 'string') return { emails: [], cacheable: false };
    const n = e.trim().toLowerCase();
    if (n) set.add(n);
  }
  const degraded = json.degraded !== undefined && json.degraded !== null && json.degraded !== '';
  return { emails: [...set].sort(), cacheable: !degraded };
}

/** True when two hide-sets hold exactly the same addresses. */
export function sameEmailSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const e of a) if (!b.has(e)) return false;
  return true;
}
