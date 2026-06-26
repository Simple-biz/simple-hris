/**
 * Client-safe QC constants. Kept separate from `src/lib/supabase/qc-db.ts`
 * (which is server-only) so client components — the calculator, the QC shell —
 * can import the department list without pulling in the Supabase service client.
 */

/** The three departments QC officers score. */
export const QC_DEPT_KEYS = ['lead_gen', 'callback', 'discovery'] as const;
export type QcDeptKey = (typeof QC_DEPT_KEYS)[number];

const QC_DEPT_SET = new Set<string>(QC_DEPT_KEYS);

/** True if a normalized department key is one QC scores. */
export function isQcDeptKey(key: string | null | undefined): boolean {
  return !!key && QC_DEPT_SET.has(key);
}
