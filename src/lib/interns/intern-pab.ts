/**
 * Intern Perfect Attendance Bonus — the rule, pure and tested.
 *
 * Ralph via Kane, 2026-09-02: "5 hours per week to qualify for the ₱1,000 PAB,
 * same pay cycle as Simple.biz." So:
 *
 *   eligible ⇔ EVERY Sun–Sat week whose Saturday falls inside the month's PAB
 *              period has paid hours ≥ 5 (after caps — cap and threshold are the
 *              same 5 hours, so an intern who works the full allowance every
 *              week qualifies). One short week loses the month, exactly like
 *              Simple's one-short-day rule.
 *
 * "Same PAB period" is enforced by the caller: `period` comes from the SAME
 * `pab-period-settings.ts` readers Simple uses (overrides included), and the
 * payout week is decided by the SAME `isFinalPabWeek` containment rule
 * (pab-payout-week-gate-and-pill). This module only judges the weeks it is
 * handed. It never invents one: a Saturday inside the period with no locked
 * week is `weeks_missing`, which pays ₱0 and says why.
 *
 * Not configurable on purpose — Ralph decided it. Fixed sessions / schedules
 * were scoped out with that answer.
 */

export const INTERN_PAB_MIN_WEEKLY_HOURS = 5;

export interface InternPabWeek {
  /** YYYY-MM-DD, the Sunday. */
  weekStart: string;
  /** YYYY-MM-DD, the Saturday. */
  weekEnd: string;
  /** Paid hours after caps (priceInternWeek().hoursPaid). */
  hoursPaid: number;
}

export interface InternPabInput {
  /** The month's PAB window (Simple's), as YYYY-MM-DD inclusive bounds. */
  period: { start: string; end: string };
  /** Every locked week the caller could find for this intern. Extra weeks are ignored. */
  weeks: InternPabWeek[];
  minWeeklyHours: number;
  /** The intern's pab_bonus_php. */
  bonusPhp: number;
}

export type InternPabVerdict =
  | { status: 'eligible'; amountPhp: number }
  | { status: 'ineligible'; amountPhp: 0; failedWeekStarts: string[] }
  | { status: 'weeks_missing'; amountPhp: 0; missingWeekEnds: string[] };

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}
function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The Saturdays (week ends) inside the period — one per counted week. */
export function expectedInternPabWeekEnds(period: { start: string; end: string }): string[] {
  if (!ISO_RE.test(period.start) || !ISO_RE.test(period.end) || period.end < period.start) return [];
  const out: string[] = [];
  const cur = toUtc(period.start);
  const end = toUtc(period.end).getTime();
  while (cur.getTime() <= end) {
    if (cur.getUTCDay() === 6) out.push(fromUtc(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export function internPabVerdict(input: InternPabInput): InternPabVerdict {
  const expected = expectedInternPabWeekEnds(input.period);
  if (expected.length === 0) return { status: 'weeks_missing', amountPhp: 0, missingWeekEnds: [] };

  const byEnd = new Map<string, InternPabWeek>();
  for (const w of input.weeks) {
    if (ISO_RE.test(w.weekEnd)) byEnd.set(w.weekEnd, w);
  }

  const missing = expected.filter((e) => !byEnd.has(e));
  if (missing.length > 0) return { status: 'weeks_missing', amountPhp: 0, missingWeekEnds: missing };

  // hoursPaid is already 2dp, so half a centi-hour of float slack is enough:
  // 5.00 qualifies, 4.99 does not.
  const threshold = input.minWeeklyHours - 0.005;
  const failed: string[] = [];
  for (const e of expected) {
    const w = byEnd.get(e)!;
    if (!(w.hoursPaid >= threshold)) failed.push(w.weekStart);
  }
  if (failed.length > 0) return { status: 'ineligible', amountPhp: 0, failedWeekStarts: failed };

  const amount = Math.round(Math.max(0, input.bonusPhp) * 100) / 100;
  return { status: 'eligible', amountPhp: amount };
}
