/**
 * The COMPLETE-OVERRIDE rules behind the Payroll Notes → Readiness / Offboarded
 * "Set rate" fixer (2026-09-15, Kane: *"Set payrates … should be a complete
 * override … it's not sticking at all"*).
 *
 * Pure — no DB, no server-only import — so the three decisions the route makes
 * are provable in isolation:
 *
 *   1. WHICH EMAIL the individual rate is keyed to. Payroll pays the Hubstaff
 *      identity; a structure filed under a master alias the hours do not ride
 *      is a rate nobody prices from (`lawang-rate-shadow-duplicate-identity`).
 *   2. WHICH OTHER individual structures the save retires. Rate resolution keys
 *      on email only and the NEWEST-created structure wins
 *      (`buildCatalogRateIndex`), so a second employee-scope row in another
 *      department is never a second rate — it is a shadow that can silently
 *      outrank the one the clerk just saved. A complete override leaves exactly
 *      one.
 *   3. FROM WHICH DATE the rate-history supersede runs. The catalog route used
 *      to delete `>= today OR == effective`, so a back-dated save left a newer
 *      PAST-dated row in force (`gracechellem@`: ₱175 eff 09-01 stayed live
 *      under a ₱175 eff 08-30). The floor is the earlier of today and the
 *      chosen date: everything from there forward is replaced.
 */
import { normEmail } from '@/lib/email/norm-email';
import type { PayStructureSlot } from '@/lib/payment-catalog/pay-structure';

/**
 * The email a person's final-pay rate must be keyed to: the Hubstaff email when
 * the roster knows it (THE payable identity), else the work email, else the
 * personal email. Null when the row carries no email at all — the dialog then
 * refuses, exactly as it always has.
 */
export function rateWriteEmail(
  hubstaffEmail: string | null | undefined,
  workEmail: string | null | undefined,
  personalEmail: string | null | undefined,
): string | null {
  return normEmail(hubstaffEmail) ?? normEmail(workEmail) ?? normEmail(personalEmail);
}

/**
 * Every OTHER employee-scope structure this person holds, in any department —
 * the shadows a complete override removes. `keepId` is the row the save just
 * wrote (or updated). Emails are compared in JS after `normEmail`, never with a
 * LIKE pattern (bonus-catalog.md §5.6 rule 2).
 */
export function shadowEmployeeStructures<T extends PayStructureSlot>(
  email: string,
  keepId: string,
  structures: readonly T[],
): T[] {
  const em = normEmail(email);
  if (!em) return [];
  return structures.filter(
    (s) => s.scope === 'employee' && s.id !== keepId && normEmail(s.employeeEmail ?? '') === em,
  );
}

/**
 * The first `effective_from` the fixer's save supersedes. Both inputs are plain
 * `YYYY-MM-DD` strings, so lexical order IS date order. A future date still
 * clears every pending future row (the old `>= today` behaviour); a past date
 * additionally clears the newer past-dated rows the old clause left standing.
 */
export function historySupersedeFloor(todayIso: string, effectiveIso: string): string {
  return effectiveIso < todayIso ? effectiveIso : todayIso;
}
