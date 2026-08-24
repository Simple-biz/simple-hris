/**
 * The ONE account-number masker for every export artifact.
 *
 * Kane's 2026-08-12 ruling (docs/features/cycle-closeout.md § Downloadable
 * report): a payee row in a downloadable file carries bank name + account
 * LAST-4 and nothing more. It applies to the Payment Dispatch cycle close-out
 * report and to the People roster export, so it lives in its own dependency-free
 * module — importing it from `cycle-close-report-export.ts` would pull SheetJS
 * into the `/api/people` server bundle just to mask four digits, and copying it
 * is how two files end up disagreeing about what "masked" means.
 *
 * Behaviour is pinned by cycle-close-report-export.test.ts and
 * people/people-roster-export.test.ts.
 */

/** "···7890" for a number with digits; null for empty / digit-free input. */
export function maskAccountLast4(v: string | null | undefined): string | null {
  if (!v) return null;
  const digits = String(v).replace(/\D/g, '');
  if (!digits) return null;
  return `···${digits.slice(-4)}`;
}
