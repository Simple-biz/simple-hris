/**
 * True when one applied row is an SP-ranking row: the AI Team Bonus shape, which
 * carries BOTH `SP` and the `Ranking` tier flag.
 *
 * PURE and dependency-free, so both the SP Rankings read (`supabase/team-rankings.ts`,
 * which re-exports it) and My Team's KPI Rankings (`deliverable-money-order.ts`, which
 * leaves a department with SP rows to the SP pane) decide "is this an SP department"
 * by ONE rule.
 *
 * `SP` alone is not enough (2026-09-26, measured read-only). PM Team's "Scott
 * Cameron" manager bonus writes one row a week with 15–17 keys of team totals,
 * `SP` among them, and that lit up a Rankings pane for PM Team listing every one of
 * its ~360 weekly KPI rows at SP 0. AI/API Team's "AI Team (TEMP BONUS)" rows
 * (`{ AI_Bonus }`) were likewise ranked as SP 0, and made 2026-09-13 an
 * all-zero week ranked by name.
 */
export function isSpRankingRow(vars: Record<string, unknown> | null | undefined): boolean {
  return vars != null && 'SP' in vars && 'Ranking' in vars;
}
