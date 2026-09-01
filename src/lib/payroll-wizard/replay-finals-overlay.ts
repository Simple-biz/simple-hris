// Payroll Wizard — Reports step replay overlay.
//
// When a past period is replayed, the Reports step recomputes rows live and
// then overlays the figures saved in `payroll.wizard.final_pay.<file>` so the
// report shows the week AS IT WAS PAID. The overlay used to patch only
// hours/regular/OT/initial/final, which let TODAY's recomputed bonus,
// adjustment, orphanage and MESA figures sit beside a SAVED final — a row that
// cannot reconcile against its own columns (the exact failure class
// report-rows.ts exists to close, and a "live data may never leak into a
// replay" violation per docs/features/payroll-wizard-week-replay.md).
//
// The snapshot has stored the full itemized split since 2026-08-18
// (publishFinalPaySnapshot), so this merge applies every saved component that
// is present and recomputes `bonuses_total` from the EFFECTIVE components so
// the split identity (bonusesTotal = pab + tech + other + adjustment) holds by
// construction.
//
// Fidelity rule (docs/features/payroll-wizard-week-replay.md): a saved value
// is read verbatim; an ABSENT saved field falls back to the live recompute —
// never to ₱0. Legacy snapshots that predate a field simply keep the live
// figure for it.

/** One saved entry of the final-pay snapshot's `finals` map. Every field is
 *  optional except `final` — older snapshots omit fields they predate. */
export interface ReplayFinalEntry {
  final: number;
  regularPay?: number | null;
  otPay?: number | null;
  regularHours?: number;
  otHours?: number;
  totalHours?: number;
  initial?: number | null;
  mesaDeduction?: number;
  mesaDisbursement?: number;
  perfectAttendanceBonus?: number;
  techBonus?: number;
  otherBonuses?: number;
  adjustment?: number;
  orphanagePay?: number;
}

/** The slice of a recomputed dispatch row the overlay reads and rewrites. */
export interface ReplayOverlayRow {
  hours: { total: number; regular: number; ot: number };
  pay_php: {
    regular: number | null;
    ot: number | null;
    initial: number | null;
    bonuses_total: number;
    perfect_attendance_bonus: number;
    tech_bonus: number;
    other_bonuses: number;
    adjustment: number;
    mesa_deduction: number;
    mesa_disbursement: number;
    orphanage_pay: number;
    final: number;
  };
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Merge one saved snapshot entry over one live-recomputed row. Saved fields
 * win verbatim when present; absent fields keep the live figure (never ₱0).
 * `bonuses_total` is always recomputed from the effective components so the
 * split identity holds whichever side each component came from.
 */
export function overlayReplayFinal<T extends ReplayOverlayRow>(row: T, saved: ReplayFinalEntry): T {
  const p = row.pay_php;
  const pab = num(saved.perfectAttendanceBonus) ? saved.perfectAttendanceBonus : p.perfect_attendance_bonus;
  const tech = num(saved.techBonus) ? saved.techBonus : p.tech_bonus;
  const other = num(saved.otherBonuses) ? saved.otherBonuses : p.other_bonuses;
  const adjustment = num(saved.adjustment) ? saved.adjustment : p.adjustment;
  return {
    ...row,
    hours: {
      total: num(saved.totalHours) ? saved.totalHours : row.hours.total,
      regular: num(saved.regularHours) ? saved.regularHours : row.hours.regular,
      ot: num(saved.otHours) ? saved.otHours : row.hours.ot,
    },
    pay_php: {
      ...p,
      regular: saved.regularPay !== undefined ? saved.regularPay : p.regular,
      ot: saved.otPay !== undefined ? saved.otPay : p.ot,
      initial: saved.initial !== undefined ? saved.initial : p.initial,
      perfect_attendance_bonus: pab,
      tech_bonus: tech,
      other_bonuses: other,
      adjustment,
      bonuses_total: pab + tech + other + adjustment,
      mesa_deduction: num(saved.mesaDeduction) ? saved.mesaDeduction : p.mesa_deduction,
      mesa_disbursement: num(saved.mesaDisbursement) ? saved.mesaDisbursement : p.mesa_disbursement,
      orphanage_pay: num(saved.orphanagePay) ? saved.orphanagePay : p.orphanage_pay,
      final: saved.final,
    },
  };
}
