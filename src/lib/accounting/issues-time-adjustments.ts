/**
 * Accounting → Issues: the time-adjustment rows of the merged Issues table.
 *
 * Until 2026-09-15 a time adjustment that had collected BOTH stage-1 signatures
 * (`manager_approved`) was visible to Accounting in exactly one place: the Payroll
 * Wizard's Additions step, on the right department tab, filtered to the active
 * batch's pay week. Nothing on the Issues tab, nothing on the Overview "Needs your
 * decision" tile, no notification — while the manager's chip read "With Accounting"
 * and the employee's card read "Manager approved — with Accounting". Carla
 * (2026-09-15): *"two signatures happen, nothing changes, but HRIS tells us we're
 * waiting on something."*
 *
 * So the rows now render inside the Issues table as a third `IssueRow` kind, the
 * way Bank Preferred change requests were merged on 2026-09-01. Every derivation the
 * table needs lives here as a pure function because this repo's tests are
 * `node --test` over `src/**\/*.test.ts` with no React renderer — logic left inside
 * `PabDisputeQueue.tsx` is untestable by construction.
 *
 * Rules carried over from the wizard panel, unchanged:
 *  - Accounting acts ONLY on `manager_approved` rows. Upstream rows (`pending`,
 *    `awaiting_second_approval`) are shown read-only so a live request is never
 *    invisible, and they do NOT count toward the Pending KPI — the same way a
 *    `pending_orphanage_manager` dispute shows but does not count.
 *  - Approve REQUIRES a day total. `decideTimeAdjustment` treats a null
 *    `approved_hours` as "no override", so an approved row with no hours moves no
 *    money; the button stays disabled until a value is set.
 *  - Segment rows are NEVER prefilled from `requested_hours` — that figure is the
 *    MISSED time to add, not the day total Accounting is asked to set.
 *
 * Doc: `docs/features/time-adjustment-requests.md` § Accounting flow.
 */
import {
  TIME_ADJUSTMENT_REASONS,
  fmtAdjustmentSegments,
  type TimeAdjustmentRow,
  type TimeAdjustmentStatus,
} from '@/lib/supabase/time-adjustments';

/** The Issues tab's status filter — shared by disputes, bank requests and these rows. */
export type IssueStatusFilter = 'all' | 'pending' | 'approved' | 'denied';

export const ALL_TIME_ADJUSTMENT_STATUSES: readonly TimeAdjustmentStatus[] = [
  'pending',
  'awaiting_second_approval',
  'manager_approved',
  'manager_denied',
  'approved',
  'denied',
];

/**
 * Which statuses one Issues filter asks `GET /api/time-adjustments` for.
 *
 * `pending` means "rows Accounting can ACT on" — parity with the disputes fetch,
 * whose Pending filter sends `awaiting_accounting=1`. A row still owed a manager or
 * second-approver signature is not Accounting's pending work and would only pad the
 * queue with rows whose buttons are disabled.
 */
export function timeAdjustmentStatusesForFilter(filter: IssueStatusFilter): TimeAdjustmentStatus[] {
  switch (filter) {
    case 'pending':
      return ['manager_approved'];
    case 'approved':
      return ['approved'];
    case 'denied':
      return ['denied', 'manager_denied'];
    default:
      return [...ALL_TIME_ADJUSTMENT_STATUSES];
  }
}

/** The list URL for one filter. Elevated callers get evidence signed URLs back too. */
export function timeAdjustmentIssuesUrl(filter: IssueStatusFilter): string {
  const params = new URLSearchParams();
  for (const s of timeAdjustmentStatusesForFilter(filter)) params.append('status', s);
  params.set('limit', '500');
  return `/api/time-adjustments?${params.toString()}`;
}

/** Both stage-1 signatures are in; Accounting's move. */
export function timeAdjustmentAwaitsAccounting(row: Pick<TimeAdjustmentRow, 'status'>): boolean {
  return row.status === 'manager_approved';
}

/** Still owed a signature upstream of Accounting — shown, never actionable here. */
export function timeAdjustmentIsUpstream(row: Pick<TimeAdjustmentRow, 'status'>): boolean {
  return row.status === 'pending' || row.status === 'awaiting_second_approval';
}

/** Accounting may delete ONLY denied rows — mirrors `deleteTimeAdjustment`'s server rule. */
export function timeAdjustmentIsDeletable(row: Pick<TimeAdjustmentRow, 'status'>): boolean {
  return row.status === 'denied' || row.status === 'manager_denied';
}

export type TimeAdjustmentIssueCounts = {
  total: number;
  /** Rows Accounting can act on right now — `manager_approved` only. */
  pending: number;
  approved: number;
  /** Accounting's denials AND stage-1 declines: both are a terminal "no". */
  denied: number;
};

/**
 * The KPI contribution of these rows. Fold into the dispute + bank counts; the
 * cards read the FULL dataset, never the filtered slice (Kane 2026-09-01).
 */
export function timeAdjustmentIssueCounts(
  rows: readonly Pick<TimeAdjustmentRow, 'status'>[],
): TimeAdjustmentIssueCounts {
  let pending = 0;
  let approved = 0;
  let denied = 0;
  for (const r of rows) {
    if (r.status === 'manager_approved') pending++;
    else if (r.status === 'approved') approved++;
    else if (r.status === 'denied' || r.status === 'manager_denied') denied++;
  }
  return { total: rows.length, pending, approved, denied };
}

/**
 * Badge copy per status. `manager_approved` reads "Awaiting accounting" so it sits
 * beside `orphanage_manager_approved` disputes as the same kind of row — the one
 * Accounting owes a decision on.
 */
export const TIME_ADJUSTMENT_STATUS_BADGE: Record<TimeAdjustmentStatus, { label: string; className: string }> = {
  pending: {
    label: 'Awaiting manager',
    className: 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-400',
  },
  awaiting_second_approval: {
    label: 'Awaiting second approver',
    className: 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-400',
  },
  manager_approved: {
    label: 'Awaiting accounting',
    className: 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-600 dark:bg-sky-950/40 dark:text-sky-300',
  },
  manager_denied: {
    label: 'Declined in review',
    className: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400',
  },
  approved: {
    label: 'Approved',
    className: 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400',
  },
  denied: {
    label: 'Denied',
    className: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400',
  },
};

export function timeAdjustmentReasonLabel(code: string): string {
  return TIME_ADJUSTMENT_REASONS.find((r) => r.code === code)?.label ?? code;
}

/**
 * Decimal hours → "8h 30m". Unlike the dispute formatter this renders 0 as "0h":
 * an approved time adjustment with `approved_hours = 0` is a deliberate SET to zero,
 * not an absence, and must not print as "—".
 */
export function fmtTimeAdjustmentHours(dec: number | null | undefined): string | null {
  if (dec == null || !Number.isFinite(dec) || dec < 0) return null;
  const totalMin = Math.round(dec * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  if (m) return `${m}m`;
  return '0h';
}

/**
 * What the employee asked for, in one line. Segment rows claim MISSED time to add
 * ("+1h missing · 9:00 AM – 10:00 AM"); legacy rows claimed a day total.
 */
export function timeAdjustmentRequestedLabel(
  row: Pick<TimeAdjustmentRow, 'requested_hours' | 'requested_segments'>,
): string | null {
  const segments = row.requested_segments ?? [];
  const hours = fmtTimeAdjustmentHours(row.requested_hours);
  if (segments.length > 0) {
    const ranges = fmtAdjustmentSegments(segments);
    return hours ? `+${hours} missing · ${ranges}` : ranges;
  }
  return hours ? `requested ${hours}` : null;
}

/**
 * The Approve dialog's starting value. A LEGACY row (no segments) stored a claimed
 * day total, which is a fair starting point; a SEGMENT row stored the missed time,
 * which is the wrong number for a day total — so it starts blank and the clerk
 * types tracked + missed. Same rule as the wizard panel.
 */
export function timeAdjustmentHoursPrefill(
  row: Pick<TimeAdjustmentRow, 'requested_hours' | 'requested_segments'>,
): { hours: string; minutes: string } {
  const blank = { hours: '', minutes: '' };
  if ((row.requested_segments ?? []).length > 0) return blank;
  if (row.requested_hours == null || !Number.isFinite(row.requested_hours) || row.requested_hours < 0) return blank;
  const totalMin = Math.round(row.requested_hours * 60);
  return { hours: String(Math.floor(totalMin / 60)), minutes: String(totalMin % 60) };
}

/**
 * Hour + minute fields → the decimal `approved_hours` to send, or null when the
 * pair does not name a valid day total. Null is what keeps Approve disabled.
 *
 *  - both blank → null (no value, not zero)
 *  - "0" / "0" → 0 (a deliberate zero-out of the day, which the server accepts)
 *  - anything negative, non-numeric, minutes ≥ 60, or a total over 24h → null
 */
export function approvedHoursFromInputs(hours: string, minutes: string): number | null {
  const h = hours.trim();
  const m = minutes.trim();
  if (!h && !m) return null;
  const hh = h ? Number(h) : 0;
  const mm = m ? Number(m) : 0;
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  if (hh < 0 || mm < 0 || mm > 59) return null;
  const total = hh + mm / 60;
  if (total > 24) return null;
  return total;
}

export type TimeAdjustmentApproveCheck = { ok: true } | { ok: false; reason: string };

/**
 * May THIS viewer approve THIS row with THIS value? Every refusal names its reason
 * so the button's tooltip can say why, and the server re-checks all three anyway.
 */
export function canApproveTimeAdjustment(params: {
  row: Pick<TimeAdjustmentRow, 'status'>;
  canApprove: boolean;
  approvedHours: number | null;
}): TimeAdjustmentApproveCheck {
  if (!params.canApprove) return { ok: false, reason: 'Requires accounting, hr_coordinator, or admin' };
  if (!timeAdjustmentAwaitsAccounting(params.row)) {
    return { ok: false, reason: 'Only a request with both stage-1 signatures can be approved' };
  }
  if (params.approvedHours == null) {
    return { ok: false, reason: "Set the employee's final total for this day first" };
  }
  return { ok: true };
}

/** Free-text search surface for one row — what the Issues search box matches. */
export function timeAdjustmentSearchBlob(
  row: Pick<
    TimeAdjustmentRow,
    | 'work_email'
    | 'adjust_date'
    | 'reason'
    | 'explanation'
    | 'decided_by'
    | 'manager_decided_by'
    | 'second_approver_email'
  >,
): string {
  return [
    row.work_email,
    row.adjust_date,
    row.reason,
    timeAdjustmentReasonLabel(row.reason),
    row.explanation ?? '',
    row.decided_by ?? '',
    row.manager_decided_by ?? '',
    row.second_approver_email ?? '',
    'time adjustment',
  ]
    .join(' ')
    .toLowerCase();
}

export type TimeAdjustmentTrailStep = {
  who: string;
  what: string;
  /** ISO timestamp. Null when the record has no date — shown undated, never dated today. */
  when: string | null;
  note: string | null;
};

/**
 * The decision trail for the View modal: who filed, who was named, who signed,
 * what Accounting did. Steps appear in the order they happened; a step with no
 * timestamp keeps its logical slot rather than being invented a date.
 */
export function timeAdjustmentTrail(row: TimeAdjustmentRow): TimeAdjustmentTrailStep[] {
  const steps: TimeAdjustmentTrailStep[] = [];
  steps.push({
    who: row.created_by || row.work_email,
    what: 'submitted the request',
    when: row.created_at ?? null,
    note: null,
  });
  if (row.second_approver_email) {
    steps.push({
      who: row.second_approver_assigned_by || 'Manager',
      what: `named ${row.second_approver_email} as second approver`,
      when: row.second_approver_assigned_at ?? null,
      note: null,
    });
  }
  if (row.manager_decision) {
    steps.push({
      who: row.manager_decided_by || 'Manager',
      what: row.manager_decision === 'approved' ? 'approved as manager' : 'declined as manager',
      when: row.manager_decided_at ?? null,
      note: row.manager_decision_note ?? null,
    });
  }
  if (row.second_decision) {
    steps.push({
      who: row.second_decided_by || row.second_approver_email || 'Second approver',
      what: row.second_decision === 'approved' ? 'countersigned' : 'declined as second approver',
      when: row.second_decided_at ?? null,
      note: row.second_decision_note ?? null,
    });
  }
  if (row.status === 'approved' || row.status === 'denied') {
    const hours = fmtTimeAdjustmentHours(row.approved_hours);
    steps.push({
      who: row.decided_by || 'Accounting',
      what:
        row.status === 'approved'
          ? hours
            ? `approved — day set to ${hours}`
            : 'approved'
          : 'denied',
      when: row.decided_at ?? null,
      note: row.decision_note ?? null,
    });
  }
  // Stable chronological order for dated steps; undated steps keep their slot.
  return steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (!a.s.when || !b.s.when) return a.i - b.i;
      const d = new Date(a.s.when).getTime() - new Date(b.s.when).getTime();
      return d !== 0 ? d : a.i - b.i;
    })
    .map(({ s }) => s);
}
