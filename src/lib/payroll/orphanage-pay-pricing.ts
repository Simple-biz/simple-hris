/**
 * Orphanage-pay pricing — the ONE place pasted orphanage hours become pesos.
 *
 * Extracted from `PayrollWizard.tsx`'s `orphanagePasteParse` on 2026-08-21 after
 * josephinet@simple.biz was locked in at ₱3,781.00 against the NPD sheet's
 * ₱7,224.25. The formula was never wrong on the day it ran — but between
 * 2026-08-11 (`e0028b8d`, HSL pay became the Hogan sheet's column AN, which set
 * `CalcRow.otRate` to the DERIVED 0.5× differential) and 2026-08-18 (`41a21ae1`,
 * the orphanage tool started deriving regular × 1.5 for sheet-form rows) the
 * paste tool priced orphanage overtime off that differential. Orphanage hours
 * have **no base leg** — nothing else pays their first 1.0× — so a differential
 * half-pays them.
 *
 * The reason it survived the fix is the shape of this step, not the arithmetic:
 * the amount is computed ONCE at paste time and persisted to two carriers (the
 * `payroll.wizard.additions.<file>` blob for the money, `orphanage_pay` for the
 * hours/rates), and **nothing has ever re-priced a locked-in row**. Only a
 * re-paste heals one, which is exactly what "delete her line and add her again"
 * did.
 *
 * So this module owns three things, and every one of them is a guard rather than
 * a calculation:
 *
 *  1. {@link priceOrphanageHours} — pricing, with the OT rate **derived** for
 *     sheet-form rows and a hard refusal when a stored OT rate is shaped like a
 *     differential (below the regular rate). A refused row is not priced; it is
 *     reported, so nobody is silently half-paid.
 *  2. {@link reconcileLockedOrphanageAmount} — re-derives a stored row from its
 *     OWN persisted components and reports divergence. It never rewrites money;
 *     re-pricing stays a human action.
 *  3. {@link orphanageOtRateFor} — the single OT-rate decision both of the above
 *     share, so the pricing path and the audit path can't drift apart.
 *
 * Governing rules: `docs/features/hsl-weekend-ot-pay.md` §"Orphanage hours"
 * (full 1.5×, never the differential), `references/sql/create/create_orphanage_pay.sql`
 * (hours stack against the 40h/week regular cap), `docs/features/payroll-wizard-final-pay.md`
 * (Orphanage is an additive component of Final).
 */

/** Cents-accurate 2dp round, matching every other money site in the wizard. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The full OT multiple. Orphanage hours carry their own base leg, always. */
export const ORPHANAGE_OT_MULTIPLIER = 1.5;

/** The weekly regular-hours cap orphanage hours stack against. */
export const ORPHANAGE_REGULAR_CAP_HOURS = 40;

/** Why a pasted orphanage row could not be priced. Every code is a refusal to
 *  pay a number we cannot prove, never a fallback. */
export type OrphanagePriceRefusalCode =
  /** Hours are missing, negative, or not a number. */
  | 'invalid_hours'
  /** No PHP regular rate on file — there is nothing to value the hours at. */
  | 'no_regular_rate'
  /** Hours cross 40h but the row carries no OT rate at all. */
  | 'no_ot_rate'
  /** Hours cross 40h and the stored OT rate is BELOW the regular rate, i.e. it
   *  is a differential (the 0.5× leg), not a rate. Pricing orphanage OT off it
   *  half-pays the hour. This is the 2026-08-11 → 08-18 regression's shape. */
  | 'ot_rate_below_regular';

export interface OrphanagePriceRefusal {
  ok: false;
  code: OrphanagePriceRefusalCode;
  /** Operator-facing sentence. States what to fix, never just what failed. */
  reason: string;
}

export interface OrphanagePriceOk {
  ok: true;
  /** Total pasted hours, unchanged. */
  hours: number;
  /** Hours that fit under the 40h weekly regular cap. 2dp on the sheet basis. */
  regH: number;
  /** Hours past the cap. Zero when OT is switched off for the department. */
  otH: number;
  /** The PHP regular rate used. */
  rate: number;
  /** The PHP OT rate used. Null only when `otH === 0`. */
  otRate: number | null;
  /** True when `otRate` was DERIVED as regular × 1.5 rather than read from the
   *  row. Persisted alongside the amount so an audit can tell the two apart. */
  otRateDerived: boolean;
  /** Which rounding the legs were priced on — see {@link OrphanageRoundingBasis}. */
  roundingBasis: OrphanageRoundingBasis;
  /** regH × rate, on the row's rounding basis. */
  regPay: number;
  /** otH × otRate, on the row's rounding basis. Zero when `otH === 0`. */
  otPay: number;
  /** The money: regPay + otPay, to the centavo. */
  amount: number;
}

/**
 * How the legs are priced.
 *
 * `sheet-2dp` — 2-decimal HOURS per leg, each leg rounded, legs summed. This is
 * the Hogan sheet's own arithmetic and the sheet is the payment authority for
 * HSL (`hogan-week-pay.ts` header: "the sheet multiplies 2-decimal HOURS by the
 * rate … the sheet is the payment authority, so this module follows the sheet",
 * and `hsl-weekend-ot-pay.md:17` — whole-seconds math "is wrong by definition").
 * It is what makes HRIS agree with the NPD sheet to the centavo: josephinet's
 * 15.5 h over a 5.8014 h cap remainder price as 5.80 + 9.70, giving ₱7,224.25 —
 * exactly the sheet's figure, where 4dp hours give ₱7,224.00.
 *
 * `exact` — full-precision hours, one round at the end. Every non-HSL row keeps
 * this, unchanged: those departments are not paid off the Hogan sheet and there
 * is no rule putting them on its rounding.
 */
export type OrphanageRoundingBasis = 'sheet-2dp' | 'exact';

export type OrphanagePriceResult = OrphanagePriceOk | OrphanagePriceRefusal;

export interface OrphanagePriceInput {
  /** Pasted orphanage hours for the pay week. */
  hours: number;
  /** The PHP regular rate that is actually paying this person's week
   *  (`CalcRow.regularRate` — the rate the statement shows AND pays at). */
  regularRatePhp: number | null;
  /** The row's stored OT rate (`CalcRow.otRate`). On HSL sheet-form rows this is
   *  the derived 0.5× differential, which is why `isHslSheetForm` exists. */
  storedOtRatePhp: number | null;
  /** True when this week was priced by the Hogan sheet's three-stage form
   *  (`CalcRow.hogan != null`), where `storedOtRatePhp` is the differential. */
  isHslSheetForm: boolean;
  /** Regular hours the person has ALREADY worked this pay week
   *  (`CalcRow.regularHours`) — what eats the 40h cap before these hours land. */
  workedRegularHours: number;
  /** Whether overtime applies at all for this person's department this week
   *  (global suspend + per-dept switch already resolved). When false, every
   *  orphanage hour stays regular. */
  overtimeEnabled: boolean;
}

/**
 * The OT rate an orphanage hour prices at, and whether it was derived.
 *
 * Sheet-form rows derive regular × 1.5 (2dp, sheet rounding) because their
 * stored OT rate is the 0.5× differential. Every other row keeps its stored OT
 * rate — a department may have negotiated something other than 1.5×, and this
 * module is not the place to overrule that. What it will not do is price an
 * orphanage hour off a rate BELOW the regular rate: see `ot_rate_below_regular`.
 */
export function orphanageOtRateFor(input: {
  regularRatePhp: number;
  storedOtRatePhp: number | null;
  isHslSheetForm: boolean;
}): { otRate: number | null; derived: boolean } {
  if (input.isHslSheetForm) {
    return { otRate: round2(input.regularRatePhp * ORPHANAGE_OT_MULTIPLIER), derived: true };
  }
  return { otRate: input.storedOtRatePhp, derived: false };
}

/**
 * Price one pasted orphanage row. Returns either a fully-itemized amount or a
 * refusal — never a best-effort number.
 */
export function priceOrphanageHours(input: OrphanagePriceInput): OrphanagePriceResult {
  const { hours } = input;
  if (!Number.isFinite(hours) || hours < 0) {
    return { ok: false, code: 'invalid_hours', reason: `Invalid hours: "${String(hours)}"` };
  }

  const rate = input.regularRatePhp;
  if (rate == null || !Number.isFinite(rate) || rate <= 0) {
    return {
      ok: false,
      code: 'no_regular_rate',
      reason: 'No pay rate on file — set their rate, then re-paste',
    };
  }

  // Sheet-form rows are paid off the Hogan sheet, so they take the sheet's
  // rounding; everyone else keeps full-precision hours.
  const basis: OrphanageRoundingBasis = input.isHslSheetForm ? 'sheet-2dp' : 'exact';

  // Overtime awareness: orphanage hours stack on the hours already worked
  // against the 40h/week regular cap. Hours that still fit pay at the regular
  // rate; anything beyond crosses into OT (worked 39h → 1 orphanage hour is
  // regular, the rest is OT). When OT is off for their department every hour
  // stays regular.
  let regH = hours;
  let otH = 0;
  if (input.overtimeEnabled) {
    const worked = Number.isFinite(input.workedRegularHours) ? input.workedRegularHours : 0;
    const regCapacityLeft = Math.max(0, ORPHANAGE_REGULAR_CAP_HOURS - worked);
    regH = Math.min(hours, regCapacityLeft);
    if (basis === 'sheet-2dp') {
      // Round the REGULAR leg, then derive OT as the remainder, so the two legs
      // still sum to the pasted hours exactly. Rounding both independently can
      // drift the total by a centavo-hour and would make the preview's hours
      // disagree with the sheet's own column.
      regH = round2(regH);
      otH = round2(hours - regH);
    } else {
      otH = Math.round((hours - regH) * 1e6) / 1e6; // de-noise float subtraction
    }
  } else if (basis === 'sheet-2dp') {
    regH = round2(hours);
  }

  const { otRate, derived } = orphanageOtRateFor({
    regularRatePhp: rate,
    storedOtRatePhp: input.storedOtRatePhp,
    isHslSheetForm: input.isHslSheetForm,
  });

  if (otH > 0) {
    if (otRate == null || !Number.isFinite(otRate)) {
      return {
        ok: false,
        code: 'no_ot_rate',
        reason: 'Hours cross into overtime (over 40h) but no OT rate on file',
      };
    }
    // The regression guard. An OT rate below the regular rate is a DIFFERENTIAL
    // — the 0.5× top-up on an hour whose base leg the weekly pay already covers.
    // Orphanage hours have no base leg, so pricing them there pays a fraction of
    // one hour. Refuse rather than derive: a rate this shape means the row's rate
    // data is wrong, and quietly substituting 1.5× would hide that.
    if (otRate < rate) {
      return {
        ok: false,
        code: 'ot_rate_below_regular',
        reason:
          `OT rate ₱${otRate.toFixed(2)} is below the regular rate ₱${rate.toFixed(2)} — ` +
          `that is an overtime differential, and orphanage hours have no base pay to add it to. ` +
          `Fix their OT rate (regular × 1.5 = ₱${round2(rate * ORPHANAGE_OT_MULTIPLIER).toFixed(2)}), then re-paste`,
      };
    }
  }

  // The sheet rounds EACH leg then sums (`hogan-week-pay.ts` basePayPhp /
  // otDifferentialPayPhp); the exact basis keeps the single trailing round the
  // paste tool has always used, so no non-HSL amount moves by this change.
  const regPay = basis === 'sheet-2dp' ? round2(regH * rate) : regH * rate;
  const otPay = otH > 0 ? (basis === 'sheet-2dp' ? round2(otH * (otRate as number)) : otH * (otRate as number)) : 0;

  return {
    ok: true,
    hours,
    regH,
    otH,
    rate,
    otRate: otH > 0 ? otRate : otRate ?? null,
    otRateDerived: derived,
    roundingBasis: basis,
    regPay: round2(regPay),
    otPay: round2(otPay),
    amount: round2(regPay + otPay),
  };
}

/** What a stored orphanage row's own components say about it. */
export type OrphanageReconcileStatus =
  /** Components are present and the stored amount is what they price to. */
  | 'ok'
  /** Stored amount disagrees with its own hours × rates by more than a centavo. */
  | 'amount_mismatch'
  /** OT hours were priced at a rate below the regular rate — the 0.5×
   *  differential bug. The row is UNDERPAID by `shortfallPhp`. */
  | 'ot_underpriced'
  /** No `orphanage_pay` record (or it is missing rate columns), so the stored
   *  money cannot be checked against anything. Not a pass. */
  | 'unverifiable';

export interface OrphanageReconcileResult {
  status: OrphanageReconcileStatus;
  /**
   * What the stored components price to, for the operator-facing message.
   *
   * NOT the number a repair writes. A repair re-runs {@link priceOrphanageHours}
   * over the stored HOURS with the row's live inputs, so that re-pricing and a
   * plain re-paste are the same arithmetic by construction — there is exactly one
   * function that turns orphanage hours into pesos, and a second opinion computed
   * here is how the two would drift apart.
   */
  expectedAmountPhp: number | null;
  /** expected − stored. Positive means the person was paid too LITTLE. */
  shortfallPhp: number;
  /** The OT rate the row SHOULD have used, when a shortfall is detected. */
  correctOtRatePhp: number | null;
  /** One sentence for the operator. Empty when `status === 'ok'`. */
  message: string;
}

/**
 * Re-derive a locked-in orphanage row from its OWN persisted components and
 * report whether the stored peso figure still stands.
 *
 * Deliberately narrow: it uses only what `orphanage_pay` stored (hours, split,
 * both rates) plus the stored amount from the additions blob. It does NOT reach
 * for today's rate — a rate change after lock-in is a business decision, not a
 * defect, and re-pricing the whole period on every render is how a wizard starts
 * silently moving money. What it does catch is the class that has no innocent
 * reading: OT hours priced below the regular rate.
 *
 * Never mutates. Re-pricing is a human action.
 */
export function reconcileLockedOrphanageAmount(input: {
  /** The money on the Additions Orphanage column (the durable value). */
  storedAmountPhp: number;
  /** The `orphanage_pay` record's columns, or null when there is no record. */
  record: {
    hours: number;
    regHours: number;
    otHours: number;
    regularRatePhp: number | null;
    otRatePhp: number | null;
  } | null;
}): OrphanageReconcileResult {
  const rec = input.record;
  if (
    !rec ||
    rec.regularRatePhp == null ||
    !Number.isFinite(rec.regularRatePhp) ||
    rec.regularRatePhp <= 0
  ) {
    return {
      status: 'unverifiable',
      expectedAmountPhp: null,
      shortfallPhp: 0,
      correctOtRatePhp: null,
      message: 'No hours/rate record for this amount — it cannot be checked',
    };
  }

  const reg = rec.regularRatePhp;
  const otH = Number.isFinite(rec.otHours) ? rec.otHours : 0;
  const regH = Number.isFinite(rec.regHours) ? rec.regHours : 0;
  const storedOt = rec.otRatePhp;

  // The half-pay class first: it is a real shortfall, not a bookkeeping drift.
  if (otH > 0 && storedOt != null && Number.isFinite(storedOt) && storedOt < reg) {
    const correctOt = round2(reg * ORPHANAGE_OT_MULTIPLIER);
    const expected = round2(round2(regH * reg) + round2(otH * correctOt));
    return {
      status: 'ot_underpriced',
      expectedAmountPhp: expected,
      shortfallPhp: round2(expected - input.storedAmountPhp),
      correctOtRatePhp: correctOt,
      message:
        `${otH.toFixed(2)} OT h priced at ₱${storedOt.toFixed(2)}, below the regular ₱${reg.toFixed(2)} ` +
        `— that is the 0.5× differential. Should be ₱${correctOt.toFixed(2)}`,
    };
  }

  const expected = round2(round2(regH * reg) + round2(otH * (storedOt ?? 0)));
  // 0.02 tolerance, not 0.01: the stored rows predate the sheet-2dp basis, so a
  // correct old row can sit one centavo off on each leg. Anything larger is a
  // real disagreement, and the class that costs money (`ot_underpriced`) is
  // caught above on its rate, never on a rounding delta.
  if (Math.abs(expected - input.storedAmountPhp) > 0.02) {
    return {
      status: 'amount_mismatch',
      expectedAmountPhp: expected,
      shortfallPhp: round2(expected - input.storedAmountPhp),
      correctOtRatePhp: null,
      message: `Stored amount does not match its own hours × rates (${expected.toFixed(2)} expected)`,
    };
  }

  return {
    status: 'ok',
    expectedAmountPhp: expected,
    shortfallPhp: 0,
    correctOtRatePhp: null,
    message: '',
  };
}
