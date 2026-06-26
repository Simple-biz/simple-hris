/**
 * Client-safe QC constants. Kept separate from `src/lib/supabase/qc-db.ts`
 * (which is server-only) so client components — the calculator, the QC shell —
 * can import the department list without pulling in the Supabase service client.
 */

/** The departments QC officers score. Discovery was moved OUT of QC scope on
 *  2026-06-26 — its manager now scores it directly in the Manager KPI Calculator
 *  (a plain, non-QC-seeded department). Re-add 'discovery' here to bring it back. */
export const QC_DEPT_KEYS = ['lead_gen', 'callback'] as const;
export type QcDeptKey = (typeof QC_DEPT_KEYS)[number];

const QC_DEPT_SET = new Set<string>(QC_DEPT_KEYS);

/** True if a normalized department key is one QC scores. */
export function isQcDeptKey(key: string | null | undefined): boolean {
  return !!key && QC_DEPT_SET.has(key);
}
