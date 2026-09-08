/**
 * Re-gates the Perfect Attendance Bonus inside the Payroll Wizard's Additions
 * review totals so the screen shows what the run actually pays.
 *
 * Why this exists instead of a gate inside `bonusTotals`:
 *
 * `bonusTotals` is deliberately MONTH-WIDE. `dispatchData` strips its PAB/Tech
 * terms back out by RECOMPUTING them (`rawBonusTotal - toggledPab - toggledTech`)
 * and then re-adds the week-gated versions. Gating `bonusTotals` itself would
 * subtract a PAB that is no longer in the sum, understating `other_bonuses` — and
 * therefore real KPI/department money — by the PAB amount on every non-payout
 * week. So the month-wide map stays as it is and the REVIEW SURFACE re-gates.
 *
 * The contract: `pabTermFor` must return exactly what `bonusTotals` added for
 * that person's PAB — same toggle, same department allowlist, same amount
 * resolver. Mirror it, don't re-derive it. Nothing is clamped at zero: a mirror
 * that drifts must surface as a wrong number, not be silently absorbed.
 */

export function regatePabInBonusTotals(
  bonusTotals: Record<string, number>,
  pabPaysThisWeek: boolean,
  pabTermFor: (email: string) => number,
): Record<string, number> {
  // The payout week pays the month-wide figure verbatim — nothing to re-gate.
  if (pabPaysThisWeek) return bonusTotals;
  const out: Record<string, number> = {};
  for (const [email, total] of Object.entries(bonusTotals)) {
    const pabTerm = pabTermFor(email);
    out[email] = pabTerm === 0 ? total : total - pabTerm;
  }
  return out;
}
