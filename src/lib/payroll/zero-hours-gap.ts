/**
 * Why does an ACTIVE roster member have no Hubstaff hours this week?
 *
 * One rule, three consumers — the Accounting Overview "Hubstaff ↔ Master
 * matches" tile (and its CEO mirror), the Payroll Readiness pane's "No hours
 * this week" section, and the `payroll.hours_gap` notification fired on ingest.
 * They must never be able to disagree: a person the tile calls an expected
 * absence and the email calls a gap is worse than either answer alone.
 *
 * This module was extracted from `Overview.tsx`'s `classifyNoHours` and is
 * BEHAVIOR-IDENTICAL to it on purpose (see the date note on
 * `classifyZeroHours`). It is framework-free and does no I/O so all three
 * callers can share it and it can be unit-tested against measured live numbers.
 *
 * ## What it is for (Kane, 2026-08-21)
 *
 * "This is just to remind accounting if they are still active or on leave or
 * Sick." It is a RECONCILIATION PROMPT, not an accusation and not a payroll
 * gate. A `gap` verdict means *nothing in the HRIS explains the silence, go
 * ask* — which is exactly the signal that was already available and unread when
 * `jvincec@simple.biz` sat Active with zero hours from 2026-08-05 onward while
 * nobody had offboarded him.
 *
 * Consequently:
 * - **Approved Vacation leave is a legitimate zero-hours week** (Kane's Q2), so
 *   it resolves to an exception, never a gap.
 * - **One zero week is enough to flag** (Q3). There is deliberately no
 *   consecutive-week rule and no history lookup — a taper into silence
 *   (39h → 33h → 9h → 0h, which is what actually happened) must surface on the
 *   first zero week, not the second.
 * - **Lead Gen is tracked** (Q1) — it is not in the exempt set, so ~168 Lead Gen
 *   people land in the list every week by design. That is what makes the list a
 *   ~190-row reminder rather than a ~28-row alarm, and it is why the Readiness
 *   dimension built on this is LISTED BUT NOT SCORED.
 */

import { isHubstaffExemptDept, HUBSTAFF_LEAVE_STATUS } from '@/lib/payroll/hubstaff-reconciliation';

/** A leave request as the reconciliation needs it: who, the window, the kind,
 *  and the approval state. Statuses other than `approved` excuse NOTHING — a
 *  still-pending request leaves the person flagged until HR acts on it, which is
 *  the whole point of surfacing it to a human. */
export interface ZeroHoursLeave {
  email: string;
  start: string;
  end: string;
  type: string;
  status: string;
}

/** The pay week under reconciliation, or null for an "All Time" scope where
 *  there is no window to compare a leave or a start date against. */
export interface ZeroHoursPeriod {
  startISO: string;
  endISO: string;
}

export interface ZeroHoursVerdict {
  /** Human sentence naming the reason — rendered verbatim in the tile, the pane
   *  and the CSV, so it is written as prose, not a code. */
  reason: string;
  /** true = the absence is EXPECTED and is not a reconciliation gap. */
  exception: boolean;
  /** Set only when the exception is an approved leave, so the modal can offer a
   *  dedicated "On Leave" filter. */
  status?: string;
}

/** Index leave rows by normalized email so a person's leaves are one lookup.
 *  Rows with no email are dropped — an unattributable leave excuses nobody. */
export function buildLeaveIndex(
  leaves: readonly ZeroHoursLeave[],
  normalize: (email: string) => string,
): Map<string, ZeroHoursLeave[]> {
  const byEmail = new Map<string, ZeroHoursLeave[]>();
  for (const lv of leaves) {
    const key = normalize(lv.email);
    if (!key) continue;
    const arr = byEmail.get(key);
    if (arr) arr.push(lv);
    else byEmail.set(key, [lv]);
  }
  return byEmail;
}

const prettyLeaveType = (t: string) => (t.trim() ? t.trim() : 'Leave');

/**
 * Classify one no-hours active roster member.
 *
 * Priority is load-bearing and must not be reordered: **no-Hubstaff department →
 * approved leave → onboarding timing → unexplained gap.** A freelance-dept
 * person who also filed leave is reported as the dept exemption because that is
 * the durable reason; a leave that has already ended is not allowed to excuse a
 * later silence.
 *
 * `todayISO` is injected rather than read from the clock so the All-Time branch
 * is deterministic under test.
 *
 * **Date-comparison note (inherited, deliberately unchanged).** The onboarding
 * branch parses the master `Start Date` with `new Date(...)`, which reads
 * `"03/09/26"` as LOCAL midnight while `new Date("2026-08-09")` (the period
 * bound) is UTC midnight. On a machine behind UTC that skews a boundary-day hire
 * by up to a day. This was ported verbatim from the shipped tile so extracting
 * the rule could not silently re-classify anyone; a test pins the current
 * boundary behavior. Changing it is a separate, deliberate call.
 */
export function classifyZeroHours(input: {
  department: string | null | undefined;
  /** The master-list `Start Date`, in whatever format the sheet carries. */
  startDate: string | null | undefined;
  /** Every normalized email this person answers to (work / personal / alias). */
  emails: readonly string[];
  leavesByEmail: Map<string, ZeroHoursLeave[]>;
  period: ZeroHoursPeriod | null;
  /** `YYYY-MM-DD` for "today", used only by the All-Time branch. */
  todayISO: string;
}): ZeroHoursVerdict {
  const { department, startDate, emails, leavesByEmail, period, todayISO } = input;

  // 0) The department has no Hubstaff by nature (billed by deliverable, or
  //    salaried US staff). Not a gap — expected.
  if (isHubstaffExemptDept(department)) {
    return {
      reason: `${department ?? 'This team'} — no Hubstaff tracking by nature`,
      exception: true,
    };
  }

  // 1) An APPROVED leave that has not already ended before this period began.
  //    `end >= startISO` deliberately admits an UPCOMING leave too, so a leave
  //    filed for next week still explains the week we are reconciling now.
  //    Pending / rejected / cancelled requests excuse nothing.
  const mine: ZeroHoursLeave[] = [];
  for (const key of new Set(emails.filter(Boolean))) {
    const arr = leavesByEmail.get(key);
    if (arr) mine.push(...arr);
  }
  if (mine.length) {
    const boundary = period ? period.startISO : todayISO;
    const pick = mine
      .filter((lv) => lv.status === 'approved')
      .filter((lv) => lv.end >= boundary)
      .sort((a, b) => a.start.localeCompare(b.start))[0];
    if (pick) {
      let phrase: string;
      if (period) {
        if (pick.start > period.endISO) {
          phrase = 'Upcoming approved leave';
        } else {
          const whole = pick.start <= period.startISO && pick.end >= period.endISO;
          phrase = whole
            ? 'On approved leave the entire period'
            : 'On approved leave part of the period';
        }
      } else {
        phrase = pick.start > todayISO ? 'Upcoming approved leave' : 'Currently on approved leave';
      }
      return {
        reason: `${phrase} — ${prettyLeaveType(pick.type)} ${pick.start}→${pick.end}`,
        exception: true,
        status: HUBSTAFF_LEAVE_STATUS,
      };
    }
  }

  // 2) Onboarding timing — hired in or after the week means they had not started
  //    (or only just started) logging hours.
  const startMs = startDate ? new Date(startDate.trim()).getTime() : NaN;
  if (Number.isFinite(startMs)) {
    const startShown = new Date(startMs).toISOString().slice(0, 10);
    if (period) {
      const pStart = new Date(period.startISO).getTime();
      const pEnd = new Date(period.endISO).getTime();
      if (startMs > pEnd) {
        return { reason: `Not started yet — hired ${startShown}, after this period`, exception: true };
      }
      if (startMs >= pStart) {
        return { reason: `Newly onboarded — started ${startShown}, mid-period`, exception: true };
      }
    } else {
      const nowMs = new Date(todayISO).getTime();
      if (startMs > nowMs) return { reason: `Not started yet — hired ${startShown}`, exception: true };
      if (nowMs - startMs <= 30 * 24 * 3600 * 1000) {
        return { reason: `Recently onboarded — started ${startShown}`, exception: true };
      }
    }
  }

  // 3) Nothing in the HRIS explains it. THIS is the row Accounting must act on:
  //    still employed? on unfiled leave? sick? or never actually offboarded?
  return {
    reason: period
      ? 'No hours logged — reason unknown (check Hubstaff upload / time off)'
      : 'No hours on record — reason unknown',
    exception: false,
  };
}

/** A fully-described gap row, as the Overview tile and the CSV build them. */
export interface ZeroHoursGapRow {
  name: string;
  email: string | null;
  department: string | null;
  reason: string;
}

/**
 * Fold gap rows into the digest the notification carries: a count plus the
 * departments driving it. The email names DEPARTMENTS, never ~190 people — a
 * notification nobody can read is the same as no notification, which is the
 * failure this whole feature exists to correct.
 *
 * Takes only the field it reads, so both row shapes work: the tile's fully
 * described `ZeroHoursGapRow` and Readiness' leaner `ReadinessZeroHours`. A
 * summariser that demanded a `reason` it never uses would force one of the two
 * callers to invent one.
 */
export function summarizeZeroHoursGaps(
  rows: readonly { department: string | null }[],
  topN = 3,
): { total: number; byDepartment: Array<{ department: string; count: number }> } {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = (r.department ?? '').trim() || 'No department';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byDepartment = [...counts.entries()]
    .map(([department, count]) => ({ department, count }))
    // Count desc, then department name so the digest is stable across runs.
    .sort((a, b) => b.count - a.count || a.department.localeCompare(b.department))
    .slice(0, Math.max(0, topN));
  return { total: rows.length, byDepartment };
}

/** One-line human digest for the notification body. */
export function zeroHoursDigestLine(
  summary: { total: number; byDepartment: Array<{ department: string; count: number }> },
): string {
  if (summary.total === 0) return 'Everyone on the roster logged hours this week.';
  const head = `${summary.total} ${summary.total === 1 ? 'person has' : 'people have'} no Hubstaff hours this week`;
  if (summary.byDepartment.length === 0) return `${head}.`;
  const parts = summary.byDepartment.map((d) => `${d.department} (${d.count})`);
  return `${head} — mostly ${parts.join(', ')}.`;
}
