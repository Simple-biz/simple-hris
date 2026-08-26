/**
 * One HR New Hire Checklist week, measured against orientation attendance.
 *
 * The model behind HR → New Hire Checklist → **Orientation**. The manager tally
 * (`src/lib/manager/orientation-weekly.ts`) already answers "how many showed up"
 * across every week; this module narrows that to the ONE week HR's selector is
 * on, and adds the number only HR can see — how many hires HR *listed* for the
 * week, versus how many of them ever reached `hr_pending_employees` where a
 * manager could mark them at all.
 *
 * Three rules carry this file, all three measured on live data 2026-08-26:
 *
 * 1. **"Listed" and "staged" are different numbers, and the rate uses staged.**
 *    2026-08-23 listed 79 hires, staged 70, attended 66. The ~9/week difference
 *    is people on HR's checklist with no `hr_pending_employees` row at all — no
 *    row means no `orientation_attended_at` can ever exist for them, so a rate
 *    over "listed" would never reach 100% and would read as an attendance
 *    problem when it is an intake problem. They get their own count
 *    ({@link HrOrientationWeekStats.notStaged}) instead of being buried in a
 *    denominator.
 *
 * 2. **The rate is `attendanceRate` itself — imported, never re-derived.** It is
 *    `attended / total`, so a hire nobody marked counts AGAINST the week. That is
 *    the manager tally's published number
 *    (docs/features/manager-orientation-attendance.md); HR showing a different
 *    percentage for the same week is the one failure this surface must not have.
 *
 * 3. **A week with nothing staged is not a 0% week — it is unmeasurable.** Every
 *    week before 2026-06-07 has checklist rows and no staged hires (2026-05-03:
 *    52 listed, 0 staged), and a freshly-listed current week looks identical.
 *    {@link HrOrientationWeekStats.measurable} is false there and the panel owes
 *    a note, not a percentage — Kane, 2026-08-26: *"only produce data when it has
 *    been passed to the managers and the managers have marked it; if it hasn't
 *    been marked then just put a note on it."*
 *
 * I/O-free and framework-free: the route pages the two tables, the shared model
 * buckets the hires into HR's weeks, and this decides what one week means.
 */

import {
  attendanceRate,
  hasAttended,
  normEmail,
  type OrientationHire,
  type OrientationSummary,
  type OrientationWeek,
} from '@/lib/manager/orientation-weekly';

/**
 * A row of HR's checklist grid for the selected week — the "hired" side of the
 * comparison. This is deliberately the shape the tab already holds in state, so
 * the Orientation tab's "Listed" count and the grid's own hire count are the
 * same number by construction and cannot drift.
 */
export interface HrChecklistListedRow {
  id: string;
  name: string | null;
  personal_email: string | null;
  department: string | null;
}

/** One department's slice of a week. `department` is the RAW stored value —
 *  callers label it with `formatDeptLabel` at render time. */
export interface HrOrientationDeptRow {
  department: string | null;
  listed: number;
  staged: number;
  attended: number;
  notAttended: number;
}

export interface HrOrientationWeekStats {
  weekStart: string;
  /** HR checklist rows for the week. The number HR owns. */
  listed: number;
  /** Of `listed`: reached `hr_pending_employees` and landed in THIS week. */
  listedStagedHere: number;
  /**
   * Of `listed`: reached `hr_pending_employees` but bucketed into a DIFFERENT
   * week (a re-list resolves to the later week — `pickChecklistWeek`). Counted
   * separately so they are never reported as missing intake.
   */
  listedStagedElsewhere: number;
  /** Listed rows with no staged hire anywhere. Nobody can mark these. */
  notStaged: HrChecklistListedRow[];
  /** Staged hires bucketed into this week — the rate's denominator. */
  staged: number;
  attended: number;
  notAttended: number;
  /** Of `notAttended`: already offboarded as a no-show. */
  noShow: number;
  /** Of `notAttended`: staged, but no manager ever marked them either way. */
  awaiting: number;
  /** `attended / staged` as a whole percent, or null when unmeasurable. */
  rate: number | null;
  /** False when no staged hire exists: render the note, never a percentage. */
  measurable: boolean;
  byDepartment: HrOrientationDeptRow[];
  /** The staged hires this week's counts came from, did-not-attend first. */
  hires: OrientationHire[];
}

export interface HrOrientationWeekInput {
  /** Sun-anchored `YYYY-MM-DD` — HR's `period_start`, straight from the selector. */
  weekStart: string;
  /** The selected week's checklist rows, as the grid holds them. */
  listedRows: HrChecklistListedRow[];
  /** The selected week's bucket from the shared model, or null when it has none. */
  week: OrientationWeek | null;
  /** Every staged hire's personal email → the week the shared model filed them under. */
  stagedWeekByEmail: Map<string, string>;
}

/**
 * `personal_email` → the week the shared model bucketed that staged hire into.
 *
 * Built from the WHOLE summary (checklist weeks *and* the off-checklist
 * fallbacks) so a listed hire who was staged is never reported as "not staged"
 * merely because the model filed them elsewhere.
 */
export function buildStagedWeekIndex(summary: OrientationSummary): Map<string, string> {
  const index = new Map<string, string>();
  for (const w of [...summary.weeks, ...summary.offChecklist]) {
    for (const h of w.hires) {
      const e = normEmail(h.personal_email);
      if (e) index.set(e, w.weekStart);
    }
  }
  return index;
}

function deptKey(raw: string | null | undefined): string {
  return (raw ?? '').trim();
}

/** Did-not-attend first: HR is here for the exceptions, not the roll call. */
function byAttendanceThenName(a: OrientationHire, b: OrientationHire): number {
  const aAtt = hasAttended(a);
  const bAtt = hasAttended(b);
  if (aAtt !== bAtt) return aAtt ? 1 : -1;
  return (a.name ?? '').localeCompare(b.name ?? '');
}

/**
 * Measure one HR checklist week.
 *
 * Never throws and never invents a number: a week with no staged hires comes
 * back `measurable: false` with its `listed` count intact, which is exactly the
 * state the panel turns into a note.
 */
export function buildHrOrientationWeekStats(
  input: HrOrientationWeekInput,
): HrOrientationWeekStats {
  const { weekStart, listedRows, week, stagedWeekByEmail } = input;

  const notStaged: HrChecklistListedRow[] = [];
  let listedStagedHere = 0;
  let listedStagedElsewhere = 0;

  for (const row of listedRows) {
    const email = normEmail(row.personal_email);
    const landed = email ? stagedWeekByEmail.get(email) : undefined;
    if (!landed) {
      // No staged row anywhere — including a listed row with a blank email,
      // which cannot be joined at all and so cannot be marked either.
      notStaged.push(row);
    } else if (landed === weekStart) {
      listedStagedHere += 1;
    } else {
      listedStagedElsewhere += 1;
    }
  }

  const hires = week ? [...week.hires].sort(byAttendanceThenName) : [];
  const staged = week?.total ?? 0;

  // Departments come from BOTH sides: a dept that listed hires but staged none
  // still owes HR a row, otherwise the intake gap vanishes from the breakdown.
  const deptMap = new Map<string, HrOrientationDeptRow>();
  const deptRow = (raw: string | null | undefined): HrOrientationDeptRow => {
    const key = deptKey(raw);
    let row = deptMap.get(key);
    if (!row) {
      row = { department: key || null, listed: 0, staged: 0, attended: 0, notAttended: 0 };
      deptMap.set(key, row);
    }
    return row;
  };
  for (const row of listedRows) deptRow(row.department).listed += 1;
  for (const h of hires) {
    const row = deptRow(h.department);
    row.staged += 1;
    if (hasAttended(h)) row.attended += 1;
    else row.notAttended += 1;
  }
  const byDepartment = [...deptMap.values()].sort(
    (a, b) =>
      b.notAttended - a.notAttended ||
      b.staged - a.staged ||
      b.listed - a.listed ||
      (a.department ?? '').localeCompare(b.department ?? ''),
  );

  return {
    weekStart,
    listed: listedRows.length,
    listedStagedHere,
    listedStagedElsewhere,
    notStaged,
    staged,
    attended: week?.attended ?? 0,
    notAttended: week?.notAttended ?? 0,
    noShow: week?.noShow ?? 0,
    awaiting: week?.stillOpen ?? 0,
    // Imported, not re-derived: HR and the manager tally publish one rate.
    rate: week ? attendanceRate(week) : null,
    measurable: staged > 0,
    byDepartment,
    hires,
  };
}

/**
 * The nearest earlier checklist week that actually has staged hires, for the
 * week-over-week delta. Skips unmeasurable weeks rather than comparing against a
 * week that was never marked — a delta against nothing is not a delta.
 */
export function previousMeasuredWeek(
  summary: OrientationSummary,
  weekStart: string,
): OrientationWeek | null {
  const earlier = summary.weeks
    .filter((w) => w.weekStart < weekStart && w.total > 0)
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
  return earlier[0] ?? null;
}
