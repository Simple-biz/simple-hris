import 'server-only';

/**
 * The Payment Catalog's off-board exclusion set: every email on the active
 * roster that belongs to someone who has left, resolved server-side and shipped
 * on `prefetchAccountingData` so the catalog can filter its people surfaces
 * without a second gated round-trip (the same reasoning that puts the department
 * registry on the prefetch — see payment-catalog-departments.md §4).
 *
 * Three inputs, all of which the client cannot read:
 *
 *   • off-board evidence unioned from `global_master_list` / `offboarded_sheet` /
 *     `offboarding_queue` (`loadOffboardEvidenceByEmail`) — service-role,
 *   • who logged hours in the cycle's Hubstaff timesheet (`loadCycleHoursIndex`),
 *   • the pay week being processed (`payrollNotesWeekStart`).
 *
 * **Fails OPEN, at every level.** Neither loader throws (each is internally
 * best-effort), but if one degrades to nothing the arithmetic still resolves the
 * right way: no evidence hides nobody, and an unreadable timesheet is caught
 * explicitly below and hides nobody either. The Payment Catalog is the rate
 * source of truth, so a leaver lingering an extra week is cosmetic while an
 * active worker who cannot be found has no settable rate.
 */
import type { EmployeeRow } from '@/lib/supabase/employees';
import { normEmail } from '@/lib/email/norm-email';
import { payrollNotesWeekStart } from '@/lib/payroll/manila-week';
import { loadCycleHoursIndex, personWorkedCycle } from '@/lib/payroll/cycle-hours-index';
import { loadOffboardEvidenceByEmail, type OffboardEvidence } from '@/lib/roster/offboard-evidence';
import { normalizeMasterDate } from '@/lib/roster/master-date';
import { isOffboardedForPaymentCatalog } from '@/lib/payment-catalog/catalog-roster-visibility';

export interface CatalogOffboardedResult {
  /** Normalized emails to drop from the catalog's people surfaces. Every email a
   *  hidden person is known by is listed, so a lookup keyed on either their work
   *  or personal address matches. */
  emails: string[];
  /** Non-null when the set is degraded and therefore INCOMPLETE — the caller may
   *  surface it, but the set is always safe to apply as-is. */
  error: string | null;
}

const EMPTY = (error: string): CatalogOffboardedResult => ({ emails: [], error });

/**
 * Resolve the exclusion set for a roster snapshot.
 *
 * @param employees the same `active_employees` rows the catalog will render.
 */
export async function loadCatalogOffboardedEmails(
  employees: EmployeeRow[],
): Promise<CatalogOffboardedResult> {
  if (employees.length === 0) return { emails: [], error: null };

  const [evidenceByEmail, hours] = await Promise.all([
    // WORK EMAIL ONLY. A personal inbox is shared across duplicate master
    // identities, so matching on it imports someone else's departure — it is what
    // pulled `carlath@simple.biz`'s resignation onto the live `carla@simple.biz`
    // row, and `offboarding_queue.employee_email` is a personal address on all
    // 460 completed rows.
    loadOffboardEvidenceByEmail('work').catch(() => null),
    loadCycleHoursIndex(null),
  ]);

  // No evidence read ⇒ nothing is provably gone. Say so rather than quietly
  // showing everyone as active.
  if (!evidenceByEmail) return EMPTY('Off-board evidence could not be read — nobody was hidden');
  // An unreadable timesheet removes the guard that keeps still-working people
  // (18 of them today) visible, so it disables hiding entirely rather than
  // trusting the stamps alone.
  if (hours.error) return EMPTY(`Cycle timesheet unavailable (${hours.error}) — nobody was hidden`);

  const cycleWeekStart = payrollNotesWeekStart();
  const out = new Set<string>();

  for (const e of employees) {
    const work = normEmail(e.work_email);
    const personal = normEmail(e.personal_email);
    const alt = normEmail(e.alternate_work_email);
    const alt2 = normEmail(e.alternate_work_email_2);
    // Every address the person is known by — used for the hours match and for
    // the exclusion keys. The EVIDENCE lookup below is narrower on purpose.
    const aliases = [work, personal, alt, alt2].filter((k): k is string => k !== null);
    if (aliases.length === 0) continue;

    // Evidence is matched on the WORK addresses only (including gsuite
    // alternates, which are the same human). The personal email is deliberately
    // absent: it is shared across split identities.
    let evidence: OffboardEvidence | null = null;
    for (const k of [work, alt, alt2]) {
      if (!k) continue;
      const rec = evidenceByEmail.get(k);
      if (rec && (!evidence || rec.offDate > evidence.offDate)) evidence = rec;
    }
    if (!evidence) continue;

    const hidden = isOffboardedForPaymentCatalog({
      evidence,
      startDate: normalizeMasterDate(e.start_date),
      cycleWeekStart,
      // Hours match across EVERY address plus the name-token key — the widest
      // possible read of "this person worked", because a hit here keeps them.
      hasCycleHours: personWorkedCycle(hours, { emails: aliases, name: e.name }),
    });
    if (!hidden) continue;

    // Personal and alternate addresses go into the exclusion set even though
    // they are not evidence keys: the catalog keys a person's rows across every
    // alias, so an exclusion naming only the work address would let a hidden
    // person back in through a picker that matched on their personal one.
    for (const alias of aliases) out.add(alias);
  }

  return { emails: [...out], error: null };
}
