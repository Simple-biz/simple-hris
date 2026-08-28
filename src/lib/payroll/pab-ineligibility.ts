/**
 * PAB ineligibility detail — WHY someone failed the Perfect Attendance Bonus, and
 * how badly.
 *
 * The shipped engine (`computePabEligibleEmails` in dispatch-bonuses.ts) answers a
 * yes/no question and returns a Set of passers. It cannot say "Maria missed two
 * days" — and the wizard's step-6 PAB review needs exactly that, for everyone, so
 * an accountant can spot the 1-or-2-day cases that are usually a shifting schedule
 * rather than absence.
 *
 * That detail DID exist, inline, inside the PAB Calendar modal's render closure in
 * PayrollWizard.tsx — computed per-employee, unreachable from anywhere else, and
 * untested. This module is that logic lifted verbatim and made pure, so the review
 * table and the calendar modal share one definition of "failed day".
 *
 * ## The invariant that matters
 *
 * `severity === 0` MUST mean the same thing as membership in
 * `computePabEligibleEmails`. This module does not re-decide eligibility — it
 * explains a verdict the engine already reached. `pab-ineligibility.test.ts` pins
 * that identity across HSL and non-HSL. **If that test ever fails, PAB money has
 * moved** — the same alarm `pab-calendar-sun-sat-display.test.ts` provides for the
 * Sun–Sat grid.
 *
 * ## Why HSL counts differently, and why that is not a bug
 *
 * Non-HSL PAB is won day-by-day: every Mon–Fri must reach 7h. A failed day is a
 * failed day, and severity is just how many.
 *
 * HSL PAB is won week-by-week: ≥5 qualifying days out of each 7-day week
 * (`checkHslPabEligibility`). So for HSL a short day inside a week that still hits
 * 5-of-7 has cost the employee nothing, and counting it would make the severity
 * column useless for the exact cohort it exists to surface. Three carve-outs follow,
 * all of them lifted from the shipped modal:
 *
 *   1. Saturday and Sunday never count as failed.
 *   2. An overnight-qualifying day never counts (the shift crossed midnight; the
 *      hours are real, they just landed on two dates).
 *   3. A day inside a week that reconciled (`weekPasses`) never counts.
 *
 * A consequence worth stating because it looks wrong: an HSL person who was short on
 * four days can show severity 0. That is correct — they made quota every week.
 */

const SEVEN_HOURS_SEC = 7 * 3600;
const QUALIFYING_DAYS_PER_WEEK = 5;

/**
 * One day of a person's PAB period, already resolved by the caller.
 *
 * `seconds` is post-override: a dispute's `override_hours` has already replaced the
 * raw Hubstaff value, matching the SET semantics in `employeeWeekdayHours`. The two
 * `forgiven*` flags mark WHY a sub-7h day still passes, which the HSL week walk
 * needs — a forgiven day counts toward the 5-of-7 quota.
 */
export type PabDayEntry = {
  /** `YYYY-MM-DD`. */
  iso: string;
  seconds: number;
  passes: boolean;
  forgivenByDispute: boolean;
  forgivenByHoliday: boolean;
};

export type HslWeekData = {
  qualifyingDays: number;
  weekPasses: boolean;
  /** Days that only qualified by combining with an adjacent day's hours. */
  overnightIsos: Set<string>;
};

export type PabFailedDay = {
  iso: string;
  seconds: number;
  /** How far short of 7h. Zero-hour days shortfall the full 7h. */
  shortfallSec: number;
};

export type PabIneligibility = {
  /**
   * The count the review table sorts and bands on: how many days actually cost this
   * person the bonus. Zero means eligible — see the identity invariant above.
   */
  severity: number;
  failedDays: PabFailedDay[];
};

export type PabIneligibilityInput = {
  /**
   * The person's days for the whole EVALUATED window — which for HSL is wider
   * than the PAB period on both ends.
   *
   * **This is the sharpest edge in the module.** A missing day is scored as zero
   * hours, exactly as the engine scores it (`hoursByDateKey.get(key) ?? 0`), so
   * under-supplying days does not error — it manufactures failures. HSL weeks
   * anchor BACK to the Sunday on/before `periodStart`, so when a period opens
   * mid-week (2026-07 began Mon Jul 6) the anchor Sunday is OUTSIDE the period
   * and still scored. Hand this only `[periodStart, periodEnd]` and that Sunday
   * reads as a no-show, the opening week loses a qualifying day, and everyone
   * whose week sat at exactly 5-of-7 flips to ineligible.
   *
   * Callers must therefore span {@link hslCoverageStart} → `periodEnd`. The
   * wizard's own `allDaysColumnGroups` filters from `pabMonthRange.start` and is
   * NOT wide enough on its own. The identity test in `pab-ineligibility.test.ts`
   * caught exactly this, and pins it.
   */
  entries: PabDayEntry[];
  isHsl: boolean;
  /**
   * Post-cutover HSL weeks run Sun→Sat; legacy weeks run Mon→Sun. Required, not
   * defaulted: the correct answer changes on a date, and a default here is how
   * `checkHslPabEligibility` silently scored three months on the wrong week
   * (see memory pab-calendars-sun-sat-sweep). Ignored when `isHsl` is false.
   */
  hslSunSat: boolean;
  periodStart: Date;
  /**
   * For HSL this is the extended end (`getHslAdjustedEnd`) so the final week is
   * evaluated whole; for everyone else it is the plain period end.
   */
  periodEnd: Date;
};

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Effective seconds for the HSL quota walk: a forgiven day counts as a full day. */
function quotaSeconds(entry: PabDayEntry | undefined): number {
  if (!entry) return 0;
  if (entry.forgivenByDispute || entry.forgivenByHoliday) return SEVEN_HOURS_SEC;
  return entry.seconds;
}

/**
 * ISO of the day that STARTS the HSL week containing `date` — the Sunday for
 * post-cutover Sun→Sat weeks, the Monday for legacy Mon→Sun weeks.
 *
 * Must match the anchor used by {@link computeHslWeekInfo} and
 * `checkHslPabEligibility`, or a day's pass/fail lookup lands on the wrong week.
 */
export function hslWeekStartIso(date: Date, hslSunSat: boolean): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay(); // Sun=0 … Sat=6
  const daysBack = hslSunSat ? dow : dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - daysBack);
  return isoOf(d);
}

/**
 * The first day the caller must supply hours for.
 *
 * For HSL this is the anchor — the Sunday on/before `periodStart` for post-cutover
 * weeks, the first Monday on/after it for legacy ones — because that is where
 * `checkHslPabEligibility` starts its walk. For everyone else it is `periodStart`
 * itself. Use this to size the column window, rather than assuming the PAB period
 * and the evaluated window are the same range. They are not.
 */
export function hslCoverageStart(periodStart: Date, isHsl: boolean, hslSunSat: boolean): Date {
  const d = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate());
  if (!isHsl) return d;
  const dow = d.getDay();
  if (hslSunSat) {
    d.setDate(d.getDate() - dow); // back to the Sunday on/before
  } else {
    const toMon = dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow; // forward to the first Monday
    d.setDate(d.getDate() + toMon);
  }
  return d;
}

/**
 * Per-week HSL quota data, keyed by the week's starting ISO.
 *
 * Mirrors `checkHslPabEligibility`'s walk: same anchor, same 7-day blocks, same
 * overnight forward/backward credit, same ≥5 threshold. It reports the counts that
 * predicate throws away, so a reviewer can see a week failed 4-of-7 rather than only
 * that the month failed.
 */
export function computeHslWeekInfo(
  entries: PabDayEntry[],
  opts: { hslSunSat: boolean; periodStart: Date; periodEnd: Date },
): Map<string, HslWeekData> {
  const byIso = new Map<string, PabDayEntry>();
  for (const e of entries) byIso.set(e.iso, e);

  const info = new Map<string, HslWeekData>();
  const endT = new Date(
    opts.periodEnd.getFullYear(),
    opts.periodEnd.getMonth(),
    opts.periodEnd.getDate(),
  ).getTime();

  // Anchor the first week exactly as checkHslPabEligibility does: sun_sat walks
  // BACK to the Sunday on/before the start (so a boundary Sunday opening the
  // month's first week is included); mon_sun walks FORWARD to the first Monday.
  const wCur = new Date(opts.periodStart.getFullYear(), opts.periodStart.getMonth(), opts.periodStart.getDate());
  const wDow = wCur.getDay();
  if (opts.hslSunSat) {
    wCur.setDate(wCur.getDate() - wDow);
  } else {
    const toMon = wDow === 0 ? 1 : wDow === 1 ? 0 : 8 - wDow;
    wCur.setDate(wCur.getDate() + toMon);
  }

  while (wCur.getTime() <= endT) {
    const weekIso = isoOf(wCur);
    let qualifyingDays = 0;
    const overnightIsos = new Set<string>();
    const dayCur = new Date(wCur);

    for (let d = 0; d < 7; d++) {
      if (dayCur.getTime() > endT) break;
      const dayIso = isoOf(dayCur);
      const sec = quotaSeconds(byIso.get(dayIso));
      let effectiveSec = sec;

      if (sec > 0 && sec < SEVEN_HOURS_SEC) {
        // Forward: today is the overnight START — add tomorrow's hours.
        const next = new Date(dayCur.getFullYear(), dayCur.getMonth(), dayCur.getDate() + 1);
        const nextEntry = byIso.get(isoOf(next));
        if (nextEntry) {
          const nextSec = quotaSeconds(nextEntry);
          if (sec + nextSec >= SEVEN_HOURS_SEC) effectiveSec = sec + nextSec;
        }
        // Backward: today is the overnight TAIL — add yesterday's hours. A forgiven
        // previous day is skipped: it already counts on its own, and lending its
        // notional 7h here would manufacture a second qualifying day.
        if (effectiveSec < SEVEN_HOURS_SEC) {
          const prev = new Date(dayCur.getFullYear(), dayCur.getMonth(), dayCur.getDate() - 1);
          const prevEntry = byIso.get(isoOf(prev));
          if (prevEntry && !prevEntry.forgivenByDispute && !prevEntry.forgivenByHoliday) {
            const prevSec = prevEntry.seconds;
            if (prevSec > 0 && prevSec < SEVEN_HOURS_SEC && prevSec + sec >= SEVEN_HOURS_SEC) {
              effectiveSec = prevSec + sec;
            }
          }
        }
      }

      if (effectiveSec >= SEVEN_HOURS_SEC) {
        qualifyingDays++;
        if (sec < SEVEN_HOURS_SEC) overnightIsos.add(dayIso);
      }

      dayCur.setDate(dayCur.getDate() + 1);
      wCur.setDate(wCur.getDate() + 1);
    }

    info.set(weekIso, {
      qualifyingDays,
      weekPasses: qualifyingDays >= QUALIFYING_DAYS_PER_WEEK,
      overnightIsos,
    });
  }

  return info;
}

/**
 * The days that actually cost this person the bonus, and how many.
 *
 * Non-HSL: every entry that did not pass. Entries are already Mon–Fri scoring cells
 * (the caller builds them from `weekdayColumnGroups`), so there is no weekend to
 * filter — but HSL callers pass all seven days, which is why the carve-outs below
 * exist.
 */
export function computePabIneligibility(input: PabIneligibilityInput): PabIneligibility {
  const { entries, isHsl, hslSunSat, periodStart, periodEnd } = input;

  const hslWeekInfo = isHsl
    ? computeHslWeekInfo(entries, { hslSunSat, periodStart, periodEnd })
    : null;

  const overnightIsos = new Set<string>();
  if (hslWeekInfo) {
    for (const week of hslWeekInfo.values()) {
      for (const iso of week.overnightIsos) overnightIsos.add(iso);
    }
  }

  const failedDays: PabFailedDay[] = [];

  for (const entry of entries) {
    if (entry.passes) continue;

    if (isHsl) {
      const d = parseIso(entry.iso);
      if (!d) continue;
      const dow = d.getDay();
      // 1. HSL weekends are part of the 7-day quota, not a requirement — a missed
      //    Saturday is not a failure, it is a day off.
      if (dow === 0 || dow === 6) continue;
      // 2. The shift crossed midnight; the hours are real.
      if (overnightIsos.has(entry.iso)) continue;
      // 3. The week made 5-of-7 anyway, so this day cost nothing.
      if (hslWeekInfo?.get(hslWeekStartIso(d, hslSunSat))?.weekPasses) continue;
    }

    failedDays.push({
      iso: entry.iso,
      seconds: entry.seconds,
      shortfallSec: Math.max(0, SEVEN_HOURS_SEC - entry.seconds),
    });
  }

  failedDays.sort((a, b) => a.iso.localeCompare(b.iso));

  return { severity: failedDays.length, failedDays };
}

function parseIso(iso: string): Date | null {
  const parts = iso.split('-');
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Severity bands for the review table.
 *
 * `review` is the cohort the step exists for: one or two missed days is usually a
 * shifting schedule rather than absence, and is worth a look before the month's
 * ₱5,000 is lost. It is a prompt to check, never a verdict — the band never gates
 * anything and never changes what is paid.
 */
export type PabSeverityBand = 'eligible' | 'no-hours' | 'review' | 'high';

/**
 * @param hasHours whether ANY scoring day in the period carried tracked time.
 *
 * **`no-hours` is not a severity, it is the absence of evidence.** Someone with no
 * tracked time at all did not "miss 15 days" — they were never scored. Measured
 * 2026-08-28, 871 of the 2,086 emails the PAB month merges in are in exactly that
 * state, most of them leavers whose last worked week is months behind the period
 * (Aaron Taguas resigned 2026-06-02 and still sorted to the TOP of the August list
 * on a severity of 15). Reporting them as the worst attendance in the company is
 * wrong twice: it buries the real 1–2-day cases the step exists for, and it offers
 * a Forgive button for a bonus the person cannot earn.
 *
 * They are banded, never dropped — a roster/coverage problem is still worth seeing,
 * it just is not an attendance verdict.
 */
export function pabSeverityBand(severity: number, hasHours = true): PabSeverityBand {
  if (!hasHours) return 'no-hours';
  if (severity <= 0) return 'eligible';
  if (severity <= 2) return 'review';
  return 'high';
}
