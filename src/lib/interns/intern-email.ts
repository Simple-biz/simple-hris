import { normEmail } from '@/lib/email/norm-email';

/**
 * Orphanage interns are a separate payee class from Simple employees, and the
 * ONE thing that identifies one is the domain of their address. Interns are
 * profiled on the Orphanage dashboard with a `@pathway.ph` address (never
 * `@simple.biz`), come on their own Hubstaff report, and are priced by the
 * Interns mini wizard — so an intern row must never be treated as a payroll
 * row anywhere on the Simple rail (Payroll Wizard, Payment Dispatch,
 * disbursement seeding, readiness, standard PAB/Tech).
 *
 * This module is the single implementation of that rule. Both doors apply it:
 * `rowsToPayrollRows` (Simple's Hubstaff reader) drops interns, and the intern
 * hours upload refuses non-interns. See docs/features/orphanage-interns.md.
 */
export const INTERN_EMAIL_DOMAIN = 'pathway.ph';

/** True when the address belongs to an orphanage intern (domain rule, case-insensitive). */
export function isInternEmail(email: string | null | undefined): boolean {
  const n = normEmail(email);
  if (!n) return false;
  const at = n.lastIndexOf('@');
  return at > 0 && n.slice(at + 1) === INTERN_EMAIL_DOMAIN;
}
