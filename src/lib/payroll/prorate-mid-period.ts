import type { RateHistoryByEmail } from './rate-history-resolve';
import { resolveRateAsOfDate } from './rate-history-resolve';

/**
 * Client-safe per-day proration across a MID-PERIOD rate change (a department
 * transfer, a dated raise). Extracted verbatim from PayrollWizard.tsx so the
 * engine is pure + unit-tested; the wizard imports it back. It mirrors the
 * server dispatch compute (`computeProratedRowPay` in current-pay.ts) EXACTLY:
 * chronological 40h/week regular cap, HSL weekend +15/h folded per day, raw
 * per-day accumulation rounded once at the end.
 *
 * Beyond the pay itself it reports per-rate SEGMENTS — the hours and money each
 * distinct rate actually paid, in pay order — which is what lets a pay
 * statement print "16.25h @ ₱175.00 · 23.75h @ ₱225.00 — effective Jul 22"
 * instead of advertising a single rate that cannot explain the amount.
 */

const REG_WEEK_CAP_SEC = 40 * 3600;

function fmtLocalIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Hours + money one distinct rate paid within a line, in pay order. */
export interface ProrationSegment {
  ratePhp: number;
  hours: number;
  payPhp: number;
}

/** Ordered per-rate accumulator: segments keyed by exact rate, first-use order. */
type SegmentAcc = Array<{ rate: number; sec: number; pay: number }>;

function addToSegment(acc: SegmentAcc, rate: number, sec: number, pay: number): void {
  const hit = acc.find((s) => s.rate === rate);
  if (hit) {
    hit.sec += sec;
    hit.pay += pay;
  } else {
    acc.push({ rate, sec, pay });
  }
}

function finalizeSegments(acc: SegmentAcc): ProrationSegment[] {
  return acc.map((s) => ({ ratePhp: s.rate, hours: round2(s.sec / 3600), payPhp: round2(s.pay) }));
}

export interface MidPeriodRateChange {
  oldRegular: number | null;
  newRegular: number | null;
  oldOt: number | null;
  newOt: number | null;
  effectiveDate: string; // YYYY-MM-DD
}

export interface MidPeriodProrationResult {
  regularPay: number | null;
  otPay: number | null;
  /** Set when the resolved (reg, ot) rate changed WITHIN the period; null when a
   *  constant history rate merely overrode the cache. */
  change: MidPeriodRateChange | null;
  /**
   * The distinct per-day rates this function actually PAID at, in first-use order
   * (excluding the HSL weekend premium, which is a per-day addition, not a rate).
   *
   * Reported because the caller displays `regularRate`/`otRate` from the rates
   * CACHE while taking its pay from here — from dated history. When the two
   * disagree the statement advertises a rate it never paid, which is how a
   * ₱2,309.62 shortfall shipped looking perfectly reconciled. Handing the real
   * rates back lets `paystub-rate-consistency.ts` catch that exactly instead of
   * inferring it from the arithmetic.
   */
  regularRatesUsed: number[];
  otRatesUsed: number[];
  /** HSL weekend (Sat+Sun) portion of the pay above, accumulated per day at the
   *  exact same (rate + ₱15) each day paid at — so the paystub's weekend lines
   *  stay true across a mid-week rate change. All zeros for non-HSL. */
  weekend: { regularHours: number; otHours: number; regularPay: number; otPay: number };
  /**
   * Per-rate itemization of the pay, in pay order — the statement's basis line.
   * `regular`/`ot` cover the FULL week (HSL weekend premium money included in
   * the segment of the rate that paid it); `weekendRegular`/`weekendOt` carve
   * the Sat+Sun portion out per rate (empty for non-HSL), so a renderer can
   * derive weekday-only segments by subtraction, exactly like the statement's
   * weekday lines. Segment pay is rounded per segment (2dp) while the line
   * totals round once over the raw sum, so the two can drift by a centavo on
   * pathological fractions — hours + rate are the displayed basis, never the
   * per-segment pay.
   */
  segments: {
    regular: ProrationSegment[];
    ot: ProrationSegment[];
    weekendRegular: ProrationSegment[];
    weekendOt: ProrationSegment[];
  };
}

/**
 * Per-day prorated pay across a MID-PERIOD rate change. Returns null when the
 * resolved per-day (reg,ot) rate is CONSTANT across the period AND equals the
 * caller's cache/catalog fallback — so unchanged employees keep their existing
 * single-rate result, byte-identical. Only a genuine mid-period change (or a
 * constant history rate the cache disagrees with) produces an override.
 */
export function proratePayForMidPeriodChange(params: {
  days: Array<{ date: Date; seconds: number }>;
  isHsl: boolean;
  history: RateHistoryByEmail | undefined;
  histEmail: string | null;
  fallbackReg: number | null;
  fallbackOt: number | null;
}): MidPeriodProrationResult | null {
  const { days, isHsl, history, histEmail, fallbackReg, fallbackOt } = params;
  const empHist = history && histEmail ? history.get(histEmail) : undefined;
  if (!empHist || empHist.length === 0 || days.length === 0) return null;
  const regularRatesUsed: number[] = [];
  const otRatesUsed: number[] = [];
  const noteRate = (into: number[], v: number | null) => {
    if (v != null && Number.isFinite(v) && !into.includes(v)) into.push(v);
  };

  let usedRegSec = 0;
  let regularPayPHP = 0;
  let otPayPHP = 0;
  let wkndRegSec = 0;
  let wkndOtSec = 0;
  let wkndRegPayPHP = 0;
  let wkndOtPayPHP = 0;
  let anyReg = false;
  let anyOt = false;
  let firstReg: number | null | undefined;
  let firstOt: number | null | undefined;
  let change: MidPeriodRateChange | null = null;
  const regSegs: SegmentAcc = [];
  const otSegs: SegmentAcc = [];
  const wkndRegSegs: SegmentAcc = [];
  const wkndOtSegs: SegmentAcc = [];

  for (const d of days) {
    const resolved = resolveRateAsOfDate(empHist, d.date);
    const reg = resolved?.regularRate ?? fallbackReg;
    const ot = resolved?.otRate ?? fallbackOt;

    if (firstReg === undefined) {
      firstReg = reg;
      firstOt = ot;
    } else if (change === null && (reg !== firstReg || ot !== firstOt)) {
      change = {
        oldRegular: firstReg ?? null,
        newRegular: reg,
        oldOt: firstOt ?? null,
        newOt: ot,
        effectiveDate: fmtLocalIsoDate(d.date),
      };
    }

    const remaining = Math.max(0, REG_WEEK_CAP_SEC - usedRegSec);
    const dayRegSec = Math.min(d.seconds, remaining);
    const dayOtSec = d.seconds - dayRegSec;
    usedRegSec += dayRegSec;

    const dow = d.date.getDay();
    const isWeekendDay = isHsl && (dow === 0 || dow === 6);
    const weekendBonus = isWeekendDay ? 15 : 0;
    if (reg != null) {
      const dayRegPay = (dayRegSec / 3600) * (reg + weekendBonus);
      regularPayPHP += dayRegPay;
      if (isWeekendDay) {
        wkndRegSec += dayRegSec;
        wkndRegPayPHP += dayRegPay;
      }
      anyReg = true;
      // Only count a rate as "paid at" when it actually moved money on this day —
      // a zero-second day would otherwise smuggle in a rate nobody was paid.
      if (dayRegSec > 0) {
        noteRate(regularRatesUsed, reg);
        addToSegment(regSegs, reg, dayRegSec, dayRegPay);
        if (isWeekendDay) addToSegment(wkndRegSegs, reg, dayRegSec, dayRegPay);
      }
    }
    if (ot != null) {
      const dayOtPay = (dayOtSec / 3600) * (ot + weekendBonus);
      otPayPHP += dayOtPay;
      if (isWeekendDay) {
        wkndOtSec += dayOtSec;
        wkndOtPayPHP += dayOtPay;
      }
      anyOt = true;
      if (dayOtSec > 0) {
        noteRate(otRatesUsed, ot);
        addToSegment(otSegs, ot, dayOtSec, dayOtPay);
        if (isWeekendDay) addToSegment(wkndOtSegs, ot, dayOtSec, dayOtPay);
      }
    }
  }

  // Constant rate across the week: keep the caller's single-rate result ONLY when
  // that constant rate equals the fallback (the cache/catalog rate the caller
  // already used) — that path is byte-identical (incl. HSL premium rounding). If
  // the constant history rate DIFFERS from the cache (e.g. the cache lags a
  // future-dated change that only landed in employee_rate_history), override with
  // the history-resolved pay so the wizard matches Payment Dispatch, which always
  // reads history. No mid-week badge then (the rate didn't change WITHIN the week).
  if (!change && firstReg === fallbackReg && firstOt === fallbackOt) return null;

  return {
    regularPay: anyReg ? Math.round(regularPayPHP * 100) / 100 : null,
    otPay: anyOt ? Math.round(otPayPHP * 100) / 100 : null,
    change,
    regularRatesUsed,
    otRatesUsed,
    weekend: {
      regularHours: wkndRegSec / 3600,
      otHours: wkndOtSec / 3600,
      regularPay: Math.round(wkndRegPayPHP * 100) / 100,
      otPay: Math.round(wkndOtPayPHP * 100) / 100,
    },
    segments: {
      regular: finalizeSegments(regSegs),
      ot: finalizeSegments(otSegs),
      weekendRegular: finalizeSegments(wkndRegSegs),
      weekendOt: finalizeSegments(wkndOtSegs),
    },
  };
}
