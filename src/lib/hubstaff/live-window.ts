/**
 * The date window the employee-facing live Hubstaff overlay asks the API for.
 *
 * WHY THIS EXISTS — measured 2026-09-12 (`scripts/audit-hubstaff-live-window-cost.mts`):
 * the overlay asked for a FIXED 13-days-back → tomorrow window on every refresh. For
 * this org that is 23 paginated Hubstaff requests, 6.25 MB and 11,060 activity rows,
 * of which **97.6% were days that an uploaded batch already covers or that had simply
 * already been fetched moments earlier**. At the 180s TTL that is ~460 requests/hour
 * from ONE warm serverless instance against a 1000/hour account cap — so roughly two
 * warm instances exhaust the budget, after which Hubstaff answers 429, the backoff in
 * `fetchHubstaff` stretches the pull, and the route's 60s ceiling turns a rate-limit
 * into an employee-visible blank calendar.
 *
 * THE FIX IS TO ASK FOR LESS, NOT TO CACHE LONGER. Every day inside the window is
 * still re-read on every refresh; nothing here makes a figure staler than it is today.
 * That matters because these hours are not decoration — they drive the PAB eligibility
 * walk, the red tone, the missed-day nudge, and the "Hubstaff shows Xh" line an
 * employee files a time adjustment against.
 *
 * TWO GUARDS MAKE THIS A NARROWING ONLY (see `resolveLiveOverlayWindow`):
 *   - it can never reach FURTHER BACK than the 13 days it replaces, so no refresh
 *     costs more than it does today; and
 *   - it can never start LATER than the current week's Sunday, so today and the week
 *     in progress are always live no matter what a batch claims to cover.
 *
 * DELIBERATELY NOT FIXED HERE: if uploads lapse for more than 13 days the overlay
 * under-covers the gap. That is PRE-EXISTING behaviour, unchanged by this module —
 * widening the window would multiply the request count this exists to cut. The gap is
 * real because the weekly pull is a MANUAL wizard action (memory/hubstaff-weekly-auto-sync:
 * "assume they did not"), and it is tracked in the session log rather than papered over.
 */

import { parseDateRangeFromFilename } from './calendar-column-dedupe';

const DAY_MS = 86_400_000;

/** The widest lookback this may ever request — exactly what it replaces, never more. */
export const MAX_LOOKBACK_DAYS = 13;

/** ISO `YYYY-MM-DD` → whole days since the epoch. UTC-anchored, so DST cannot shift it. */
export function isoToDayNum(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : null;
}

/** Inverse of {@link isoToDayNum}. */
export function dayNumToIso(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Every ISO date covered by an uploaded batch, expanded from the date range in each
 * `source_file` name.
 *
 * Uses the canonical `parseDateRangeFromFilename` rather than a new regex — a batch's
 * filename is the only address its pay week has and 17 modules already re-derive it
 * (docs/features/INDEX.md:39); an 18th copy is how they drift. That parser searches for
 * the range anywhere in the name, so a browser duplicate-download suffix
 * (`..._2026-08-30_to_2026-09-05 4.csv`, which is what prod is carrying today) still
 * resolves. It returns LOCAL-midnight Dates, so the calendar fields are read with local
 * getters here — `toISOString()` on one of those shifts the day west of UTC.
 *
 * The span is read literally and never assumed to be 7: prod carries both 7- and 8-day
 * ranges (docs/features/INDEX.md:39, "the SPAN is deliberately unchecked").
 */
export function coveredDatesFromSourceFiles(
  sourceFiles: readonly (string | null | undefined)[],
): Set<string> {
  const covered = new Set<string>();
  for (const file of sourceFiles) {
    if (!file) continue;
    const range = parseDateRangeFromFilename(file);
    if (!range) continue;
    const startDay = isoToDayNum(localDateToIso(range.start));
    const endDay = isoToDayNum(localDateToIso(range.end));
    if (startDay === null || endDay === null || endDay < startDay) continue;
    // A malformed name could in principle describe an enormous span; bound the
    // expansion so one bad row cannot allocate without limit.
    if (endDay - startDay > 366) continue;
    for (let d = startDay; d <= endDay; d++) covered.add(dayNumToIso(d));
  }
  return covered;
}

function localDateToIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type LiveOverlayWindow = {
  rangeStart: string;
  rangeStop: string;
  /** Days the window spans, inclusive — what the request count scales with. */
  days: number;
  /**
   * Why `rangeStart` landed where it did. Observability only; no caller branches on it.
   *  - `batch-coverage` — walked back to a day an uploaded batch already covers
   *  - `current-week`   — coverage reaches into this week, so the week's Sunday won
   *  - `max-lookback`   — nothing covered within the cap; identical to the old fixed window
   */
  reason: 'batch-coverage' | 'current-week' | 'max-lookback';
};

/**
 * Resolve the window to ask Hubstaff for.
 *
 * Walks back from today through days NO uploaded batch covers and starts the overlay
 * at the oldest of those. Walking (rather than taking the newest batch's end date) is
 * what makes a HOLE in the upload history safe: a missed week in the middle is a run of
 * uncovered days, so the walk passes straight through it and the overlay picks it up,
 * where "start after the latest batch" would have skipped it silently.
 *
 * @param todayIso  today, UTC — the same basis the route's `+1 day` stop already uses to
 *                  absorb the org timezone running ahead of the server's date.
 */
export function resolveLiveOverlayWindow(opts: {
  todayIso: string;
  coveredDates: ReadonlySet<string>;
  maxLookbackDays?: number;
}): LiveOverlayWindow {
  const { todayIso, coveredDates } = opts;
  const maxLookback = opts.maxLookbackDays ?? MAX_LOOKBACK_DAYS;
  const today = isoToDayNum(todayIso);
  if (today === null) throw new Error(`resolveLiveOverlayWindow: bad todayIso ${todayIso}`);

  const floor = today - maxLookback;

  // Walk back over uncovered days. Stops on the first day a batch already covers.
  let walkStart = today;
  let reason: LiveOverlayWindow['reason'] = 'batch-coverage';
  while (walkStart > floor && !coveredDates.has(dayNumToIso(walkStart - 1))) {
    walkStart -= 1;
  }
  if (walkStart === floor) reason = 'max-lookback';

  // GUARD: the current week is always live. A batch is a snapshot of a week that is
  // still moving, so even one claiming to cover today cannot retire today's own read.
  const weekSunday = today - new Date(today * DAY_MS).getUTCDay();
  let start = Math.min(walkStart, weekSunday);
  if (start === weekSunday && weekSunday < walkStart) reason = 'current-week';

  // GUARD: never reach further back than the fixed window this replaces.
  if (start < floor) start = floor;

  return {
    rangeStart: dayNumToIso(start),
    rangeStop: dayNumToIso(today + 1),
    days: today + 1 - start + 1,
    reason,
  };
}
