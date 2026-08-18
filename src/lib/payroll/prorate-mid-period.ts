import type { CatalogNativeRate, RateHistoryByEmail } from './rate-history-resolve';
import { historyMatchesCatalogAsOf, resolveRateAsOfDate } from './rate-history-resolve';
import {
  computeHoganWeekPay,
  HSL_WEEKEND_PREMIUM_PHP,
  OT_DIFFERENTIAL_MULTIPLIER,
} from './hogan-week-pay';

/**
 * Client-safe per-day proration across a MID-PERIOD rate change (a department
 * transfer, a dated raise). Extracted verbatim from PayrollWizard.tsx so the
 * engine is pure + unit-tested; the wizard imports it back. It mirrors the
 * server dispatch compute (`computeProratedRowPay` in current-pay.ts) EXACTLY:
 * raw per-day accumulation rounded once at the end.
 *
 * 2026-08-11 (Kane): HSL pays the Hogan sheet's three-stage form, per day —
 * see hogan-week-pay.ts for the single-rate weekly authority. Every HSL hour
 * is base-paid once at that day's REGULAR rate (M–F hours never re-rate on
 * their own); ALL Sat+Sun hours add the +₱15/h premium, past-cap included; and
 * overtime money is ONLY the derived differential — chronological past-40h
 * hours × (0.5 × that day's regular rate). The stored OT rate is NOT a money
 * input for HSL (an off-ratio stored rate can no longer misprice OT). The
 * weekend carve-out therefore covers ALL weekend hours; its OT half stays
 * structurally zero (kept in the shapes so payloads staged before 2026-08-07
 * still parse and render exactly as staged). Non-HSL rows are untouched:
 * 40h-cap regular bucket at the regular rate, past-cap bucket at the stored
 * OT rate.
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
  /** HSL weekend (Sat+Sun) portion of the pay above — ALL weekend hours since
   *  2026-08-11 (past-cap included), accumulated per day at the exact same
   *  (rate + ₱15) each day paid at — so the paystub's weekend line stays true
   *  across a mid-week rate change. All zeros for non-HSL. `otHours`/`otPay`
   *  are ALWAYS zero (the differential is the Overtime line's money, never a
   *  weekend sub-bucket); the fields survive for shape-compatibility with
   *  payloads staged before 2026-08-07. */
  weekend: { regularHours: number; otHours: number; regularPay: number; otPay: number };
  /**
   * Per-rate itemization of the pay, in pay order — the statement's basis line.
   * `regular`/`ot` cover the FULL week (HSL weekend premium money included in
   * the segment of the rate that paid it); `weekendRegular` carves the Sat+Sun
   * regular-bucket portion out per rate (empty for non-HSL), so a renderer can
   * derive weekday-only segments by subtraction, exactly like the statement's
   * weekday lines. `weekendOt` is always empty since 2026-08-07 (weekend OT is
   * plain overtime, no carve). Segment pay is rounded per segment (2dp) while the line
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

/** One distinct regular rate's raw seconds within a changed week. `weekendSec`
 *  is the premium-bearing (in-scope HSL Sat+Sun) share of the same seconds;
 *  out-of-scope weekend time (before an `hslFrom` transfer date) belongs in
 *  `weekdaySec` — it pays plain rate. */
export interface ChangedWeekRateLeg {
  ratePhp: number;
  weekdaySec: number;
  weekendSec: number;
}

/** Non-HSL only: a chronological past-cap bucket at the stored OT rate. */
export interface ChangedWeekOtLeg {
  ratePhp: number;
  sec: number;
}

/**
 * Price a week whose rate genuinely CHANGED mid-period, at the statement's own
 * granularity: every leg is 2dp HOURS × rate (Kane, 2026-08-18 — "when
 * multiplying, only do 2 decimals"), so the per-rate basis line a paystub
 * prints multiplies out to the money to the centavo. Line totals are the sum
 * of the displayed legs — never a raw-seconds figure the reader can't rebuild.
 *
 * HSL overtime on a changed week (ruling 2026-08-18, "doc stands"): the 40h
 * threshold counts ALL hours worked that pay week — the pre-transfer days
 * included. (The Hogan sheet's AK/AL transition columns exclude the old-rate
 * hours from its OT threshold; that reading was REJECTED — HRIS deliberately
 * pays more than the sheet on transition weeks.) OT hours are derived from the
 * rounded totals exactly like `computeHoganWeekPay` (`r2(total) − 40`) and are
 * attributed to rates newest-first — past-cap hours are chronologically the
 * last hours of the week, which on a transfer/raise sit at the newest rate.
 *
 * Shared by BOTH engines (the wizard's `proratePayForMidPeriodChange` and
 * Dispatch's `computeProratedRowPay`) so their changed-week centavos can never
 * drift.
 */
export function priceChangedWeek2dp(params: {
  isHsl: boolean;
  /** Per-rate legs in first-use (pay) order. */
  legs: ChangedWeekRateLeg[];
  /** Non-HSL stored-rate OT buckets. Ignored for HSL (differential derived). */
  otLegs: ChangedWeekOtLeg[];
  weekendPremiumPhp?: number;
}): {
  regularPay: number;
  otPay: number;
  regularSegments: ProrationSegment[];
  otSegments: ProrationSegment[];
  weekendRegularSegments: ProrationSegment[];
  weekendRegularHours: number;
  weekendRegularPay: number;
} {
  const premium = params.weekendPremiumPhp ?? HSL_WEEKEND_PREMIUM_PHP;
  const legs = params.legs
    .map((l) => {
      const wd = round2(l.weekdaySec / 3600);
      const we = round2(l.weekendSec / 3600);
      const wdPay = round2(wd * l.ratePhp);
      const wePay = round2(we * round2(l.ratePhp + premium));
      return {
        rate: l.ratePhp,
        we,
        wePay,
        hours: round2(wd + we),
        pay: round2(wdPay + wePay),
      };
    })
    .filter((l) => l.hours > 0);

  const regularPay = round2(legs.reduce((s, l) => s + l.pay, 0));
  const regularSegments: ProrationSegment[] = legs.map((l) => ({
    ratePhp: l.rate,
    hours: l.hours,
    payPhp: l.pay,
  }));
  const weekendRegularSegments: ProrationSegment[] = legs
    .filter((l) => l.we > 0)
    .map((l) => ({ ratePhp: l.rate, hours: l.we, payPhp: l.wePay }));
  const weekendRegularHours = round2(legs.reduce((s, l) => s + l.we, 0));
  const weekendRegularPay = round2(legs.reduce((s, l) => s + l.wePay, 0));

  let otSegments: ProrationSegment[];
  if (params.isHsl) {
    // Sheet-form OT derivation on the ROUNDED totals (all rates, all 7 days),
    // attributed newest-rate-first. Walking legs in reverse first-use order
    // matches chronology for the monotone changes transfers/raises produce; a
    // pathological A→B→A week attributes OT to the most recently introduced
    // rate first, which is still the newest money in the week.
    const totalHours = round2(legs.reduce((s, l) => s + l.hours, 0));
    let otLeft = round2(Math.max(0, totalHours - REG_WEEK_CAP_SEC / 3600));
    const reversed: ProrationSegment[] = [];
    for (let i = legs.length - 1; i >= 0 && otLeft > 0; i--) {
      const take = round2(Math.min(otLeft, legs[i].hours));
      if (take <= 0) continue;
      const otRate = round2(legs[i].rate * OT_DIFFERENTIAL_MULTIPLIER);
      reversed.push({ ratePhp: otRate, hours: take, payPhp: round2(take * otRate) });
      otLeft = round2(otLeft - take);
    }
    otSegments = reversed.reverse();
  } else {
    otSegments = params.otLegs
      .map((l) => {
        const h = round2(l.sec / 3600);
        return { ratePhp: l.ratePhp, hours: h, payPhp: round2(h * l.ratePhp) };
      })
      .filter((s) => s.hours > 0);
  }
  const otPay = round2(otSegments.reduce((s, x) => s + x.payPhp, 0));

  return {
    regularPay,
    otPay,
    regularSegments,
    otSegments,
    weekendRegularSegments,
    weekendRegularHours,
    weekendRegularPay,
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
  /**
   * Day-scoped HSL-ness for a mid-week transfer INTO HSL (see
   * `resolveHslWeekScope`): weekend days BEFORE this date pay plain rate on the
   * Regular line (no +15, no weekend carve); on/after it the full weekend
   * treatment applies. Null/omitted = HSL all week (unchanged behavior).
   * Ignored when `isHsl` is false.
   */
  hslFrom?: Date | null;
  history: RateHistoryByEmail | undefined;
  histEmail: string | null;
  fallbackReg: number | null;
  fallbackOt: number | null;
  /**
   * The employee's INDIVIDUAL Payment Catalog rate in its native currency, when
   * one exists. A catalog-managed person prorates ONLY when their dated history
   * is catalog-consistent as of the last worked day (see
   * `historyMatchesCatalogAsOf`) — the history is then catalog-authored and
   * resolving per-day from it merely replays the catalog's own timeline. Any
   * disagreement (stale structure, stale history, non-PHP currency) returns
   * null so the caller keeps the flat-at-catalog path, exactly matching
   * Dispatch's `computeProratedRowPay` rateOverride behavior. Omit/null for
   * people without an individual structure — history prorates as always.
   */
  catalogRate?: CatalogNativeRate | null;
}): MidPeriodProrationResult | null {
  const { days, isHsl, hslFrom, history, histEmail, fallbackReg, fallbackOt, catalogRate } = params;
  const empHist = history && histEmail ? history.get(histEmail) : undefined;
  if (!empHist || empHist.length === 0 || days.length === 0) return null;

  if (catalogRate) {
    // Last day money actually moved — the week's terminal rate must be the one
    // the catalog decrees, or the sources disagree and the flat path stands.
    const lastWorked = days.reduce<Date | null>(
      (acc, d) => (d.seconds > 0 && (!acc || d.date.getTime() > acc.getTime()) ? d.date : acc),
      null,
    );
    if (!lastWorked || !historyMatchesCatalogAsOf(empHist, catalogRate, lastWorked)) return null;
  }
  const regularRatesUsed: number[] = [];
  const otRatesUsed: number[] = [];
  const noteRate = (into: number[], v: number | null) => {
    if (v != null && Number.isFinite(v) && !into.includes(v)) into.push(v);
  };

  let usedRegSec = 0;
  let regularPayPHP = 0;
  let otPayPHP = 0;
  let wkndRegSec = 0;
  let wkndRegPayPHP = 0;
  let anyReg = false;
  let anyOt = false;
  let firstReg: number | null | undefined;
  let firstOt: number | null | undefined;
  let change: MidPeriodRateChange | null = null;
  const regSegs: SegmentAcc = [];
  const otSegs: SegmentAcc = [];
  const wkndRegSegs: SegmentAcc = [];
  // Sheet-form bookkeeping (HSL): M-F vs weekend seconds, for the exact
  // 2dp-hours sheet recomputation when the whole week paid at one rate.
  let mfSec = 0;
  let totalSecAll = 0;

  for (const d of days) {
    const resolved = resolveRateAsOfDate(empHist, d.date);
    const reg = resolved?.regularRate ?? fallbackReg;
    // HSL overtime money is the DERIVED differential — 0.5 × the day's regular
    // rate (the sheet's AG column; Kane 2026-08-11) — never a stored OT rate,
    // so an off-ratio stored value cannot misprice OT. Non-HSL keeps the
    // stored/fallback OT rate exactly as before.
    const ot = isHsl
      ? reg != null
        ? round2(reg * OT_DIFFERENTIAL_MULTIPLIER)
        : null
      : resolved?.otRate ?? fallbackOt;

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
    // Day-scoped HSL-ness: a weekend day worked BEFORE a mid-week transfer into
    // HSL is an old-department day — plain rate, no weekend carve.
    const isWeekendDay =
      isHsl && (dow === 0 || dow === 6) && (!hslFrom || d.date.getTime() >= hslFrom.getTime());
    const weekendBonus = isWeekendDay ? HSL_WEEKEND_PREMIUM_PHP : 0;
    totalSecAll += d.seconds;
    if (isHsl && !isWeekendDay) mfSec += d.seconds;
    // HSL base-pays EVERY hour once (the sheet's AB/AD columns include the
    // past-cap hours; the differential rides on top). Non-HSL base-pays only
    // the 40h-capped bucket, with the rest priced at the stored OT rate below.
    const dayBaseSec = isHsl ? d.seconds : dayRegSec;
    if (reg != null) {
      const dayRegPay = (dayBaseSec / 3600) * (reg + weekendBonus);
      regularPayPHP += dayRegPay;
      if (isWeekendDay) {
        wkndRegSec += dayBaseSec;
        wkndRegPayPHP += dayRegPay;
      }
      anyReg = true;
      // Only count a rate as "paid at" when it actually moved money on this day —
      // a zero-second day would otherwise smuggle in a rate nobody was paid.
      if (dayBaseSec > 0) {
        noteRate(regularRatesUsed, reg);
        addToSegment(regSegs, reg, dayBaseSec, dayRegPay);
        if (isWeekendDay) addToSegment(wkndRegSegs, reg, dayBaseSec, dayRegPay);
      }
    }
    if (ot != null) {
      // For HSL `ot` is the 0.5× differential on the chronological past-cap
      // hours — the +15 premium already rode in on the base leg above, so the
      // weekend buckets never carve OT money. For non-HSL this is the plain
      // stored-rate OT bucket, unchanged.
      const dayOtPay = (dayOtSec / 3600) * ot;
      otPayPHP += dayOtPay;
      anyOt = true;
      if (dayOtSec > 0) {
        noteRate(otRatesUsed, ot);
        addToSegment(otSegs, ot, dayOtSec, dayOtPay);
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
  // HSL compares the REGULAR rate only: its OT is derived from the regular rate,
  // so the caller's stored fallbackOt carries no independent signal — comparing
  // it would force every HSL week off the sheet-exact single-rate path.
  const fallbackOtEff = isHsl
    ? fallbackReg != null
      ? round2(fallbackReg * OT_DIFFERENTIAL_MULTIPLIER)
      : null
    : fallbackOt;
  if (!change && firstReg === fallbackReg && firstOt === fallbackOtEff) return null;

  // Single-rate HSL week (a constant history rate overriding a stale cache):
  // return the EXACT Hogan sheet computation — 2dp hours × rate per leg — so
  // this override path stages the same centavos as the caller's
  // computeHoganWeekPay single-rate path and the server engine. Per-day
  // accumulation remains only for genuine mid-week changes, which the sheet
  // itself cannot express in one rate.
  if (isHsl && !change && anyReg && regularRatesUsed.length === 1) {
    const r0 = regularRatesUsed[0];
    const sheet = computeHoganWeekPay({
      mfHours: mfSec / 3600,
      weHours: wkndRegSec / 3600,
      regularRatePhp: r0,
    });
    const regularPay = round2(sheet.basePayPhp + sheet.weekendPayPhp);
    return {
      regularPay,
      otPay: sheet.otDifferentialPayPhp,
      change: null,
      regularRatesUsed: [r0],
      otRatesUsed: sheet.otHours > 0 ? [sheet.otDifferentialPhp] : [],
      weekend: {
        regularHours: wkndRegSec / 3600,
        otHours: 0,
        regularPay: sheet.weekendPayPhp,
        otPay: 0,
      },
      segments: {
        regular:
          totalSecAll > 0 ? [{ ratePhp: r0, hours: round2(totalSecAll / 3600), payPhp: regularPay }] : [],
        ot:
          sheet.otHours > 0
            ? [{ ratePhp: sheet.otDifferentialPhp, hours: sheet.otHours, payPhp: sheet.otDifferentialPayPhp }]
            : [],
        weekendRegular:
          wkndRegSec > 0
            ? [{ ratePhp: r0, hours: round2(wkndRegSec / 3600), payPhp: sheet.weekendPayPhp }]
            : [],
        weekendOt: [],
      },
    };
  }

  // A GENUINE mid-period change prices at the statement's granularity: 2dp
  // hours × rate per leg, HSL OT from the rounded totals (all hours count —
  // ruling 2026-08-18). The displayed basis line then multiplies out to the
  // money exactly, instead of drifting centavos from a raw-seconds sum.
  if (change !== null) {
    const wkndSecByRate = new Map(wkndRegSegs.map((s) => [s.rate, s.sec]));
    const priced = priceChangedWeek2dp({
      isHsl,
      legs: regSegs.map((s) => {
        const weekendSec = wkndSecByRate.get(s.rate) ?? 0;
        return { ratePhp: s.rate, weekdaySec: s.sec - weekendSec, weekendSec };
      }),
      otLegs: otSegs.map((s) => ({ ratePhp: s.rate, sec: s.sec })),
    });
    return {
      regularPay: anyReg ? priced.regularPay : null,
      otPay: anyOt ? priced.otPay : null,
      change,
      regularRatesUsed,
      // HSL OT is attributed from the rounded totals above, so report the
      // differential rates that attribution actually paid at.
      otRatesUsed: isHsl
        ? priced.otSegments.map((s) => s.ratePhp).filter((v, i, a) => a.indexOf(v) === i)
        : otRatesUsed,
      weekend: {
        regularHours: priced.weekendRegularHours,
        otHours: 0,
        regularPay: priced.weekendRegularPay,
        otPay: 0,
      },
      segments: {
        regular: priced.regularSegments,
        ot: priced.otSegments,
        weekendRegular: priced.weekendRegularSegments,
        weekendOt: [],
      },
    };
  }

  // Constant history rate overriding a stale cache (non-HSL — the HSL twin
  // returned the sheet computation above): keep the original raw-seconds
  // accumulation, byte-identical to what this path always staged.
  return {
    regularPay: anyReg ? Math.round(regularPayPHP * 100) / 100 : null,
    otPay: anyOt ? Math.round(otPayPHP * 100) / 100 : null,
    change,
    regularRatesUsed,
    otRatesUsed,
    weekend: {
      regularHours: wkndRegSec / 3600,
      otHours: 0,
      regularPay: Math.round(wkndRegPayPHP * 100) / 100,
      otPay: 0,
    },
    segments: {
      regular: finalizeSegments(regSegs),
      ot: finalizeSegments(otSegs),
      weekendRegular: finalizeSegments(wkndRegSegs),
      weekendOt: [],
    },
  };
}
