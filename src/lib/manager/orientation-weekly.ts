/**
 * Weekly orientation attendance — the pure model behind Manager → My Team →
 * New Hire Check List's summary block and its PDF export.
 *
 * Answers one question per week: how many hires showed up for orientation, and
 * how many did not.
 *
 * Two rules carry this file, and both were learned from live data:
 *
 * 1. **The attended STAMP decides, never the status.** A hire "did not attend"
 *    iff `orientation_attended_at` is null. `status` is a sub-label describing
 *    WHY (already offboarded as a no-show vs still waiting on their manager).
 *    Live counter-examples that break any status-based rule: id 1034 carries
 *    `no_show_at` with `status='ready'` (a no-show the manager reverted), and
 *    id 717 carries BOTH `no_show_at` and `orientation_attended_at`. Counting
 *    off the timestamps mis-files both; counting off the attended stamp does not.
 *
 * 2. **The week comes from HR's New Hire Checklist, not from the hire's dates.**
 *    `hr_pending_employees.start_date` is null on 973 of 974 live rows, so a
 *    `start_date ?? created_at` key silently degrades to `created_at` — which is
 *    when HR STAGED the hire, typically the Friday or Saturday BEFORE their
 *    orientation week. Measured 2026-08-24: that mis-files 439 of 954 matched
 *    hires (46%) by exactly one week. The authoritative key is
 *    `hr_new_hire_checklist.period_start`, joined on `personal_email`.
 *
 * Framework-free and I/O-free on purpose: the route pages the two tables, this
 * module decides what the numbers mean, and both the panel and the PDF render
 * the same buckets. See docs/features/manager-orientation-attendance.md.
 */

import { formatWeekLabel, sundayIso } from '@/lib/hr/hiring-week';

/**
 * One staged hire, as `/api/manager/orientation-history` returns it. A subset of
 * `HrPendingEmployeeRow` — deliberately WITHOUT `regular_rate` / `ot_rate`, which
 * the route strips before this ever runs (managers never see pay,
 * docs/features/manager-my-team.md).
 */
export interface OrientationHire {
  id: number;
  name: string | null;
  personal_email: string | null;
  work_email: string | null;
  department: string | null;
  job_description: string | null;
  created_at: string;
  start_date: string | null;
  status: string;
  source: string | null;
  orientation_attended_at: string | null;
  orientation_attended_by: string | null;
  orientation_note: string | null;
  no_show_at: string | null;
  no_show_by: string | null;
  no_show_note: string | null;
}

/** One week's tally. `hires` carries the same rows the counts were derived from. */
export interface OrientationWeek {
  /** Sun-anchored `YYYY-MM-DD`. HR's `period_start` when `onChecklist`. */
  weekStart: string;
  /** "Aug 16 – Aug 22, 2026". */
  label: string;
  /**
   * True when this bucket IS an HR checklist week. False marks the fallback
   * bucket for hires that match no checklist row — they keep their own derived
   * week so nobody vanishes, but they are never folded into a real HR week.
   */
  onChecklist: boolean;
  total: number;
  attended: number;
  /** total − attended. The headline "did not show up" number. */
  notAttended: number;
  /** Of `notAttended`: already offboarded as a no-show. */
  noShow: number;
  /** Of `notAttended`: nobody has marked them either way yet. */
  stillOpen: number;
  hires: OrientationHire[];
}

export interface OrientationSummary {
  /** HR checklist weeks, newest first. */
  weeks: OrientationWeek[];
  /** Fallback buckets (no checklist row), newest first. Usually tiny. */
  offChecklist: OrientationWeek[];
  totals: {
    total: number;
    attended: number;
    notAttended: number;
    noShow: number;
    stillOpen: number;
    /** How many hires could not be tied to an HR checklist week. */
    unmatched: number;
  };
}

export interface BuildOrientationInput {
  hires: OrientationHire[];
  /**
   * `personal_email` (lower-cased, trimmed) → every `period_start` that email
   * appears under in `hr_new_hire_checklist`. An email legitimately appears in
   * more than one week (a re-list / re-hire): 52 emails do, and none twice in
   * the same week, so {@link pickChecklistWeek} can resolve it deterministically.
   */
  checklistWeeksByEmail: Map<string, string[]>;
}

export function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * The Sun-anchored week key for an ISO date/timestamp, or null when it can't be
 * parsed. Mirrors the panel's old `batchKeyOf` parsing so a fallback bucket lines
 * up with the weeks HR uses.
 */
export function weekKeyFromIso(raw: string | null | undefined): string | null {
  const isoOnly = raw && raw.length >= 10 ? raw.slice(0, 10) : raw;
  const [y, m, d] = (isoOnly ?? '').split('-').map(Number);
  if (!y || !m || !d) return null;
  const anchor = new Date(y, m - 1, d);
  if (Number.isNaN(anchor.getTime())) return null;
  return sundayIso(anchor);
}

/**
 * Which checklist week a hire belongs to.
 *
 * One candidate wins outright. When an email appears under several weeks, the
 * hire belongs to the `period_start` NEAREST the week HR staged them, preferring
 * a week at-or-after that anchor — HR lists a hire shortly before the week they
 * orient, so the upcoming week is the right read; a tie resolves to the LATER
 * week, because a re-list supersedes the row it repeats.
 *
 * Returns null when the email is on no checklist row at all. Callers must fall
 * back to a labelled bucket rather than guessing — a name-matching tier was
 * measured and recovered nothing, and memory/hsl-gml-roster-merged records that
 * the plain-name bridge was dropped for exactly this reason.
 */
export function pickChecklistWeek(
  email: string | null | undefined,
  createdAt: string,
  weeksByEmail: Map<string, string[]>,
): string | null {
  const key = normEmail(email);
  if (!key) return null;
  const weeks = (weeksByEmail.get(key) ?? []).filter(Boolean);
  if (weeks.length === 0) return null;
  if (weeks.length === 1) return weeks[0]!;

  const anchor = weekKeyFromIso(createdAt);
  // No usable anchor: fall back to the latest week the email appears under,
  // which is the most recent claim about that person.
  if (!anchor) return [...weeks].sort()[weeks.length - 1]!;

  const anchorMs = Date.parse(anchor);
  const scored = weeks.map((w) => {
    const days = (Date.parse(w) - anchorMs) / 86_400_000;
    return { week: w, ahead: days >= 0, dist: Math.abs(days) };
  });
  scored.sort((a, b) => {
    if (a.ahead !== b.ahead) return a.ahead ? -1 : 1; // at-or-after wins
    if (a.dist !== b.dist) return a.dist - b.dist; // then nearest
    return a.week < b.week ? 1 : -1; // then the later week
  });
  return scored[0]!.week;
}

/** A hire attended iff the stamp is set. See rule 1 in the file header. */
export function hasAttended(h: OrientationHire): boolean {
  return Boolean(h.orientation_attended_at);
}

function emptyWeek(weekStart: string, onChecklist: boolean): OrientationWeek {
  return {
    weekStart,
    label: formatWeekLabel(weekStart),
    onChecklist,
    total: 0,
    attended: 0,
    notAttended: 0,
    noShow: 0,
    stillOpen: 0,
    hires: [],
  };
}

/** Newest week first. */
function byWeekDesc(a: OrientationWeek, b: OrientationWeek): number {
  return a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0;
}

/**
 * Bucket every hire into its HR checklist week and tally attendance.
 *
 * A hire with no checklist match and no parsable `created_at` still lands in a
 * bucket (`UNDATED`) rather than being dropped — this is a headcount report, so
 * a row that cannot be placed must still be COUNTED and visibly labelled.
 */
export const UNDATED_WEEK = 'undated';

export function buildOrientationWeeks(input: BuildOrientationInput): OrientationSummary {
  const onCk = new Map<string, OrientationWeek>();
  const offCk = new Map<string, OrientationWeek>();
  let unmatched = 0;

  for (const h of input.hires) {
    const hrWeek = pickChecklistWeek(h.personal_email, h.created_at, input.checklistWeeksByEmail);
    const onChecklist = hrWeek != null;
    if (!onChecklist) unmatched += 1;

    const weekStart = hrWeek ?? weekKeyFromIso(h.created_at) ?? UNDATED_WEEK;
    const target = onChecklist ? onCk : offCk;
    let bucket = target.get(weekStart);
    if (!bucket) {
      bucket = emptyWeek(weekStart, onChecklist);
      target.set(weekStart, bucket);
    }

    bucket.hires.push(h);
    bucket.total += 1;
    if (hasAttended(h)) {
      bucket.attended += 1;
    } else {
      bucket.notAttended += 1;
      if (h.status === 'no_show') bucket.noShow += 1;
      else bucket.stillOpen += 1;
    }
  }

  const weeks = [...onCk.values()].sort(byWeekDesc);
  const offChecklist = [...offCk.values()].sort(byWeekDesc);

  const totals = [...weeks, ...offChecklist].reduce(
    (acc, w) => ({
      total: acc.total + w.total,
      attended: acc.attended + w.attended,
      notAttended: acc.notAttended + w.notAttended,
      noShow: acc.noShow + w.noShow,
      stillOpen: acc.stillOpen + w.stillOpen,
      unmatched: acc.unmatched,
    }),
    { total: 0, attended: 0, notAttended: 0, noShow: 0, stillOpen: 0, unmatched },
  );

  return { weeks, offChecklist, totals };
}

/**
 * Attendance rate as a whole percent, or null when the week is empty. Kept here
 * so the panel and the PDF can never disagree on the denominator: it is
 * `attended / total`, i.e. an unmarked hire counts AGAINST the week, matching
 * Kane's ruling that "did not attend" means "was not marked attended".
 */
export function attendanceRate(w: Pick<OrientationWeek, 'total' | 'attended'>): number | null {
  if (w.total <= 0) return null;
  return Math.round((w.attended / w.total) * 100);
}

/** Label for the fallback group — used by the panel and the PDF alike. */
export const OFF_CHECKLIST_LABEL = "Not on HR's checklist";
