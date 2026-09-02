/**
 * Pure derivations for the Manager → Time adjustments review workspace.
 *
 * Everything here is a pure function over the raw `GET /api/manager/time-adjustments`
 * payload. Two reasons it lives outside the component:
 *
 *  1. `manager-dashboard-cache.md` § *Shapes that do not survive JSON.stringify* —
 *     the cache mirror is JSON, so a `Set` serialises to `{}`. The RAW payload is
 *     what gets cached and the render shape is derived, "through a module-scope pure
 *     function that the fetch path calls too, so the seeded and fetched paths cannot
 *     diverge."
 *  2. This project's tests are `node --test` over `src/**\/*.test.ts` with no React
 *     renderer, so logic inside a `.tsx` component is untestable by construction.
 *
 * The buckets are deliberately COARSER than the status column. A viewer wears two
 * hats (department manager, named second approver) and the segment strip is for
 * triage, so `in-flight` collapses several real statuses. Every row still renders
 * its own precise status label, so a coarse bucket never makes a row lie.
 */
import type { TimeAdjustmentRow } from '@/lib/supabase/time-adjustments';
import {
  TIME_ADJUSTMENT_REASONS,
  adjustmentIsFinallyDecided,
} from '@/lib/supabase/time-adjustments';

/** The raw shape the route returns. This, verbatim, is what gets cached. */
export type TimeAdjustmentQueuePayload = {
  rows: TimeAdjustmentRow[];
  viewerEmail: string;
  managedIds: string[];
};

export const EMPTY_QUEUE_PAYLOAD: TimeAdjustmentQueuePayload = {
  rows: [],
  viewerEmail: '',
  managedIds: [],
};

export type TaBucket =
  | 'needs-you'
  | 'countersign'
  | 'in-flight'
  | 'approved'
  | 'declined';

/** Segment order, left to right. `all` is rendered separately as the leading tab. */
export const TA_BUCKET_ORDER: readonly TaBucket[] = [
  'needs-you',
  'countersign',
  'in-flight',
  'approved',
  'declined',
] as const;

export const TA_BUCKET_LABEL: Record<TaBucket, string> = {
  'needs-you': 'Needs you',
  countersign: 'Countersign',
  'in-flight': 'In review',
  approved: 'Approved',
  declined: 'Declined',
};

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/**
 * Round for DISPLAY only. The old UI printed `requested_hours` verbatim, so a
 * manager read `+4.566666666666666h req` on screen (see the handoff's
 * `original-ui.png`). The raw value stays untouched for payroll math — only the
 * string is rounded.
 */
export function roundAdjustmentHours(hours: number): number {
  return Math.round(hours * 100) / 100;
}

/** `4.57 h` · `1.5 h` · `7 h` · `—` when there is no value at all. */
export function fmtAdjustmentHours(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return '—';
  return `${roundAdjustmentHours(hours)} h`;
}

/**
 * Rows this viewer still owes a MANAGER decision on. `managedIds` comes from the
 * server (department scope): a row reaching the viewer only because it names them
 * as second approver must never show the manager's controls.
 */
export function taNeedsMyManagerDecision(
  row: TimeAdjustmentRow,
  managedIds: ReadonlySet<string>,
): boolean {
  return row.status === 'pending' && row.manager_decision == null && managedIds.has(row.id);
}

/**
 * Rows this viewer still owes a SECOND-APPROVER decision on. Keyed on the
 * assignment, not the status: the second approver may act while the row is still
 * `pending` because the manager has not decided yet.
 */
export function taNeedsMySecondDecision(row: TimeAdjustmentRow, viewerEmail: string): boolean {
  const me = norm(viewerEmail);
  return (
    !!me &&
    norm(row.second_approver_email) === me &&
    row.second_decision == null &&
    (row.status === 'pending' || row.status === 'awaiting_second_approval')
  );
}

/**
 * Which segment a row belongs to, for THIS viewer.
 *
 * The two "owed by me" buckets win over everything else, and they are mutually
 * exclusive by construction: a manager cannot name themselves, so no row can owe
 * the same person both signatures.
 */
export function bucketOfRequest(
  row: TimeAdjustmentRow,
  managedIds: ReadonlySet<string>,
  viewerEmail: string,
): TaBucket {
  if (taNeedsMyManagerDecision(row, managedIds)) return 'needs-you';
  if (taNeedsMySecondDecision(row, viewerEmail)) return 'countersign';
  if (row.status === 'approved') return 'approved';
  if (row.status === 'denied' || row.status === 'manager_denied') return 'declined';
  // Everything left is genuinely in flight waiting on somebody who is not this
  // viewer: `awaiting_second_approval`, `manager_approved` (with Accounting), and
  // a still-`pending` row this viewer has already countersigned.
  return 'in-flight';
}

/**
 * How a row's own status chip reads, and how loudly.
 *
 * The segments are coarse on purpose (see the file header), so the per-row chip is
 * what keeps a row honest: an `in-flight` row says whether it is parked on the
 * manager, on a countersignature, or on Accounting, rather than inheriting the
 * segment's vaguer word.
 *
 * `tone` follows the handoff's rule — the accent is reserved for what needs action,
 * and everything resolved is neutral, so a queue can be triaged at a glance.
 */
export type TaChipTone = 'action' | 'flight' | 'resolved';

export function rowStatusChip(
  row: TimeAdjustmentRow,
  managedIds: ReadonlySet<string>,
  viewerEmail: string,
): { label: string; tone: TaChipTone } {
  switch (bucketOfRequest(row, managedIds, viewerEmail)) {
    case 'needs-you':
      return { label: 'Needs your review', tone: 'action' };
    case 'countersign':
      return { label: 'Needs your countersignature', tone: 'action' };
    case 'approved':
      return { label: 'Approved', tone: 'resolved' };
    case 'declined':
      return {
        label: row.status === 'manager_denied' ? 'Declined in review' : 'Denied by Accounting',
        tone: 'resolved',
      };
    default:
      if (row.status === 'manager_approved') return { label: 'With Accounting', tone: 'flight' };
      if (row.status === 'awaiting_second_approval') {
        return { label: 'Awaiting second approver', tone: 'flight' };
      }
      // A still-`pending` row this viewer has already countersigned.
      return { label: 'Awaiting the manager', tone: 'flight' };
  }
}

/** Best available decision timestamp — accounting, else second, else manager, else creation. */
export function taDecidedAt(row: TimeAdjustmentRow): string {
  return (
    row.decided_at ??
    row.second_decided_at ??
    row.manager_decided_at ??
    row.updated_at ??
    row.created_at ??
    ''
  );
}

/**
 * A request has reached a terminal verdict (and so counts toward decided stats).
 * Delegates to the shared predicate so this surface cannot drift from the rest of
 * the app on what "decided" means.
 */
export const isDecidedRequest = adjustmentIsFinallyDecided;

export type TaFilters = {
  query: string;
  bucket: TaBucket | 'all';
  reason: string;
  period: string;
};

export const EMPTY_TA_FILTERS: TaFilters = {
  query: '',
  bucket: 'all',
  reason: 'all',
  period: 'all',
};

export function hasActiveTaFilter(f: TaFilters): boolean {
  return (
    f.query.trim().length > 0 ||
    f.bucket !== 'all' ||
    f.reason !== 'all' ||
    f.period !== 'all'
  );
}

export function reasonLabel(code: string): string {
  return TIME_ADJUSTMENT_REASONS.find((r) => r.code === code)?.label ?? code;
}

/**
 * The pay period a row belongs to. `period_label` is stamped at creation; rows
 * predating it fall back to the adjusted date's own month, which is the only other
 * defensible answer. Never invent "unknown" — that would hide the row from a
 * period filter that claims to cover everything.
 */
export function periodOf(row: TimeAdjustmentRow): string {
  const stamped = (row.period_label ?? '').trim();
  if (stamped) return stamped;
  return (row.adjust_date ?? '').slice(0, 7);
}

/** Filters are AND-combined, exactly as the handoff specifies. */
export function filterRequests(
  rows: readonly TimeAdjustmentRow[],
  filters: TaFilters,
  managedIds: ReadonlySet<string>,
  viewerEmail: string,
): TimeAdjustmentRow[] {
  const q = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (
      filters.bucket !== 'all' &&
      bucketOfRequest(row, managedIds, viewerEmail) !== filters.bucket
    ) {
      return false;
    }
    if (filters.reason !== 'all' && row.reason !== filters.reason) return false;
    if (filters.period !== 'all' && periodOf(row) !== filters.period) return false;
    if (q) {
      const haystack = [
        row.work_email,
        // Both the label a manager can see on screen AND the stored code, so
        // typing either finds the row.
        reasonLabel(row.reason),
        row.reason,
        row.explanation ?? '',
        row.manager_decision_note ?? '',
        row.second_decision_note ?? '',
        row.decision_note ?? '',
        row.id,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export type TaBucketCounts = Record<TaBucket | 'all', number>;

export function countBuckets(
  rows: readonly TimeAdjustmentRow[],
  managedIds: ReadonlySet<string>,
  viewerEmail: string,
): TaBucketCounts {
  const counts: TaBucketCounts = {
    all: rows.length,
    'needs-you': 0,
    countersign: 0,
    'in-flight': 0,
    approved: 0,
    declined: 0,
  };
  for (const row of rows) counts[bucketOfRequest(row, managedIds, viewerEmail)] += 1;
  return counts;
}

/**
 * The segment to land on. First bucket with outstanding work, in strict priority.
 *
 * This is load-bearing, not a nicety. `time-adjustment-requests.md` records that
 * there is deliberately NO "you were named second approver" notification (a new
 * `employee_notifications.type` would mean restating a closed CHECK allowlist), so
 * the tab's own countersign queue plus the sidebar count ARE the discovery path.
 * Defaulting to a segment that hides it would silently remove the only way a named
 * approver finds their work.
 */
export function defaultBucketFor(counts: TaBucketCounts): TaBucket | 'all' {
  if (counts['needs-you'] > 0) return 'needs-you';
  if (counts.countersign > 0) return 'countersign';
  return 'all';
}

/**
 * Median days from submission to terminal verdict, as `1.8 d`.
 *
 * Median, never mean: one request sitting for three months would drag an average
 * far enough to make a healthy queue look broken.
 */
export function medianDecisionDays(rows: readonly TimeAdjustmentRow[]): number | null {
  const spans: number[] = [];
  for (const row of rows) {
    if (!isDecidedRequest(row)) continue;
    const from = Date.parse(row.created_at ?? '');
    const to = Date.parse(taDecidedAt(row));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
    spans.push((to - from) / 86_400_000);
  }
  if (spans.length === 0) return null;
  spans.sort((a, b) => a - b);
  const mid = Math.floor(spans.length / 2);
  return spans.length % 2 === 1 ? spans[mid] : (spans[mid - 1] + spans[mid]) / 2;
}

export type TaKpis = {
  /** Everything owed by this viewer, under either hat. The one accented number. */
  owedByMe: number;
  owedAsManager: number;
  owedAsSecondApprover: number;
  /** Requested hours summed across the rows owed by this viewer. */
  owedHours: number;
  /** Parked on a countersignature that is NOT this viewer's. */
  awaitingSecondApprover: number;
  decidedInWindow: number;
  /** Percent of `decidedInWindow` that ended approved, or null when none did. */
  approvalRate: number | null;
  medianDays: number | null;
  /** How many decided rows the median is computed over — the honest denominator. */
  medianSample: number;
};

export const DECIDED_WINDOW_DAYS = 30;

export function buildQueueKpis(
  rows: readonly TimeAdjustmentRow[],
  managedIds: ReadonlySet<string>,
  viewerEmail: string,
  now: number = Date.now(),
): TaKpis {
  const cutoff = now - DECIDED_WINDOW_DAYS * 86_400_000;
  let owedAsManager = 0;
  let owedAsSecondApprover = 0;
  let owedHours = 0;
  let awaitingSecondApprover = 0;
  let decidedInWindow = 0;
  let approvedInWindow = 0;

  for (const row of rows) {
    const bucket = bucketOfRequest(row, managedIds, viewerEmail);
    if (bucket === 'needs-you') owedAsManager += 1;
    if (bucket === 'countersign') owedAsSecondApprover += 1;
    if (bucket === 'needs-you' || bucket === 'countersign') {
      owedHours += row.requested_hours ?? 0;
    }
    // Genuinely parked on somebody else's countersignature.
    if (row.status === 'awaiting_second_approval' && bucket !== 'countersign') {
      awaitingSecondApprover += 1;
    }
    if (isDecidedRequest(row)) {
      const at = Date.parse(taDecidedAt(row));
      if (Number.isFinite(at) && at >= cutoff) {
        decidedInWindow += 1;
        if (row.status === 'approved') approvedInWindow += 1;
      }
    }
  }

  const decidedRows = rows.filter(isDecidedRequest);
  return {
    owedByMe: owedAsManager + owedAsSecondApprover,
    owedAsManager,
    owedAsSecondApprover,
    owedHours: roundAdjustmentHours(owedHours),
    awaitingSecondApprover,
    decidedInWindow,
    approvalRate:
      decidedInWindow > 0 ? Math.round((approvedInWindow / decidedInWindow) * 100) : null,
    medianDays: medianDecisionDays(rows),
    medianSample: decidedRows.length,
  };
}

/** Distinct pay periods present in the data, newest first. */
export function periodOptionsFrom(rows: readonly TimeAdjustmentRow[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const p = periodOf(row);
    if (p) set.add(p);
  }
  return [...set].sort((a, b) => b.localeCompare(a));
}

/** Distinct reason codes present in the data, in the catalog's own order. */
export function reasonOptionsFrom(rows: readonly TimeAdjustmentRow[]): string[] {
  const present = new Set(rows.map((r) => r.reason));
  const ordered = TIME_ADJUSTMENT_REASONS.filter((r) => present.has(r.code)).map((r) => r.code);
  // A code the catalog does not know still has to be filterable.
  const unknown = [...present].filter((c) => !ordered.includes(c)).sort();
  return [...ordered, ...unknown];
}

/**
 * A human-readable handle for one request.
 *
 * The handoff shows `TA-2412`. There is no such column and no numbering scheme in
 * this system, so this returns the real uuid's leading block rather than inventing
 * a sequence that would look authoritative and mean nothing.
 */
export function requestRef(id: string): string {
  return (id ?? '').slice(0, 8).toUpperCase();
}

export type TrailEntry = { at: string; who: string; what: string; note?: string | null };

/**
 * The decision trail as ONE chronology — submission, the manager's sign-off, the
 * second-approver assignment and their countersignature, then Accounting.
 *
 * This replaces the old separate "Manager decision" / "Second approver" blocks.
 * Entries with no timestamp are dropped rather than dated `now`: an undated event
 * placed in a chronology is a fabricated fact.
 */
export function decisionTrail(row: TimeAdjustmentRow): TrailEntry[] {
  const entries: TrailEntry[] = [];

  if (row.created_at) {
    entries.push({
      at: row.created_at,
      who: row.created_by || row.work_email,
      what: 'submitted the request',
    });
  }

  if (row.second_approver_email && row.second_approver_assigned_at) {
    entries.push({
      at: row.second_approver_assigned_at,
      who: row.second_approver_assigned_by || 'A manager',
      what: `named ${row.second_approver_email} as second approver`,
    });
  }

  if (row.manager_decision && row.manager_decided_at) {
    entries.push({
      at: row.manager_decided_at,
      who: row.manager_decided_by || 'The department manager',
      what: row.manager_decision === 'approved' ? 'approved as manager' : 'declined as manager',
      note: row.manager_decision_note,
    });
  }

  if (row.second_decision && row.second_decided_at) {
    entries.push({
      at: row.second_decided_at,
      who: row.second_decided_by || row.second_approver_email || 'The second approver',
      what:
        row.second_decision === 'approved'
          ? 'approved as second approver'
          : 'declined as second approver',
      note: row.second_decision_note,
    });
  }

  if (row.decided_at && (row.status === 'approved' || row.status === 'denied')) {
    entries.push({
      at: row.decided_at,
      who: row.decided_by || 'Accounting',
      what:
        row.status === 'approved'
          ? `approved ${fmtAdjustmentHours(row.approved_hours)}`
          : 'denied',
      note: row.decision_note,
    });
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Derive the render shape from the cached raw payload.
 *
 * The `Set` is built HERE rather than stored, because `JSON.stringify(new Set())`
 * is `{}` and the cache mirror is JSON.
 */
export function deriveQueue(payload: TimeAdjustmentQueuePayload): {
  rows: TimeAdjustmentRow[];
  managedIds: ReadonlySet<string>;
  viewerEmail: string;
} {
  return {
    rows: payload.rows ?? [],
    managedIds: new Set(payload.managedIds ?? []),
    viewerEmail: norm(payload.viewerEmail),
  };
}
