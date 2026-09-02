import { isInternEmail } from './intern-email';

/**
 * Split a batch of mapped Hubstaff rows into the two rails by the domain rule.
 *
 * Pure so both doors can be tested without a database:
 *   - Simple's door (`rowsToPayrollRows` in hubstaff-hours-db.ts) keeps
 *     `payroll` and reports `interns.length` as `internRowsDropped`.
 *   - The interns' door (the mini wizard upload) keeps `interns` and REFUSES
 *     `payroll` — a Simple employee in the intern file must never be priced at
 *     the intern rate, so those rows are reported back and never stored.
 */
export function partitionInternRows<T extends { email: string | null }>(
  rows: T[],
): { payroll: T[]; interns: T[] } {
  const payroll: T[] = [];
  const interns: T[] = [];
  for (const r of rows) {
    if (isInternEmail(r.email)) interns.push(r);
    else payroll.push(r);
  }
  return { payroll, interns };
}
