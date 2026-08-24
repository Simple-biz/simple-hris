/**
 * The first-load reveal rule shared by both KPI Calculators.
 *
 * One tab renders two components — `DeptBonusCalculator` (departments) and
 * `HslBonusCalculator` (HSL branches) — and each grew its own first-load gate:
 * `ready` (a derived boolean) and `booted` (a latch set from an effect). Both
 * gates waited on data that a failed week-resolution never produces, so both
 * turned their loading skeleton into the terminal state. `KpiCalculatorLoading`
 * is a shimmer of the real chrome; as a final state it reads as a page that is
 * still working, forever. Observed live 2026-08-24, when a Hubstaff batch named
 * `"8:16 - 8:22 csv.csv"` was promoted to `is_current` and neither calculator
 * ever loaded.
 *
 * The cruel part is that both components already had the right thing to show —
 * an identical rose "Couldn't confirm the payroll week" alert — and in both it
 * renders *inside* the chrome the gate was withholding. The gate hid the only
 * surface that could explain the gate.
 *
 * So the rule, in one place both call:
 *
 *   **An unresolvable payroll week is TERMINAL, not pending.**
 *
 * This does not make anything writable or make an empty week read as scored.
 * Every read and write stays held on `weekResolved` (still false) at its own
 * site, and `kpiAutosaveGate` refuses on the same flag — see
 * `docs/features/hsl-kpi-calculator-2026-07.md`: writing against an unresolved
 * week "strands rows no reader asks for". Those holds are the point; this gate
 * was never one of them, it just looked like one.
 *
 * Deliberately NOT a rule here: what to render once revealed. Each calculator
 * keeps its own chrome, its own per-card loading state, and its own copy.
 */
export function kpiCalculatorRevealed(input: {
  /**
   * Everything this calculator needs before its cards mean anything — the bonus
   * catalog plus every visible department's applied rows (departments), or the
   * settled initial per-branch loads (HSL).
   */
  dataSettled: boolean;
  /**
   * The payroll week could not be resolved from the Hubstaff upload list, after
   * retries. Terminal: there is nothing further to wait for, so revealing is the
   * only way the alert explaining it can ever paint.
   */
  weekError: boolean;
}): boolean {
  return input.weekError || input.dataSettled;
}
