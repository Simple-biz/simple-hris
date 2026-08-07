/**
 * The invariant nobody was enforcing: a pay statement may never advertise an
 * hourly rate it did not actually pay.
 *
 * Why this exists — the Jul 19–25 2026 stub that started it:
 *
 *     Regular Hours   40.00h × ₱225.00      ₱7,000.00
 *     Overtime         4.14h × ₱337.50      ₱1,087.63
 *
 * 40 × 225 is ₱9,000, not ₱7,000. Every amount on that stub was in fact computed
 * at ₱175.00/h (7000/40 = 175 exactly; 1087.63 / (175 × 1.5) = 4.1434h ≈ "4.14"),
 * while the displayed rate came from a different table. The two hourly-rate
 * sources had drifted apart:
 *
 *   - `rates_php.*` (DISPLAYED)  ← `employee_hourly_rates`, the current sheet
 *   - `pay_php.*`   (PAID)       ← `employee_rate_history`, resolved as-of each day
 *
 * `computeProratedRowPay` (current-pay.ts) and `proratePayForMidPeriodChange`
 * (PayrollWizard.tsx) both pay per-day from history and treat the sheet only as a
 * FALLBACK for dates history doesn't cover. So a stale/missing history row silently
 * wins over a raise that only ever landed on the sheet. The total still tied out to
 * the sum of the line amounts, so nothing downstream noticed — the statement was
 * internally consistent and externally wrong.
 *
 * This module makes that class of drift loud instead of silent. It is PURE and
 * dependency-free so the wizard (client) and the dispatch APIs (server) can run the
 * identical check on the identical object.
 *
 * IMPORTANT — it deliberately does NOT "fix" a mismatch by rewriting the displayed
 * rate to match the pay. When the two sources disagree, neither is provably right
 * from inside this function: the sheet may hold a real raise that history is missing
 * (an UNDERPAYMENT owed to the employee), or history may hold a correct dated rate
 * the sheet has run ahead of. Silently displaying whatever was paid would convert a
 * visible ₱2,309.62 shortfall into an invisible one. So: report, refuse to dispatch,
 * let a human resolve the source data.
 */

/**
 * Pay lines that carry an hours × rate basis. Bonuses/adjustments have none.
 *
 * The weekend check was added 2026-08-04 after a preview stub printed
 *
 *     Weekend Hours    8.10h × ₱370.00      ₱1,944.60
 *
 * and passed this guard untouched. 8.10 × 370 is ₱2,997.00; ₱1,944.60 is 8.10 × ₱240
 * (a stale ₱225 base + the ₱15 premium) — a ₱1,053.33 shortfall on a stub that was
 * about to be sent. It slipped because the guard only ever inspected `regular` and
 * `ot`, while the weekend carve-out renders its own hours × rate line.
 *
 * 2026-08-07: the statement now renders ONE merged "Weekend Hours" line whose
 * basis itemizes the regular/OT buckets per premium-inclusive rate, so both
 * bucket checks report under the single `weekend` line id. Each bucket keeps
 * its OWN tight arithmetic check — merging them into one sum would let a
 * shortfall in one bucket hide behind a surplus in the other.
 */
export type RateLine = 'regular' | 'ot' | 'weekend';

export interface RateConsistencyIssue {
  line: RateLine;
  hours: number;
  /** The rate the statement would DISPLAY (from `rates_php`). */
  displayedRate: number;
  /** What the line would pay at the displayed rate: hours × displayedRate. */
  payAtDisplayedRate: number;
  /** What the line actually pays (from `pay_php`). */
  actualPay: number;
  /**
   * `payAtDisplayedRate - actualPay`, 2dp. POSITIVE means the employee was paid
   * LESS than the displayed rate implies — money owed. Negative means more.
   */
  deltaPhp: number;
  /** `actualPay / hours` — the rate the money was really computed at, 4dp. */
  impliedRate: number | null;
  /**
   * The distinct per-day rates the pay engine actually applied, when the caller
   * knows them. Exact evidence; empty when unavailable.
   */
  ratesPaid: number[];
  /** How this was detected — `rates-paid` is exact, `implied-rate` is inferred. */
  basis: 'rates-paid' | 'implied-rate';
  severity: 'error' | 'warning';
  /** Human-readable one-liner for the wizard UI / API error body. */
  message: string;
}

export interface RateConsistencyInput {
  hours: { regular?: number | null; ot?: number | null } | null | undefined;
  ratesPhp: { regular?: number | null; ot?: number | null } | null | undefined;
  payPhp: { regular?: number | null; ot?: number | null } | null | undefined;
  /**
   * Distinct per-day rates the engine actually applied, in first-use order. When
   * supplied this is the authoritative signal and needs no tolerance guessing:
   * a displayed rate that is not among them was never paid.
   */
  ratesPaid?: { regular?: number[] | null; ot?: number[] | null } | null;
  /**
   * HSL staff earn a +₱15/h weekend premium folded into per-day pay, so their pay
   * legitimately EXCEEDS hours × rate. Overpayment headroom is widened rather than
   * flagged. Never widens the underpayment side.
   */
  isHsl?: boolean;
  /**
   * A genuine dated rate change inside the pay week makes pay a blend of two
   * rates, so a single displayed rate legitimately won't reproduce it. Downgrades
   * an inferred mismatch to a warning; an exact `ratesPaid` conflict still errors.
   */
  hasMidPeriodChange?: boolean;
  /**
   * The HSL weekend carve-out block, when the statement renders one. Its lines show
   * their OWN hours × rate, at `base rate + premium`, so they need checking too —
   * that is the hole the 2026-08-04 ₱1,053.33 stub walked through.
   *
   * Only `hours` and `payPhp` are supplied: the displayed weekend rate is DERIVED here
   * exactly as the statement derives it (`ratesPhp.* + premiumPhpPerHour`), so a caller
   * cannot accidentally hand us a rate the stub never showed.
   */
  weekend?: {
    hours?: { regular?: number | null; ot?: number | null } | null;
    payPhp?: { regular?: number | null; ot?: number | null } | null;
    /** Defaults to the ₱15 HSL rule when omitted. */
    premiumPhpPerHour?: number | null;
    /**
     * The proration block's per-day weekend segments (BASE rates, premium not
     * yet added), when a mid-week rate change staged them.
     *
     * These take over the check because they are what the stub SHOWS: the
     * statement's `weekendBasis` (paystub-view.ts) prefers the segments over the
     * `ratesPhp`-derived bucket rates, so without them this guard validates a
     * rate the employee never sees. That cut both ways — it warned on reat@'s
     * correct ₱250 line against a phantom ₱240, and it could not have caught a
     * genuinely wrong ₱250. Each segment states ONE rate against ONE amount, so
     * each is checked on its own; netting them would let a shortfall on one rate
     * hide behind a surplus on another.
     *
     * Empty/absent → the bucket check runs exactly as before.
     */
    segments?: {
      regular?: Array<{ ratePhp: number; hours: number; payPhp: number }> | null;
      ot?: Array<{ ratePhp: number; hours: number; payPhp: number }> | null;
    } | null;
  } | null;
}

/** Rounding slack. Per-day accumulation rounds once at the end, so allow a cent or two. */
const ROUNDING_TOLERANCE_PHP = 0.05;
/** The HSL Sat/Sun premium, PHP per hour — the only sanctioned reason pay exceeds hours × rate. */
const HSL_WEEKEND_PREMIUM_PHP_PER_HOUR = 15;
/** Rates are money; compare to the centavo. */
const RATE_EPSILON = 0.005;

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function money(n: number): string {
  return `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function includesRate(rates: number[], rate: number): boolean {
  return rates.some((r) => Math.abs(r - rate) <= RATE_EPSILON);
}

const LINE_LABELS: Record<RateLine, string> = {
  regular: 'Regular Hours',
  ot: 'Overtime',
  weekend: 'Weekend Hours',
};

function checkLine(
  line: RateLine,
  hoursRaw: unknown,
  rateRaw: unknown,
  payRaw: unknown,
  ratesPaidRaw: number[] | null | undefined,
  /**
   * Whether pay is allowed to EXCEED hours × rate by up to ₱15/h.
   *
   * True for the `regular`/`ot` lines of an HSL employee, where the weekend premium is
   * folded into the line's pay but not into its displayed rate.
   *
   * FALSE for the `weekend-*` lines even on HSL, because their displayed rate ALREADY
   * includes the premium. Granting headroom there would re-open the exact hole this
   * check was extended to close.
   */
  allowPremiumHeadroom: boolean,
  hasMidPeriodChange: boolean,
): RateConsistencyIssue | null {
  const hours = finite(hoursRaw);
  const rate = finite(rateRaw);
  const pay = finite(payRaw);

  // No basis to check: a line with no hours (pure bonus week), no rate on file, or
  // no computed pay is not a mismatch — it's an absence. Those are other checks'
  // business (Readiness flags missing rates).
  if (hours == null || rate == null || pay == null) return null;
  if (hours <= 0) return null;
  // A zero rate carries no claim, so there is nothing to contradict.
  if (rate <= 0) return null;

  const payAtDisplayedRate = round(hours * rate, 2);
  const deltaPhp = round(payAtDisplayedRate - pay, 2);
  const impliedRate = round(pay / hours, 4);
  const ratesPaid = (ratesPaidRaw ?? []).filter((r): r is number => finite(r) != null);

  const label = LINE_LABELS[line];

  // ── Exact path: we know the rates the engine applied. ──
  if (ratesPaid.length > 0) {
    if (includesRate(ratesPaid, rate)) return null; // displayed rate was genuinely used
    const paidList = ratesPaid.map((r) => money(r)).join(' + ');
    return {
      line,
      hours,
      displayedRate: rate,
      payAtDisplayedRate,
      actualPay: pay,
      deltaPhp,
      impliedRate,
      ratesPaid,
      basis: 'rates-paid',
      severity: 'error',
      message:
        `${label}: statement shows ${money(rate)}/h but the pay was computed at ` +
        `${paidList}/h. ${hours.toFixed(2)}h at ${money(rate)}/h is ` +
        `${money(payAtDisplayedRate)}, not ${money(pay)} — a ` +
        `${deltaPhp > 0 ? 'shortfall' : 'surplus'} of ${money(Math.abs(deltaPhp))}.`,
    };
  }

  // ── Inferred path: compare the implied rate against the displayed one. ──
  // Underpayment side is tight — nothing legitimately pays BELOW the displayed rate.
  // Overpayment side is widened by the HSL weekend premium, which can lift every
  // hour in the line by up to ₱15.
  const overHeadroom =
    ROUNDING_TOLERANCE_PHP +
    (allowPremiumHeadroom ? HSL_WEEKEND_PREMIUM_PHP_PER_HOUR * hours : 0);

  const underpaid = deltaPhp > ROUNDING_TOLERANCE_PHP;
  const overpaid = -deltaPhp > overHeadroom;
  if (!underpaid && !overpaid) return null;

  // A real mid-period rate change blends two rates, so a single displayed rate is
  // expected not to reproduce the pay. Still worth surfacing, but not a blocker.
  const severity: 'error' | 'warning' = hasMidPeriodChange ? 'warning' : 'error';
  const because = hasMidPeriodChange
    ? ' A dated rate change lands inside this pay week, so a blended rate may be correct — confirm the displayed rate represents the week.'
    : '';

  return {
    line,
    hours,
    displayedRate: rate,
    payAtDisplayedRate,
    actualPay: pay,
    deltaPhp,
    impliedRate,
    ratesPaid,
    basis: 'implied-rate',
    severity,
    message:
      `${label}: ${hours.toFixed(2)}h × ${money(rate)}/h is ${money(payAtDisplayedRate)}, ` +
      `but the line pays ${money(pay)} — implying ${money(impliedRate)}/h, a ` +
      `${deltaPhp > 0 ? 'shortfall' : 'surplus'} of ${money(Math.abs(deltaPhp))}.${because}`,
  };
}

/**
 * Check one employee's pay lines for displayed-rate / paid-rate drift.
 * Returns [] when consistent. Never throws.
 */
export function findRateConsistencyIssues(
  input: RateConsistencyInput,
): RateConsistencyIssue[] {
  const { hours, ratesPhp, payPhp, ratesPaid, isHsl, hasMidPeriodChange, weekend } = input ?? {};
  const out: RateConsistencyIssue[] = [];
  const reg = checkLine(
    'regular',
    hours?.regular,
    ratesPhp?.regular,
    payPhp?.regular,
    ratesPaid?.regular,
    !!isHsl,
    !!hasMidPeriodChange,
  );
  if (reg) out.push(reg);
  const ot = checkLine(
    'ot',
    hours?.ot,
    ratesPhp?.ot,
    payPhp?.ot,
    ratesPaid?.ot,
    !!isHsl,
    !!hasMidPeriodChange,
  );
  if (ot) out.push(ot);

  // ── The merged Weekend Hours line ──
  // The statement renders ONE weekend row; its `weekendBasis` itemizes the
  // regular/OT buckets at `base + premium` each. Every basis entry is a rate ×
  // hours claim the employee sees, so each bucket is validated on its own —
  // both report under the single `weekend` line id. `allowPremiumHeadroom` is
  // FALSE: the premium is already inside the displayed rate, so pay must
  // reproduce hours × rate on BOTH sides.
  if (weekend) {
    const premium = finite(weekend.premiumPhpPerHour) ?? HSL_WEEKEND_PREMIUM_PHP_PER_HOUR;
    const baseReg = finite(ratesPhp?.regular);
    const baseOt = finite(ratesPhp?.ot);

    // ── Segment path: check the rates the stub actually prints. ──
    // A prorated week renders the per-day weekend segments, not `ratesPhp + premium`.
    const segs = [...(weekend.segments?.regular ?? []), ...(weekend.segments?.ot ?? [])].filter(
      (s) => s && finite(s.ratePhp) != null && finite(s.hours) != null && finite(s.payPhp) != null,
    );
    if (segs.length > 0) {
      for (const s of segs) {
        const issue = checkLine(
          'weekend',
          s.hours,
          round(s.ratePhp + premium, 2),
          s.payPhp,
          null,
          false,
          !!hasMidPeriodChange,
        );
        if (issue) out.push(issue);
      }
      return out;
    }
    // `ratesPaid` is deliberately NOT forwarded here. On the regular/ot lines it is the
    // authoritative signal — but it clears a line whenever the DISPLAYED rate appears
    // anywhere among the rates used, even if only some of the hours were paid at it.
    // That is precisely the erjiee case: rates paid were [355, 225] (weekdays at 355,
    // the stranded Sunday at 225), so the weekend equivalents [370, 240] would "contain"
    // the displayed 370 and clear a ₱1,053.33 shortfall. Each basis entry states ONE
    // rate against ONE amount, so plain arithmetic is both sufficient and stricter.
    // A genuine mid-week rate change still downgrades this to a warning below.
    const wReg = checkLine(
      'weekend',
      weekend.hours?.regular,
      baseReg == null ? null : round(baseReg + premium, 2),
      weekend.payPhp?.regular,
      null,
      false,
      !!hasMidPeriodChange,
    );
    if (wReg) out.push(wReg);
    const wOt = checkLine(
      'weekend',
      weekend.hours?.ot,
      baseOt == null ? null : round(baseOt + premium, 2),
      weekend.payPhp?.ot,
      null,
      false,
      !!hasMidPeriodChange,
    );
    if (wOt) out.push(wOt);
  }
  return out;
}

/** True when any issue is severe enough to block a dispatch. */
export function hasBlockingRateIssue(issues: RateConsistencyIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/**
 * Total PHP the employee is short across all flagged lines (0 when none, negative
 * when overpaid). This is the number that matters in an arrears conversation.
 */
export function totalRateShortfallPhp(issues: RateConsistencyIssue[]): number {
  return round(
    issues.reduce((s, i) => s + i.deltaPhp, 0),
    2,
  );
}
