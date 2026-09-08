/**
 * Merge each employee's scored HSL KPI amount into the running per-employee bonus
 * totals for a payroll run.
 *
 * **Every scored amount is paid — regardless of the person's resolved home
 * department.** This is the whole point, and the correction of a real mispay
 * (Carla, 2026-09-08): the wizard used to add the HSL KPI only for rows whose
 * `employeeDepts[email] === 'hogan_smith_law'`, but a large share of HSL scorers
 * do not resolve to that key —
 *   - "external members" added to an HSL dept in the KPI Calculator whose master
 *     department is Lead Gen / Client-VA / Edit Team (e.g. hansc@ filing ₱250), and
 *   - people carrying a DUPLICATE global_master_list row (an old non-HSL copy plus
 *     an `hsl:<key>` copy) where identity resolution nondeterministically picks the
 *     non-HSL copy, so the same person is paid one week and dropped the next
 *     (christiane@ attestation, debbief@ filing, clarizr@ collections, maycp@
 *     callback, ~60 people, ₱188k in the 2026-08-30 week).
 *
 * The eligibility signal is the SCORED ROW, not the home department. `hslKpiAmounts`
 * is already built from the processed week's ready/locked HSL periods, resolved to
 * each wizard row's identity through the master index, so paying every entry pays
 * exactly the people the managers scored — once each. Mutates and returns `totals`.
 *
 * Zero amounts are skipped so an unscored row never creates a spurious ₱0 entry.
 */
export function addHslKpiBonuses(
  totals: Record<string, number>,
  hslKpiAmounts: Record<string, number>,
): Record<string, number> {
  for (const [email, amt] of Object.entries(hslKpiAmounts)) {
    if (amt) totals[email] = (totals[email] ?? 0) + amt;
  }
  return totals;
}
