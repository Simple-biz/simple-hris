/**
 * HR pipeline performance — what fraction of the people HR listed for a hiring
 * week made it all the way to the Global Master List, per week and per month.
 *
 * ── The funnel ─────────────────────────────────────────────────────────────
 *
 *   listed     `hr_new_hire_checklist` rows for the week — the number HR owns
 *      ↓
 *   staged     of those, reached `hr_pending_employees`
 *      ↓
 *   submitted  of staged, has an `onboarding_submission_id`
 *      ↓
 *   attended   of staged, carries `orientation_attended_at`
 *      ↓
 *   promoted   of staged, carries `promoted_at` — on the master list
 *
 * **The headline rate is `promoted / staged`** (Kane, 2026-09-04). The other
 * legs are shown, but only one number is the score.
 *
 * ── Three rules inherited, not re-invented ─────────────────────────────────
 *
 * 1. **The week is `hr_new_hire_checklist.period_start`, joined on
 *    personal_email** — never the hire's own dates. A pending row has no link
 *    back to the checklist and its `start_date` is null on essentially every
 *    live row, so `start_date ?? created_at` filed 46% of hires one week early
 *    (see `docs/features/manager-orientation-attendance.md`). This module calls
 *    {@link pickChecklistWeek} — the SAME resolver the Manager and HR surfaces
 *    use — so all three agree on which week a hire belongs to.
 *
 * 2. **"Listed" and "staged" are different numbers, and every rate is over
 *    STAGED.** A listed hire with no pending row can never carry an attended or
 *    promoted stamp, so a rate over `listed` could never reach 100% and would
 *    read as a pipeline failure when it is an intake gap. `notStaged` gets its
 *    own count instead of being buried in a denominator — the rule from
 *    `src/lib/hr/orientation-week-stats.ts`.
 *
 * 3. **A week with nothing staged is UNMEASURABLE, not 0%.** It gets a note,
 *    not a percentage (Kane, 2026-08-26). Every checklist week before
 *    2026-06-07 looks like this, and so does a freshly-listed current week.
 *
 * ── What decays, and why the surface must say so ───────────────────────────
 * `hr_pending_employees` rows are removed by scheduled deletion when someone is
 * offboarded, so an OLD week's `staged` count shrinks over time and its rate
 * moves. This is a live read, not a frozen record — unlike the payroll tab,
 * whose close-outs are frozen declarations. The route stamps `generatedAt` and
 * the UI says it out loud.
 *
 * I/O-free and framework-free: the route pages the tables, this decides what
 * the numbers mean.
 */

import {
  normEmail,
  pickChecklistWeek,
  weekKeyFromIso,
  UNDATED_WEEK,
} from '@/lib/manager/orientation-weekly';
import { monthKeyOf, monthLabel } from '@/lib/admin/cycle-performance';

/**
 * The slice of `hr_pending_employees` this module needs. Deliberately narrower
 * than `HrPendingEmployeeRow`: no rates, no notes, no names beyond what the
 * week join needs, because this feeds an admin metrics payload that carries no
 * PII downstream.
 */
export interface HrPipelinePendingRow {
  personal_email: string | null;
  created_at: string;
  status: string | null;
  onboarding_submission_id: string | null;
  orientation_attended_at: string | null;
  no_show_at: string | null;
  promoted_at: string | null;
}

/** `period_start` → how many checklist rows HR filed under it. */
export type ChecklistWeekCounts = ReadonlyMap<string, number>;

export interface HrPipelineWeekRow {
  /** Sun-anchored `YYYY-MM-DD` — HR's `period_start`. */
  weekStart: string;
  /** "Aug 16 – Aug 22, 2026". */
  label: string;
  /** `YYYY-MM` from `weekStart`. */
  month: string | null;
  /**
   * True when this bucket is a real HR checklist week. False marks the
   * off-checklist bucket — staged hires matching no checklist row. They are
   * COUNTED and labelled, never folded into a real week and never dropped.
   */
  onChecklist: boolean;

  /** Checklist rows HR filed for the week. Shown, never a denominator. */
  listed: number;
  /** Of `listed`: reached `hr_pending_employees` and landed in THIS week. */
  staged: number;
  /** `listed - staged`, floored at 0. The intake gap. */
  notStaged: number;
  /** Of `staged`: has an onboarding submission. */
  submitted: number;
  /** Of `staged`: carries `orientation_attended_at` — the stamp, not the status. */
  attended: number;
  /** Of `staged`: carries `promoted_at`. The success line. */
  promoted: number;
  /** Of `staged`: not promoted and carries `no_show_at`. */
  noShow: number;
  /** Of `staged`: not promoted, not a no-show — still moving, or stalled. */
  stillOpen: number;

  /** `promoted / staged`, 0–1. THE headline. Null when nothing is staged. */
  rate: number | null;
  /** False when `staged` is 0 — a note, never a percentage. */
  measurable: boolean;
}

export interface HrPipelineMonthRow {
  month: string;
  label: string;
  weeks: number;
  listed: number;
  staged: number;
  submitted: number;
  attended: number;
  promoted: number;
  /** Pooled `promoted / staged` — never a mean of the weekly rates. */
  rate: number | null;
  measurable: boolean;
  worstWeekRate: number | null;
  worstWeekLabel: string | null;
}

export interface HrPipelineSummary {
  weeks: HrPipelineWeekRow[];
  months: HrPipelineMonthRow[];
  totals: {
    measuredWeeks: number;
    unmeasurableWeeks: number;
    listed: number;
    staged: number;
    notStaged: number;
    submitted: number;
    attended: number;
    promoted: number;
    noShow: number;
    stillOpen: number;
    /** Pooled all-time `promoted / staged`. */
    rate: number | null;
    /** Staged hires that matched no checklist week at all. */
    offChecklist: number;
    firstWeek: string | null;
    lastWeek: string | null;
  };
}

export interface BuildHrPipelineInput {
  pending: readonly HrPipelinePendingRow[];
  /** email → every `period_start` it appears under. From `listChecklistWeeksByEmail`. */
  checklistWeeksByEmail: ReadonlyMap<string, string[]>;
  /** `period_start` → listed count. From `listChecklistWeekCounts`. */
  checklistWeekCounts: ChecklistWeekCounts;
}

/** "2026-08-16" → "Aug 16 – Aug 22, 2026". Echoes the key back if unparsable. */
export function formatWeekLabel(weekStart: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStart);
  if (!m) return weekStart;
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(start.getTime())) return weekStart;
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const fmt = (d: Date) =>
    `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}`;
  return `${fmt(start)} – ${fmt(end)}, ${end.getUTCFullYear()}`;
}

function emptyWeek(weekStart: string, onChecklist: boolean): HrPipelineWeekRow {
  return {
    weekStart,
    label: onChecklist ? formatWeekLabel(weekStart) : "Not on HR's checklist",
    month: onChecklist ? monthKeyOf(weekStart) : null,
    onChecklist,
    listed: 0,
    staged: 0,
    notStaged: 0,
    submitted: 0,
    attended: 0,
    promoted: 0,
    noShow: 0,
    stillOpen: 0,
    rate: null,
    measurable: false,
  };
}

/**
 * Bucket every staged hire into its HR checklist week and measure the funnel.
 *
 * A staged hire that matches no checklist row lands in the OFF_CHECKLIST bucket
 * keyed by its own `created_at` week rather than being dropped — this is a
 * headcount report, and an unplaceable row must still be counted and visibly
 * labelled. It never enters a real week's numbers.
 */
export function buildHrPipeline(input: BuildHrPipelineInput): HrPipelineSummary {
  const { pending, checklistWeeksByEmail, checklistWeekCounts } = input;

  // Seed a row for every week HR listed, even one with nothing staged — an
  // empty week is a fact about intake, not an absence of data.
  const weeks = new Map<string, HrPipelineWeekRow>();
  for (const [weekStart, listed] of checklistWeekCounts) {
    const key = (weekStart ?? '').trim();
    if (!key) continue;
    const row = emptyWeek(key, true);
    row.listed = Number.isFinite(listed) && listed > 0 ? Math.floor(listed) : 0;
    weeks.set(key, row);
  }

  const offChecklist = new Map<string, HrPipelineWeekRow>();
  let offChecklistTotal = 0;

  for (const p of pending) {
    const email = normEmail(p.personal_email);
    const week = pickChecklistWeek(email, p.created_at, asMutableMap(checklistWeeksByEmail));

    let row: HrPipelineWeekRow;
    if (week) {
      row = weeks.get(week) ?? emptyWeek(week, true);
      weeks.set(week, row);
    } else {
      // No checklist match: its own bucket, never folded into a real week.
      const fallback = weekKeyFromIso(p.created_at) ?? UNDATED_WEEK;
      row = offChecklist.get(fallback) ?? emptyWeek(fallback, false);
      offChecklist.set(fallback, row);
      offChecklistTotal += 1;
    }

    row.staged += 1;
    if (p.onboarding_submission_id) row.submitted += 1;
    // Attendance is the STAMP, never `status` — prod carries rows where the two
    // disagree in both directions.
    if (p.orientation_attended_at) row.attended += 1;
    if (p.promoted_at) row.promoted += 1;
    else if (p.no_show_at) row.noShow += 1;
    else row.stillOpen += 1;
  }

  const finish = (row: HrPipelineWeekRow): HrPipelineWeekRow => {
    row.notStaged = Math.max(0, row.listed - row.staged);
    row.measurable = row.staged > 0;
    row.rate = row.measurable ? row.promoted / row.staged : null;
    return row;
  };

  const weekRows = [...weeks.values()].map(finish).sort(byWeekDesc);
  const offRows = [...offChecklist.values()].map(finish).sort(byWeekDesc);
  const allRows = [...weekRows, ...offRows];

  // Months roll up ON-CHECKLIST weeks only — an off-checklist bucket's week is
  // derived from `created_at`, which is exactly the key that filed 46% of hires
  // in the wrong week. It is reported as its own total instead.
  const byMonth = new Map<string, HrPipelineWeekRow[]>();
  for (const w of weekRows) {
    if (!w.month) continue;
    const bucket = byMonth.get(w.month);
    if (bucket) bucket.push(w);
    else byMonth.set(w.month, [w]);
  }

  const months: HrPipelineMonthRow[] = [...byMonth.entries()]
    .map(([month, rows]) => {
      let listed = 0;
      let staged = 0;
      let submitted = 0;
      let attended = 0;
      let promoted = 0;
      let worstWeekRate: number | null = null;
      let worstWeekLabel: string | null = null;
      for (const r of rows) {
        listed += r.listed;
        staged += r.staged;
        submitted += r.submitted;
        attended += r.attended;
        promoted += r.promoted;
        if (r.rate === null) continue;
        if (worstWeekRate === null || r.rate < worstWeekRate) {
          worstWeekRate = r.rate;
          worstWeekLabel = r.label;
        }
      }
      return {
        month,
        label: monthLabel(month),
        weeks: rows.length,
        listed,
        staged,
        submitted,
        attended,
        promoted,
        rate: staged > 0 ? promoted / staged : null,
        measurable: staged > 0,
        worstWeekRate,
        worstWeekLabel,
      };
    })
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));

  let listed = 0;
  let staged = 0;
  let notStaged = 0;
  let submitted = 0;
  let attended = 0;
  let promoted = 0;
  let noShow = 0;
  let stillOpen = 0;
  let measuredWeeks = 0;
  let unmeasurableWeeks = 0;
  let firstWeek: string | null = null;
  let lastWeek: string | null = null;

  for (const w of allRows) {
    listed += w.listed;
    staged += w.staged;
    notStaged += w.notStaged;
    submitted += w.submitted;
    attended += w.attended;
    promoted += w.promoted;
    noShow += w.noShow;
    stillOpen += w.stillOpen;
    if (w.measurable) measuredWeeks += 1;
    else unmeasurableWeeks += 1;
    if (!w.onChecklist || w.weekStart === UNDATED_WEEK) continue;
    if (!firstWeek || w.weekStart < firstWeek) firstWeek = w.weekStart;
    if (!lastWeek || w.weekStart > lastWeek) lastWeek = w.weekStart;
  }

  return {
    weeks: allRows,
    months,
    totals: {
      measuredWeeks,
      unmeasurableWeeks,
      listed,
      staged,
      notStaged,
      submitted,
      attended,
      promoted,
      noShow,
      stillOpen,
      rate: staged > 0 ? promoted / staged : null,
      offChecklist: offChecklistTotal,
      firstWeek,
      lastWeek,
    },
  };
}

function byWeekDesc(a: HrPipelineWeekRow, b: HrPipelineWeekRow): number {
  return a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0;
}

/**
 * `pickChecklistWeek` takes a mutable `Map`; this module's inputs are readonly
 * so callers cannot be handed something they might mutate. The cast is local,
 * and the resolver only reads.
 */
function asMutableMap(m: ReadonlyMap<string, string[]>): Map<string, string[]> {
  return m as Map<string, string[]>;
}
