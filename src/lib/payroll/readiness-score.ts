/**
 * The Payroll Readiness score — pure, framework-free scoring logic split out of
 * `payroll-readiness.ts` (which is `server-only` and pulls in Supabase) so it
 * can be unit-tested and reused on either side of the wire. No I/O, no DB, no
 * `server-only`: just numbers in → score out.
 *
 * Blocker-weighted: no-pay-rate is the hard blocker (half the weight); KPI
 * submission and missing bank info split the rest; onboarding exceptions are
 * excluded entirely (expected non-payments never cost points).
 */

/** One weighted contributor to the readiness score — surfaced so the UI can show
 *  the breakdown ("what's costing you points"). `coverage` is 0–1 (informational);
 *  `weight` is the share of the total score it can contribute; `points` is its
 *  actual earned contribution (floored so any open item shows a shortfall, and
 *  pinned low for a hard blocker). The three components' `points` sum exactly to
 *  the score `value` — the breakdown always reconciles to the headline. */
export interface ReadinessScoreComponent {
  key: 'rate' | 'kpi' | 'bank';
  label: string;
  /** 0–1 completeness for this dimension (1 = fully clear). */
  coverage: number;
  /** Share of the 100-point total this dimension can contribute. */
  weight: number;
  /** Actual points earned (see the interface note — floored / blocker-pinned). */
  points: number;
  /** Max points if fully clear = round(weight × 100). */
  maxPoints: number;
  /** How many items are still open for this dimension (0 = clear). */
  open: number;
  /** 0–100 monitoring percent for this dimension — the display form of
   *  `coverage`, with the same honesty rule as the points: exactly 100 only
   *  when nothing is open, otherwise floored (and capped at 99) so "1 missing
   *  of 500" can never round back up to a clean 100%. */
  percent: number;
}

/** The blocker-weighted Payroll Readiness score. 100 = everything settled.
 *  No-pay-rate is the hard blocker (heaviest weight); KPI submission and missing
 *  bank info are medium; onboarding exceptions never lower the score. */
export interface ReadinessScore {
  /** 0–100. Equals the sum of the component points. */
  value: number;
  /** Coarse band for tone/label. */
  grade: 'ready' | 'almost' | 'at_risk' | 'blocked';
  components: ReadinessScoreComponent[];
}

/** Blocker-weighted split of the 100-point score. No-pay-rate is the hard
 *  blocker and carries half the weight; KPI submission and missing bank info
 *  split the rest evenly. Exceptions are excluded entirely. Kept as a table so
 *  the weights stay in one obvious place. */
export const SCORE_WEIGHTS = { rate: 0.5, kpi: 0.25, bank: 0.25 } as const;

/** Points a hard blocker (any missing rate) forces the rate dimension DOWN to,
 *  no matter how proportionally small it is: a no-rate worker literally can't be
 *  paid, so the rate dimension can never read near-full while one is open. This
 *  keeps the score well below 100 for any blocker and keeps the breakdown honest
 *  (the rate chip shows a real shortfall, not 49/50). Chosen so a blocker alone
 *  caps the total at 10(rate)+25(kpi)+25(bank)=60. */
const BLOCKED_RATE_POINTS = 10;

/**
 * Compute the blocker-weighted readiness score from the already-built signals.
 *
 * Each dimension earns points out of its weighted max (rate 50, kpi 25, bank 25;
 * exceptions excluded — expected non-payments never cost points). The headline
 * `value` is the SUM of the component points, so the breakdown always reconciles
 * to the number shown; there is no separately-rounded total to drift from it.
 *
 * Two honesty rules the raw proportion alone wouldn't give:
 *   - Any OPEN item floors its dimension below full, and the total below 100 —
 *     `Math.floor` on partial coverage means "1 missing of 500" reads 49, never
 *     rounds back up to 50, so the score can only reach 100 when truly clear.
 *   - Any missing rate (hard blocker) pins the rate dimension to
 *     BLOCKED_RATE_POINTS regardless of proportion, and forces the 'blocked'
 *     grade — a no-rate worker can't be paid, so it dominates.
 */
export function computeReadinessScore(args: {
  workerCount: number;
  missingRates: number;
  kpiDue: number;
  kpiSubmitted: number;
  bankEligibleCount: number;
  missingBank: number;
}): ReadinessScore {
  const coverage = (missing: number, total: number) =>
    total <= 0 ? 1 : Math.max(0, Math.min(1, 1 - missing / total));

  const rateCov = coverage(args.missingRates, args.workerCount);
  const kpiCov = args.kpiDue <= 0 ? 1 : Math.max(0, Math.min(1, args.kpiSubmitted / args.kpiDue));
  const bankCov = coverage(args.missingBank, args.bankEligibleCount);

  // Points per dimension, floored so any open item shows a shortfall (never
  // rounds back to full). `open === 0` short-circuits to the full max so a
  // fully-clear dimension is exactly its max even under float noise.
  const earn = (cov: number, weight: number, open: number) => {
    const max = Math.round(weight * 100);
    return open === 0 ? max : Math.min(max, Math.floor(cov * max));
  };

  const rateOpen = args.missingRates;
  const kpiOpen = Math.max(0, args.kpiDue - args.kpiSubmitted);
  const bankOpen = args.missingBank;

  // Hard blocker: any missing rate pins the rate dimension to a fixed low score,
  // so the breakdown (and the total) reflect "blocked" honestly.
  const rateMax = Math.round(SCORE_WEIGHTS.rate * 100);
  const ratePoints = rateOpen > 0 ? Math.min(BLOCKED_RATE_POINTS, rateMax) : rateMax;

  const mk = (
    key: ReadinessScoreComponent['key'],
    label: string,
    cov: number,
    weight: number,
    open: number,
    points: number,
  ): ReadinessScoreComponent => ({
    key,
    label,
    coverage: cov,
    weight,
    points,
    maxPoints: Math.round(weight * 100),
    open,
    // Same honesty rule as the points: 100% only when truly clear; any open
    // item floors (and caps at 99) so it never rounds back up to full.
    percent: open === 0 ? 100 : Math.min(99, Math.floor(cov * 100)),
  });

  const components = [
    mk('rate', 'Pay rates', rateCov, SCORE_WEIGHTS.rate, rateOpen, ratePoints),
    mk('kpi', 'KPI submission', kpiCov, SCORE_WEIGHTS.kpi, kpiOpen, earn(kpiCov, SCORE_WEIGHTS.kpi, kpiOpen)),
    mk('bank', 'Bank info', bankCov, SCORE_WEIGHTS.bank, bankOpen, earn(bankCov, SCORE_WEIGHTS.bank, bankOpen)),
  ];

  // The headline IS the sum of the component points, so the breakdown always
  // adds up to it exactly.
  const value = components.reduce((s, c) => s + c.points, 0);

  // Grade keys off ACTUAL open items, not the rounded value: any blocker →
  // 'blocked'; fully clear → 'ready'; otherwise band by the value.
  const anyOpen = rateOpen > 0 || kpiOpen > 0 || bankOpen > 0;
  const grade: ReadinessScore['grade'] =
    rateOpen > 0
      ? 'blocked'
      : !anyOpen
        ? 'ready'
        : value >= 85
          ? 'almost'
          : 'at_risk';

  return { value, grade, components };
}
