/**
 * One-row-per-week guardrail for the employee Pay Stubs surfaces (list +
 * PDF/XLSX export).
 *
 * The week list is assembled per SOURCE FILE, and the same pay week can exist
 * under several files:
 *   - staged twice under different names — the n8n auto-sync
 *     (`simple-biz_api_sync_…`) and the manual CSV (`simple-biz_daily_report_…`)
 *     both lock the same week;
 *   - re-uploaded with shifted filename boundaries — `…2026-05-03_to_2026-05-09`
 *     vs the `backfill-may10_2026-05-04_to_2026-05-10` repair upload;
 *   - a multi-week `time-activity-report` export overlapping the weekly files.
 *
 * Every duplicate renders as a second statement row for the SAME week and
 * double-counts that week in the export totals — on a legal pay record. This
 * module collapses them: one statement per pay week, deterministically.
 *
 * Week identity: the SUNDAY on/before `weekStart`. Hubstaff pay weeks run
 * Sun–Sat (non-HSL) or Mon–Sun (HSL), so any two rows describing the same pay
 * week anchor to the same Sunday even when their filename ranges are shifted
 * by a day. Rows that aren't week-shaped — no parseable dates, or a span
 * longer than {@link MAX_WEEK_SPAN_DAYS} (e.g. a 4-week time-activity export)
 * — are NEVER grouped or dropped: hiding an unrecognized row could hide real
 * money, so they pass through untouched.
 *
 * Winner per week, in order:
 *   1. a PAID row beats an unpaid one (the money record wins);
 *      both paid → the later `paidAt` (the freshest correction);
 *   2. a STAGED/locked row beats an engine-recovered one (staged is the
 *      exact as-dispatched payload; recovery is a reconstruction);
 *   3. lower `rank` wins (callers pass the upload recency index — newest
 *      upload first — so a repair re-upload beats the row it replaced);
 *   4. first occurrence (stable).
 */

/** Longest start→end span (inclusive days) that still counts as one pay week.
 *  Real weeks label 7 days; 8-day labels (`…06-07_to_06-14`) appear when a
 *  filename carries the boundary day twice. Anything longer is an aggregate
 *  file, not a week. */
export const MAX_WEEK_SPAN_DAYS = 9;

export interface WeekIdentity {
  /** "YYYY-MM-DD…" period start (any parseable prefix). */
  weekStart: string | null | undefined;
  /** "YYYY-MM-DD…" period end. */
  weekEnd: string | null | undefined;
  /** True when a real payment is recorded against this row. */
  paid: boolean;
  /** ISO date/timestamp of the payment, for the both-paid tiebreak. */
  paidAt?: string | null;
  /** True when the row comes from a staged/locked payload (vs recovered). */
  staged?: boolean;
  /** Recency index, lower = newer upload. Defaults to Infinity (unknown). */
  rank?: number;
}

function parseYmd(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Canonical pay-week key for a period: the ISO date of the Sunday on/before
 * `weekStart`. Null when the period is missing, unparseable, or spans more
 * than {@link MAX_WEEK_SPAN_DAYS} days (not a week — never grouped).
 */
export function canonicalWeekKey(
  weekStart: string | null | undefined,
  weekEnd: string | null | undefined,
): string | null {
  const start = parseYmd(weekStart);
  const end = parseYmd(weekEnd);
  if (!start || !end) return null;
  const spanDays = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (spanDays < 1 || spanDays > MAX_WEEK_SPAN_DAYS) return null;
  const sunday = new Date(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay());
  const p = (n: number) => String(n).padStart(2, "0");
  return `${sunday.getFullYear()}-${p(sunday.getMonth() + 1)}-${p(sunday.getDate())}`;
}

/** True when `a` should be shown INSTEAD of `b` for the same pay week. */
function beats(a: WeekIdentity, b: WeekIdentity): boolean {
  if (a.paid !== b.paid) return a.paid;
  if (a.paid && b.paid) {
    const pa = a.paidAt ?? "";
    const pb = b.paidAt ?? "";
    if (pa !== pb) return pa > pb;
  }
  const sa = a.staged === true;
  const sb = b.staged === true;
  if (sa !== sb) return sa;
  const ra = a.rank ?? Number.POSITIVE_INFINITY;
  const rb = b.rank ?? Number.POSITIVE_INFINITY;
  return ra < rb;
}

/**
 * Collapse `rows` to one row per pay week, preserving input order. `identify`
 * extracts each row's {@link WeekIdentity}; rows with no canonical key pass
 * through untouched. The winner keeps the ORIGINAL position of its group's
 * first member, so a caller's existing sort survives.
 */
export function dedupeOneRowPerWeek<T>(rows: T[], identify: (row: T) => WeekIdentity): T[] {
  const byKey = new Map<string, { index: number; row: T; id: WeekIdentity }>();
  // Positions the final list keeps: passthrough rows + each group's first slot.
  const slots: Array<{ passthrough?: T; key?: string }> = [];
  for (const row of rows) {
    const id = identify(row);
    const key = canonicalWeekKey(id.weekStart, id.weekEnd);
    if (!key) {
      slots.push({ passthrough: row });
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { index: slots.length, row, id });
      slots.push({ key });
    } else if (beats(id, existing.id)) {
      existing.row = row;
      existing.id = id;
    }
  }
  const out: T[] = [];
  for (const slot of slots) {
    if (slot.passthrough !== undefined) out.push(slot.passthrough);
    else if (slot.key) {
      const winner = byKey.get(slot.key);
      if (winner) out.push(winner.row);
    }
  }
  return out;
}
