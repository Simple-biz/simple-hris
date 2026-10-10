/**
 * Pure rules for Penny's `list_offboarded` — the Offboarded ledger read as a
 * LIST: who left in a window, from which department, for which reason, and
 * who recorded it.
 *
 * Built 2026-10-09 (Kane: "Admin - Penny AI - Does not know about the
 * Offboarded data"). Until then every Penny tool was per-person, so "who was
 * off-boarded this week" or "how many Lead Gen offboards in September" had no
 * tool at all, and the per-person search could reach only 1,520 of the
 * ledger's 4,462 rows.
 *
 * Rules, and why each exists:
 *
 *  - **The source is `offboarded_sheet`, the departures superset** — the same
 *    ledger HR → Offboarding → Offboarded and the Offboarded dataset read
 *    (external-api-offboarded.md). The master-list stamps are not unioned in:
 *    most stamped rows with no ledger row are `duplicate_cleanup` markers.
 *  - **Not-a-departure rows are never counted as departures** (`NOT_DEPARTURE`,
 *    reused from the dataset). They are counted SEPARATELY, so a temporary
 *    pause is visible as a pause instead of vanishing.
 *  - **A row is a recorded departure, never today's status.** Each returned row
 *    says whether that person is back on the active roster (`samePerson`) or
 *    whether their work email now belongs to someone else.
 *  - **A filter that cannot be applied is an error, never ignored** — answering
 *    "Lead Gen in September" with every department would be a wrong answer
 *    that looks right.
 *  - **Dates match the UTC calendar date of `off_boarded_at`** (the dataset's
 *    rule). An undated row never matches a date filter, and the result says how
 *    many undated rows the window could not see.
 */
import {
  REASON_CATEGORIES,
  categorizeReason,
  reasonKey,
  servedName,
  type ReasonCategory,
} from '@/lib/external-api/offboarded';
import { normalizeMasterDate } from '@/lib/roster/master-date';
import { isoDay, ledgerAddresses, samePerson, type ActiveHolder } from './roster-match';

/** One `offboarded_sheet` row as Penny reads it. */
export interface PennyLedgerRow {
  id: number;
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
  department: string | null;
  start_date: string | null;
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
  off_boarded_by: string | null;
  origin: string | null;
}

export const LIST_DEFAULT_LIMIT = 25;
export const LIST_MAX_LIMIT = 50;
/** Long enough for every canonical label; some sheet labels are whole sentences. */
export const REASON_LABEL_MAX = 80;
export const LEDGER_ORIGINS = ['hris', 'google_sheet'] as const;
export type LedgerOrigin = (typeof LEDGER_ORIGINS)[number];
export const NOT_RECORDED = 'not_recorded';
type ReasonFilter = ReasonCategory | typeof NOT_RECORDED;

export interface OffboardedListQuery {
  since: string | null;
  until: string | null;
  department: string | null;
  reason: ReasonFilter | null;
  origin: LedgerOrigin | null;
  search: string | null;
  limit: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s: string) => DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const lower = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/** Parse the model's input. Every bad filter is named; none is silently dropped. */
export function parseOffboardedListInput(
  input: Record<string, unknown>,
): { ok: true; query: OffboardedListQuery } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const text = (k: string): string | null => {
    const v = input[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') {
      errors.push(`${k} must be a string`);
      return null;
    }
    return v.trim() || null;
  };

  const since = text('since');
  const until = text('until');
  if (since && !isRealDate(since)) errors.push('since must be a real date as YYYY-MM-DD');
  if (until && !isRealDate(until)) errors.push('until must be a real date as YYYY-MM-DD');
  if (since && until && isRealDate(since) && isRealDate(until) && since > until) errors.push('since is after until');

  const reasonRaw = text('reason');
  const reasonKeyed = reasonRaw ? reasonKey(reasonRaw) : null;
  const reasons: readonly string[] = [...REASON_CATEGORIES, NOT_RECORDED];
  if (reasonRaw && !(reasonKeyed && reasons.includes(reasonKeyed))) {
    errors.push(`reason must be one of: ${reasons.join(', ')}`);
  }

  const originRaw = text('origin');
  const originKeyed = originRaw ? reasonKey(originRaw) : null;
  if (originRaw && !(originKeyed && (LEDGER_ORIGINS as readonly string[]).includes(originKeyed))) {
    errors.push(`origin must be one of: ${LEDGER_ORIGINS.join(', ')}`);
  }

  const search = text('search');
  if (search && search.length < 2) errors.push('search must be at least 2 characters');

  const department = text('department');

  const limitRaw = input.limit;
  const n = typeof limitRaw === 'number' ? limitRaw : typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : NaN;
  const limit = Number.isFinite(n) ? Math.max(1, Math.min(LIST_MAX_LIMIT, Math.trunc(n))) : LIST_DEFAULT_LIMIT;

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    query: {
      since,
      until,
      department,
      reason: (reasonKeyed as ReasonFilter | null) ?? null,
      origin: (originKeyed as LedgerOrigin | null) ?? null,
      search,
      limit,
    },
  };
}

export interface OffboardedListRow {
  id: number;
  name: string | null;
  work_email: string | null;
  /** Only when there is no company work email — the row's one address. */
  personal_email?: string | null;
  department: string | null;
  start_date: string | null;
  off_boarded_at: string | null;
  reason: ReasonCategory | null;
  reason_label: string | null;
  recorded_by: string | null;
  origin: string | null;
  /** The same person is on the active roster today (re-hired / came back). */
  back_on_active_roster?: true;
  /** Their work email was re-issued; these ACTIVE people hold it now. */
  work_email_now_held_by?: string[];
}

export interface OffboardedListResult {
  total: number;
  by_reason: Record<string, number>;
  by_department: Array<{ department: string; count: number }>;
  departments_not_shown: number;
  by_month: Record<string, number>;
  by_origin: Record<string, number>;
  recorded_by: Array<{ actor: string; count: number }>;
  back_on_active_roster: number;
  undated_matches: number;
  undated_outside_date_filter: number;
  not_departures_excluded: Record<string, number>;
  earliest: string | null;
  latest: string | null;
  rows: OffboardedListRow[];
  truncated: boolean;
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const sortedCounts = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/**
 * Filter, count and page the ledger. `active` is the live roster, used only to
 * label what a row is TODAY — never to hide a recorded departure.
 */
export function listOffboardedLedger(
  rows: readonly PennyLedgerRow[],
  q: OffboardedListQuery,
  active: readonly ActiveHolder[],
): OffboardedListResult {
  const dated = !!(q.since || q.until);
  const dept = lower(q.department);
  const needle = lower(q.search);

  const holdersByWork = new Map<string, ActiveHolder[]>();
  const holdersByPersonal = new Map<string, ActiveHolder[]>();
  for (const h of active) {
    for (const [m, k] of [[holdersByWork, lower(h.work_email)], [holdersByPersonal, lower(h.personal_email)]] as const) {
      if (!k) continue;
      const list = m.get(k);
      if (list) list.push(h);
      else m.set(k, [h]);
    }
  }
  const today = (r: PennyLedgerRow) => {
    const { work, personal } = ledgerAddresses(r);
    const me = { name: servedName(r.name), personal_email: personal };
    const onWork = work ? (holdersByWork.get(work) ?? []) : [];
    const onPersonal = personal ? (holdersByPersonal.get(personal) ?? []) : [];
    if ([...onWork, ...onPersonal].some((h) => samePerson(me, h))) return { back: true as const };
    const names = onWork.map((h) => servedName(h.name)).filter((n): n is string => !!n);
    return names.length ? { heldBy: names } : {};
  };

  const excluded = new Map<string, number>();
  let undatedOutside = 0;
  const matched: Array<{ r: PennyLedgerRow; day: string | null; reason: ReasonCategory | null }> = [];

  for (const r of rows) {
    if (dept && lower(r.department) !== dept) continue;
    if (q.origin && lower(r.origin) !== q.origin) continue;
    if (needle) {
      const { work, personal } = ledgerAddresses(r);
      const hay = [lower(servedName(r.name)), work ?? '', personal ?? ''];
      if (!hay.some((h) => h.includes(needle))) continue;
    }
    const day = isoDay(r.off_boarded_at);
    if (dated) {
      if (!day) {
        undatedOutside++;
        continue;
      }
      if (q.since && day < q.since) continue;
      if (q.until && day > q.until) continue;
    }
    const outcome = categorizeReason(r.off_boarded_reason);
    if (outcome.kind === 'excluded') {
      bump(excluded, reasonKey(r.off_boarded_reason) ?? 'unknown');
      continue;
    }
    if (q.reason && (outcome.value ?? NOT_RECORDED) !== q.reason) continue;
    matched.push({ r, day, reason: outcome.value });
  }

  // Newest departure first; undated last; ties newest ledger id first.
  matched.sort((a, b) => {
    if (a.day !== b.day) {
      if (!a.day) return 1;
      if (!b.day) return -1;
      const t = (b.r.off_boarded_at ?? '').localeCompare(a.r.off_boarded_at ?? '');
      if (t !== 0) return t;
    }
    return b.r.id - a.r.id;
  });

  const byReason = new Map<string, number>();
  const byDept = new Map<string, number>();
  const byMonth = new Map<string, number>();
  const byOrigin = new Map<string, number>();
  const byActor = new Map<string, number>();
  let undated = 0;
  let back = 0;
  let noDept = 0;
  for (const m of matched) {
    bump(byReason, m.reason ?? NOT_RECORDED);
    const d = (m.r.department ?? '').trim();
    if (d) bump(byDept, d);
    else noDept++;
    if (m.day) bump(byMonth, m.day.slice(0, 7));
    else undated++;
    bump(byOrigin, (m.r.origin ?? '').trim() || NOT_RECORDED);
    bump(byActor, (m.r.off_boarded_by ?? '').trim() || NOT_RECORDED);
    if (today(m.r).back) back++;
  }
  const deptList = sortedCounts(byDept).map(([department, count]) => ({ department, count }));
  if (noDept) deptList.push({ department: NOT_RECORDED, count: noDept });
  const DEPT_SHOWN = 15;

  const days = matched.map((m) => m.day).filter((d): d is string => !!d).sort();

  const shown = matched.slice(0, q.limit).map(({ r, day, reason }): OffboardedListRow => {
    const { work, personal } = ledgerAddresses(r);
    const label = (r.off_boarded_reason ?? '').trim();
    const now = today(r);
    return {
      id: r.id,
      name: servedName(r.name),
      work_email: work,
      ...(work ? {} : { personal_email: personal }),
      department: (r.department ?? '').trim() || null,
      start_date: normalizeMasterDate(r.start_date),
      off_boarded_at: day,
      reason,
      reason_label: label ? (label.length > REASON_LABEL_MAX ? `${label.slice(0, REASON_LABEL_MAX - 1)}…` : label) : null,
      recorded_by: (r.off_boarded_by ?? '').trim() || null,
      origin: (r.origin ?? '').trim() || null,
      ...(now.back ? { back_on_active_roster: true as const } : {}),
      ...(now.heldBy ? { work_email_now_held_by: now.heldBy } : {}),
    };
  });

  return {
    total: matched.length,
    by_reason: Object.fromEntries(sortedCounts(byReason)),
    by_department: deptList.slice(0, DEPT_SHOWN),
    departments_not_shown: Math.max(0, deptList.length - DEPT_SHOWN),
    by_month: Object.fromEntries([...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    by_origin: Object.fromEntries(sortedCounts(byOrigin)),
    recorded_by: sortedCounts(byActor).slice(0, 10).map(([actor, count]) => ({ actor, count })),
    back_on_active_roster: back,
    undated_matches: undated,
    undated_outside_date_filter: undatedOutside,
    not_departures_excluded: Object.fromEntries(sortedCounts(excluded)),
    earliest: days[0] ?? null,
    latest: days.at(-1) ?? null,
    rows: shown,
    truncated: matched.length > shown.length,
  };
}
