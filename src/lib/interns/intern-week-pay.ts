/**
 * Intern week pricing — the ONE implementation, pure and tested.
 *
 * Shared by the mini wizard's preview, its Lock in, and Accounting's Interns
 * view (which re-derives every submitted row on read), so no two screens can
 * disagree about an intern's money. Precedent: `orphanage-pay-pricing.ts`.
 *
 *   paid_day  = min(round2(raw_day), dailyCap)        — daily cap first
 *   paid_week = Σ paid_day, consumed chronologically until weeklyCap
 *   pay       = Σ round2(paid_day × rate_in_force_that_day)
 *
 * Rules that are deliberate, each pinned by a test:
 *   - NO overtime, NO weekend premium, NO Tech Bonus. The result type has no
 *     second leg for a wrong rate to hide in.
 *   - The rate is a DATED fact: newest `effectiveFrom <= day` wins, so a
 *     mid-week change prices per day (memory: rate-updated-at-not-evidence).
 *   - A paid day with no rate in force REFUSES the week. A refusal reports
 *     what to fix; a ₱0 would be paid.
 *   - 2dp hours per day BEFORE pricing (the sheet convention the rest of
 *     payroll follows — hsl-sheet-form-pay-rule).
 *   - The orphanage share is round2(gross × pct); the intern share is the
 *     REMAINDER so the two always sum to gross exactly (the OT-leg rule).
 */

export interface InternDayInput {
  /** YYYY-MM-DD */
  iso: string;
  rawSec: number;
}

export interface InternRateRow {
  ratePhp: number;
  /** YYYY-MM-DD — the first day this rate applies. */
  effectiveFrom: string;
}

export interface InternWeekPriceInput {
  /** 1–7 distinct days. Order does not matter; the cap is consumed chronologically. */
  days: InternDayInput[];
  rates: InternRateRow[];
  dailyCapHours: number;
  weeklyCapHours: number;
}

export type InternPriceRefusalCode = 'no_rate_for_week' | 'negative_hours' | 'bad_week_shape';

export interface InternWeekPriceRefusal {
  ok: false;
  code: InternPriceRefusalCode;
  reason: string;
}

export interface InternDayPriced {
  raw: number;
  paid: number;
  ratePhp: number | null;
}

export interface InternWeekPriceOk {
  ok: true;
  /** Σ raw hours, 4dp. */
  hoursRaw: number;
  /** Σ paid hours after both caps, 2dp. */
  hoursPaid: number;
  hoursByDay: Record<string, InternDayPriced>;
  /** The rate in force on the LAST paid day (null when nothing was paid). */
  ratePhp: number | null;
  /** True when more than one rate priced this week. */
  mixedRates: boolean;
  /** Σ per-day legs, each 2dp. */
  payPhp: number;
  /** Hours the caps removed — shown, never paid. */
  cappedOffHours: number;
}

export type InternWeekPriceResult = InternWeekPriceOk | InternWeekPriceRefusal;

// EPSILON nudge: 1.005 * 100 is 100.49999… in binary, so a bare Math.round
// gives 1.00 where the sheet convention (half-up on 2dp) gives 1.01.
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The rate in force on `iso`: newest effectiveFrom <= iso, or null. */
export function internRateForDay(rates: InternRateRow[], iso: string): number | null {
  let best: InternRateRow | null = null;
  for (const r of rates) {
    if (!(r.ratePhp > 0) || !ISO_RE.test(r.effectiveFrom)) continue;
    if (r.effectiveFrom > iso) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best ? best.ratePhp : null;
}

export function priceInternWeek(input: InternWeekPriceInput): InternWeekPriceResult {
  const { days, rates } = input;
  if (!Array.isArray(days) || days.length === 0 || days.length > 7) {
    return { ok: false, code: 'bad_week_shape', reason: `Expected 1–7 days, got ${days?.length ?? 0}.` };
  }
  const seen = new Set<string>();
  for (const d of days) {
    if (!ISO_RE.test(d.iso) || seen.has(d.iso)) {
      return { ok: false, code: 'bad_week_shape', reason: `Duplicate or malformed day "${d.iso}".` };
    }
    seen.add(d.iso);
    if (!Number.isFinite(d.rawSec) || d.rawSec < 0) {
      return { ok: false, code: 'negative_hours', reason: `${d.iso} has ${d.rawSec} seconds — hours cannot be negative or non-finite.` };
    }
  }
  if (!(input.dailyCapHours > 0) || !(input.weeklyCapHours > 0)) {
    return { ok: false, code: 'bad_week_shape', reason: 'Caps must be positive.' };
  }

  const sorted = [...days].sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
  let remaining = input.weeklyCapHours;
  let hoursRaw = 0;
  let hoursPaid = 0;
  let roundedRaw = 0;
  let payPhp = 0;
  let lastRate: number | null = null;
  const ratesUsed = new Set<number>();
  const hoursByDay: Record<string, InternDayPriced> = {};

  for (const d of sorted) {
    const rawH = d.rawSec / 3600;
    hoursRaw += rawH;
    const rawRounded = round2(rawH);
    roundedRaw += rawRounded;
    let paid = Math.min(rawRounded, input.dailyCapHours);
    paid = round2(Math.min(paid, Math.max(0, remaining)));
    remaining = round2(remaining - paid);

    const rate = internRateForDay(rates, d.iso);
    if (paid > 0 && rate == null) {
      return {
        ok: false,
        code: 'no_rate_for_week',
        reason: `No rate is in force on ${d.iso}. Set a rate with an effective date on or before that day.`,
      };
    }
    if (paid > 0 && rate != null) {
      payPhp += round2(paid * rate);
      lastRate = rate;
      ratesUsed.add(rate);
    }
    hoursPaid += paid;
    hoursByDay[d.iso] = { raw: round4(rawH), paid, ratePhp: rate };
  }

  hoursPaid = round2(hoursPaid);
  return {
    ok: true,
    hoursRaw: round4(hoursRaw),
    hoursPaid,
    hoursByDay,
    ratePhp: lastRate,
    mixedRates: ratesUsed.size > 1,
    payPhp: round2(payPhp),
    cappedOffHours: round2(Math.max(0, roundedRaw - hoursPaid)),
  };
}

export type InternPayReconcileStatus = 'ok' | 'pay_mismatch' | 'gross_mismatch' | 'share_mismatch';

export interface InternPayReconcile {
  status: InternPayReconcileStatus;
  expectedPayPhp: number;
  expectedGrossPhp: number;
  expectedOrphanagePhp: number;
  expectedInternPhp: number;
  /** stored − expected on the field that disagrees (0 when ok). */
  deltaPhp: number;
  message: string;
}

/**
 * Re-derive a locked row's money from its OWN hours_by_day × per-day rates and
 * compare. Never rewrites anything — a disagreement is reported so a human
 * decides (the `reconcileLockedOrphanageAmount` rule, applied from day one).
 * Accounting's Interns view runs this on every row it shows.
 */
export function reconcileInternPayRow(row: {
  hours_by_day: Record<string, { paid: number; rate_php: number | null }>;
  pay_php: number;
  pab_php: number;
  gross_php: number;
  orphanage_share_pct: number;
  orphanage_share_php: number;
  intern_share_php: number;
}): InternPayReconcile {
  let expectedPay = 0;
  for (const d of Object.values(row.hours_by_day ?? {})) {
    if (!(d.paid > 0)) continue;
    if (d.rate_php == null) {
      return {
        status: 'pay_mismatch',
        expectedPayPhp: NaN,
        expectedGrossPhp: NaN,
        expectedOrphanagePhp: NaN,
        expectedInternPhp: NaN,
        deltaPhp: 0,
        message: 'A paid day carries no rate — this row cannot be re-derived.',
      };
    }
    expectedPay += round2(d.paid * d.rate_php);
  }
  expectedPay = round2(expectedPay);
  const expectedGross = round2(expectedPay + (row.pab_php ?? 0));
  const split = splitInternGross(expectedGross, row.orphanage_share_pct);
  const base = {
    expectedPayPhp: expectedPay,
    expectedGrossPhp: expectedGross,
    expectedOrphanagePhp: split.orphanagePhp,
    expectedInternPhp: split.internPhp,
  };
  const off = (a: number, b: number) => Math.abs(round2(a) - round2(b)) > 0.005;
  if (off(row.pay_php, expectedPay)) {
    return { ...base, status: 'pay_mismatch', deltaPhp: round2(row.pay_php - expectedPay), message: `Stored pay ₱${row.pay_php.toFixed(2)} disagrees with its own hours × rates (₱${expectedPay.toFixed(2)}).` };
  }
  if (off(row.gross_php, expectedGross)) {
    return { ...base, status: 'gross_mismatch', deltaPhp: round2(row.gross_php - expectedGross), message: `Stored gross ₱${row.gross_php.toFixed(2)} is not pay + PAB (₱${expectedGross.toFixed(2)}).` };
  }
  if (off(row.orphanage_share_php, split.orphanagePhp) || off(row.intern_share_php, split.internPhp)) {
    return { ...base, status: 'share_mismatch', deltaPhp: round2(row.intern_share_php - split.internPhp), message: `Stored shares do not match ${row.orphanage_share_pct}% of gross.` };
  }
  return { ...base, status: 'ok', deltaPhp: 0, message: '' };
}

/**
 * gross → (orphanage share, intern share). The orphanage share is
 * round2(gross × pct / 100); the intern share is the REMAINDER, so the two
 * always sum to gross exactly.
 */
export function splitInternGross(
  grossPhp: number,
  orphanageSharePct: number,
): { orphanagePhp: number; internPhp: number } {
  const gross = round2(Math.max(0, grossPhp));
  const pct = Math.min(100, Math.max(0, orphanageSharePct));
  const orphanagePhp = round2((gross * pct) / 100);
  const internPhp = round2(gross - orphanagePhp);
  return { orphanagePhp, internPhp };
}
