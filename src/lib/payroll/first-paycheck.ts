/**
 * "First paycheck" — is the pay week in view the FIRST week this person has
 * Hubstaff hours for, across every upload on record?
 *
 * Why this exists (Carla, 2026-09-22): a hire who leaves inside their first
 * week logs a few hours and is off-boarded before payroll runs. Every new-hire
 * list the team uses is built from ACTIVE rosters, so the person is on none of
 * them, and Accounting only finds them by hand-checking rows. The Payroll
 * Wizard already has their calc row — pay rides Hubstaff hours, not the roster
 * — so the fix is to LABEL that row, not to add one.
 *
 * The criterion is hours, deliberately NOT a start date: a master-list Start
 * Date is sparse (690 of 4,045 offboarded rows carry one), hand-typed, and
 * absent for exactly the people this label is for. Hours in an earlier upload
 * cannot be forged by a bad date: either an earlier timesheet has you or it
 * doesn't. Start date rides along as DETAIL only.
 *
 * Pure. No I/O, no React. The server builds `FirstHoursIndex`
 * (`first-hours-index.ts`); the wizard calls `classifyFirstPaycheck` per calc row.
 */

/** ISO `YYYY-MM-DD` — the upload's parsed period START, the same key the wizard
 *  uses for `hubstaffWeekStart`. ISO strings compare lexically as dates. */
export type WeekKey = string;

export interface FirstHoursIndex {
  /** normalized email → the EARLIEST upload week (period start) that carries
   *  hours for that exact address. */
  firstWeekByEmail: ReadonlyMap<string, WeekKey>;
  /** The oldest parseable upload week on record — the history floor. On that
   *  week everyone is trivially "first", so the label is suppressed. */
  oldestWeek: WeekKey | null;
}

export type FirstPaycheckVerdict =
  | {
      kind: 'first';
      /** The week the person first appears — equals the week in view. */
      firstWeek: WeekKey;
      /** True when the same row is also a final check (the one-week hire). */
      alsoLeaving: boolean;
      /** Master/overlay start date, `YYYY-MM-DD`, when one is on file. Detail only. */
      startDate: string | null;
    }
  | { kind: 'not_first'; firstWeek: WeekKey }
  /** No upload on record carries any of the row's aliases — the index cannot
   *  place the person at all. Disclosed, never labelled. */
  | { kind: 'unknown' }
  /** The week in view IS the oldest upload on record: "first" carries no
   *  information here, so nothing is labelled. */
  | { kind: 'history_floor' };

export interface ClassifyInput {
  /** The pay week in view — the selected upload's parsed period start. */
  weekStart: WeekKey;
  /** Every email the person is known by: the calc row's own address first,
   *  then master / final-pay-overlay aliases. Nulls and blanks are ignored. */
  aliases: ReadonlyArray<string | null | undefined>;
  index: FirstHoursIndex;
  /** Whether the row's address is in the final-pay overlay (a leaver's last check). */
  alsoLeaving: boolean;
  /** Start date detail, if any. Passed through, never judged. */
  startDate?: string | null;
}

/** Lower-case + trim. Kept local so this module stays dependency-free and
 *  testable under `node --test` without path aliases. Mirrors `normEmail`. */
function norm(e: string | null | undefined): string | null {
  const s = (e ?? '').trim().toLowerCase();
  return s ? s : null;
}

/**
 * The earliest week ANY alias has hours in. `undefined` when no alias is known
 * to the index at all.
 */
export function earliestWeekForAliases(
  index: FirstHoursIndex,
  aliases: ReadonlyArray<string | null | undefined>,
): WeekKey | undefined {
  let best: WeekKey | undefined;
  for (const a of aliases) {
    const n = norm(a);
    if (!n) continue;
    const w = index.firstWeekByEmail.get(n);
    if (w && (best === undefined || w < best)) best = w;
  }
  return best;
}

export function classifyFirstPaycheck(input: ClassifyInput): FirstPaycheckVerdict {
  const { weekStart, index } = input;
  if (index.oldestWeek !== null && weekStart <= index.oldestWeek) {
    return { kind: 'history_floor' };
  }
  const first = earliestWeekForAliases(index, input.aliases);
  if (first === undefined) return { kind: 'unknown' };
  if (first < weekStart) return { kind: 'not_first', firstWeek: first };
  // `first > weekStart` cannot happen for a row that has hours in this week's
  // file — the index would have recorded this week or an earlier one. If it
  // does (index built from a stale upload list), treat it as first: the label
  // is display-only and over-flagging is the safe direction here.
  return {
    kind: 'first',
    firstWeek: first,
    alsoLeaving: input.alsoLeaving,
    startDate: input.startDate ?? null,
  };
}

/**
 * Fold raw `(email, weekKey)` observations into the index. Order-independent:
 * the minimum week wins per address. Rows with an unparseable week are counted
 * in `skipped` and never lower anyone's first week.
 */
export function buildFirstHoursIndex(
  observations: Iterable<{ email: string | null | undefined; weekKey: WeekKey | null }>,
): FirstHoursIndex & { skipped: number } {
  const firstWeekByEmail = new Map<string, WeekKey>();
  let oldestWeek: WeekKey | null = null;
  let skipped = 0;
  for (const o of observations) {
    if (!o.weekKey) {
      skipped++;
      continue;
    }
    if (oldestWeek === null || o.weekKey < oldestWeek) oldestWeek = o.weekKey;
    const n = norm(o.email);
    if (!n) continue;
    const cur = firstWeekByEmail.get(n);
    if (cur === undefined || o.weekKey < cur) firstWeekByEmail.set(n, o.weekKey);
  }
  return { firstWeekByEmail, oldestWeek, skipped };
}

/**
 * `simple-biz_daily_report_2026-08-23_to_2026-08-29 (1).csv` → `2026-08-23`.
 * Anchored on the `_to_` range like every other reader; the filename's junk
 * suffix is irrelevant here on purpose (memory: hubstaff-filename-junk-heuristic
 * — a "(1)" week was PAID, so it is history and must count as history).
 */
export function weekKeyFromUploadName(sourceFile: string | null | undefined): WeekKey | null {
  const m = /(\d{4}-\d{2}-\d{2})_to_\d{4}-\d{2}-\d{2}/.exec(sourceFile ?? '');
  return m ? m[1] : null;
}
