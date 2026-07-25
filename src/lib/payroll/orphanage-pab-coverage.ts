/**
 * TEMPORARY orphanage → PAB coverage rule (added 2026-07-25, auto mode
 * confirmed by owner the same day).
 *
 * Business rule (owner-confirmed, flagged temporary — "soon this will change"):
 *   An employee with **hours entered in the Payroll Wizard's Orphanage step**
 *   was at the orphanage — those hours AUTOMATICALLY forgive their short
 *   workdays: a weekday counts as a full Perfect-Attendance day when the
 *   orphanage hours top the day's tracked time up to the 7-hour threshold:
 *
 *        worked seconds + orphanage hours × 3600  ≥  7 × 3600   ⇒  day passes
 *
 *   No dispute/excuse record is required (none exist in practice). The rule is
 *   ADDITIVE — it never lowers eligibility, and the existing ≥4h approved-
 *   dispute floor keeps working independently.
 *
 * Coverage WINDOW: the hours' pay-week file **plus the week before it**.
 * Orphanage attendance results only come in over the following weekend, so the
 * hours for a visit in week W are locked into week W+1's payroll file (owner-
 * confirmed 2026-07-25; e.g. the 2026-07-10 visit's hours all sit in the
 * `2026-07-12_to_2026-07-18` file). Only WEEKDAYS (Mon–Fri) are covered — the
 * standard PAB rule only checks Mon–Fri, and enumerating weekends would hand
 * HSL's 5-of-7 weekly quota free passing days.
 *
 * Why a shared helper: PAB eligibility is computed independently in ~6 places
 * (the Payroll Wizard, the shared server engine `dispatch-bonuses.ts`, the
 * employee Dashboard / My Hours / PAB calendar). They must all apply the exact
 * same predicate or an employee's view, Payment Dispatch, and what the wizard
 * dispatches disagree. Every site funnels its orphanage top-up through the
 * functions here so the rule can never drift — and can be ripped out in one file.
 */
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';

/** The Perfect-Attendance per-day threshold, in seconds (7 hours). */
export const PAB_FULL_DAY_SECONDS = 7 * 3600;

/** A single locked-in orphanage-pay row, reduced to what coverage needs. */
export interface OrphanagePayLite {
  /** Hubstaff upload filename = the pay week (`..._YYYY-MM-DD_to_YYYY-MM-DD.csv`). */
  sourceFile: string | null | undefined;
  /** Employee email (any case — normalized to lower-case internally). */
  email: string | null | undefined;
  /** Total orphanage hours locked in for that person that week. */
  hours: number | null | undefined;
}

/** One indexed week of orphanage hours. The coverage window opens one week
 *  BEFORE the file week (hours for a visit in week W are locked into week W+1's
 *  payroll file — attendance results arrive the following week). */
interface OrphanageWeek {
  /** Coverage window start = file-week start − 7 days (local midnight ms). */
  windowStartMs: number;
  /** File-week start (local midnight ms) — kept for window enumeration. */
  startMs: number;
  endMs: number;
  hours: number;
}

/** email (lower-cased) → the weeks that person has locked-in orphanage hours for. */
export type OrphanageHoursIndex = Map<string, OrphanageWeek[]>;

const localMidnightMs = (d: Date): number =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Parse an ISO-ish date string ("YYYY-MM-DD…") to local-midnight ms, or null. */
function isoToLocalMidnightMs(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : localMidnightMs(d);
}

/**
 * Index locked-in orphanage-pay rows by employee → week. Rows with no positive
 * hours, no email, or a `source_file` whose week can't be parsed are skipped
 * (a week is required to attribute the hours to a specific excused day).
 */
export function buildOrphanageHoursIndex(rows: readonly OrphanagePayLite[]): OrphanageHoursIndex {
  const idx: OrphanageHoursIndex = new Map();
  for (const row of rows) {
    const email = (row.email ?? '').trim().toLowerCase();
    if (!email) continue;
    const hours = Number(row.hours);
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const range = row.sourceFile ? parseDateRangeFromFilename(row.sourceFile) : null;
    if (!range) continue;
    const week: OrphanageWeek = {
      windowStartMs: localMidnightMs(
        new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() - 7),
      ),
      startMs: localMidnightMs(range.start),
      endMs: localMidnightMs(range.end),
      hours,
    };
    const list = idx.get(email);
    if (list) list.push(week);
    else idx.set(email, [week]);
  }
  return idx;
}

/**
 * Orphanage hours whose coverage window contains `isoDate`, for `email`.
 * Window = the hours' file week PLUS the week before it (hours land one payroll
 * run after the visit). Returns 0 when no window matches; when several rows'
 * windows overlap the date (consecutive pay weeks), the largest is used —
 * per-day max, never a sum.
 */
export function orphanageHoursForDate(
  idx: OrphanageHoursIndex,
  email: string | null | undefined,
  isoDate: string,
): number {
  const list = idx.get((email ?? '').trim().toLowerCase());
  if (!list?.length) return 0;
  const t = isoToLocalMidnightMs(isoDate);
  if (t == null) return 0;
  let best = 0;
  for (const w of list) {
    if (t >= w.windowStartMs && t <= w.endMs && w.hours > best) best = w.hours;
  }
  return best;
}

/**
 * The coverage predicate: do the orphanage hours top a day's worked time up to
 * a full 7-hour PAB day? False when there are no orphanage hours.
 */
export function orphanageCoversDay(workedSeconds: number, orphanageHours: number): boolean {
  if (!(orphanageHours > 0)) return false;
  return workedSeconds + orphanageHours * 3600 >= PAB_FULL_DAY_SECONDS;
}

/**
 * AUTO mode (owner-confirmed 2026-07-25): every WEEKDAY inside a person's
 * coverage window(s), mapped to the orphanage hours available on it —
 * `iso → hours`. No dispute/excuse record needed. Sites bump each such day to
 * 7h iff {@link orphanageCoversDay} holds for that day's worked seconds.
 * Weekdays only: the standard PAB rule only checks Mon–Fri, and enumerating
 * weekends would hand HSL's 5-of-7 weekly quota free passing days.
 */
export function orphanageHoursByCoveredDate(
  idx: OrphanageHoursIndex,
  email: string | null | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  const list = idx.get((email ?? '').trim().toLowerCase());
  if (!list?.length) return out;
  for (const w of list) {
    for (let t = w.windowStartMs; t <= w.endMs; ) {
      const d = new Date(t);
      const dow = d.getDay();
      if (dow >= 1 && dow <= 5) {
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const prev = out.get(iso) ?? 0;
        if (w.hours > prev) out.set(iso, w.hours);
      }
      // Step by local calendar day (not +86400000) so a DST-style offset shift
      // could never skip or duplicate a date.
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      t = next.getTime();
    }
  }
  return out;
}

/**
 * Whole-fleet builder shared by every server eligibility path: all locked-in
 * orphanage-pay rows → `email -> (iso -> orphanage hours)` over each person's
 * coverage windows. Keys are the orphanage rows' emails (lower-cased on write,
 * same trim+lowercase normalization as `normEmail`, so Hubstaff-email lookups
 * line up).
 */
export function buildOrphanageCoverageMap(
  orphanageRows: readonly OrphanagePayLite[],
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const idx = buildOrphanageHoursIndex(orphanageRows);
  if (!idx.size) return out;
  for (const email of idx.keys()) {
    const m = orphanageHoursByCoveredDate(idx, email);
    if (m.size) out.set(email, m);
  }
  return out;
}
