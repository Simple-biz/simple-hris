/**
 * Client-safe QC constants. Kept separate from `src/lib/supabase/qc-db.ts`
 * (which is server-only) so client components — the calculator, the QC shell —
 * can import the department list without pulling in the Supabase service client.
 */

/** The departments QC officers score.
 *
 *  Removals are additive-safe and reversible: a department that leaves keeps every
 *  `qc_score_assignments` / `qc_kpi_submissions` row it already has, and simply
 *  stops being listed — re-adding the key here brings its history back into view.
 *
 *  - **Discovery** left 2026-06-26 — its manager scores it directly in the Manager
 *    KPI Calculator (a plain, non-QC-seeded department).
 *  - **Callback** left 2026-09-10 (Carla: *"just Lead Gen needs to be QCed"*).
 *    Jackie scores it herself; she declined putting Jerome on it since he would be
 *    the only member. */
export const QC_DEPT_KEYS = ['lead_gen'] as const;
export type QcDeptKey = (typeof QC_DEPT_KEYS)[number];

const QC_DEPT_SET = new Set<string>(QC_DEPT_KEYS);

/** True if a normalized department key is one QC scores. */
export function isQcDeptKey(key: string | null | undefined): boolean {
  return !!key && QC_DEPT_SET.has(key);
}
