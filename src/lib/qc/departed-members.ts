import 'server-only';

/**
 * Members of a QC-scored department who have actually LEFT — resolved from
 * evidence the active roster cannot see.
 *
 * ## Why this exists
 *
 * `active_employees` cannot answer "has this person left". `/api/hr/offboard`
 * stamps a `global_master_list` row that is not the one the view serves, so the
 * served row keeps `off_boarded_at = null` and the person stays on the roster
 * indefinitely. This was measured and documented for the Payment Catalog on
 * 2026-08-21 (`catalog-roster-visibility.ts`: *zero* of 1,287 active rows carried
 * a stamp while 294 of those people were off-boarded per the evidence sources),
 * and the catalog shipped a guard. **The QC deal never got one.**
 *
 * Measured 2026-09-14: **284 of 1,373** active-roster people carry a dated
 * departure record, **188 of them in a QC-scored department** — dealt scoring
 * slots every week. `johna@simple.biz` completed the offboarding pipeline on
 * **2026-07-20** (queue `completed`, `offboarded_sheet` row written by the HRIS)
 * and was still dealt a Lead Gen slot for **2026-09-14**, seven weeks later.
 * Kane: *"I shouldn't see him in Lead Gen KPI Calculator because he is long
 * gone."*
 *
 * ## What this does NOT fix
 *
 * The root cause — a completed offboard leaving the served master row unstamped
 * — is untouched and still open. This is the same second lock the Payment
 * Catalog uses, applied to the same class of row on another surface.
 *
 * It also cannot see a departure the HRIS never recorded at all. `amielaa@` was
 * offboarded in the Google Sheet with no queue row, no `offboarded_sheet` row
 * and no stamp; no predicate can find evidence that does not exist. That class
 * needs a master-sheet import, not code.
 *
 * ## Fails OPEN, deliberately
 *
 * If the evidence read or the timesheet read fails, the set is EMPTY and
 * `error` is set. Hiding a live person from the calculator means their KPI
 * bonus is never scored and never paid; showing a departed one is noise. The
 * asymmetry is the same one the catalog documents, and it runs the same way.
 */

import type { EmployeeRow } from '@/lib/supabase/employees';
import { normEmail } from '@/lib/email/norm-email';
import { normalizeMasterDate } from '@/lib/roster/master-date';
import { loadOffboardEvidenceByEmail } from '@/lib/roster/offboard-evidence';
import { hasDepartedBeforeWeek } from '@/lib/payment-catalog/catalog-roster-visibility';
import { loadCycleHoursIndex, personWorkedCycle } from '@/lib/payroll/cycle-hours-index';
import {
  listHubstaffUploads,
} from '@/lib/supabase/hubstaff-hours-db';
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';

export interface QcDepartedResult {
  /** Normalized emails — every address a departed person is known by, so a
   *  lookup keyed on work OR personal matches. */
  emails: Set<string>;
  /** Non-null when the set is degraded and therefore INCOMPLETE. Always safe to
   *  apply as-is; an empty set hides nobody. */
  error: string | null;
}

const EMPTY = (error: string): QcDepartedResult => ({ emails: new Set(), error });

/**
 * The Hubstaff file covering the pay week starting `weekStart`, or null when no
 * upload does. Null is NOT an error — a week being scored ahead of its
 * timesheet legitimately has none ([[kpi-calculator-score-ahead]]).
 */
async function sourceFileForWeek(weekStart: string): Promise<string | null> {
  const uploads = await listHubstaffUploads();
  for (const u of uploads) {
    const file = (u.source_file ?? '').trim();
    if (!file) continue;
    const range = parseDateRangeFromFilename(file);
    if (!range?.start || Number.isNaN(range.start.getTime())) continue;
    const day = `${range.start.getFullYear()}-${String(range.start.getMonth() + 1).padStart(2, '0')}-${String(range.start.getDate()).padStart(2, '0')}`;
    if (day === weekStart) return file;
  }
  return null;
}

/**
 * Which of `employees` should not appear in the QC calculator for the week
 * starting `periodStart`.
 *
 * @param employees the roster rows the deal or the route is about to use.
 * @param periodStart the pay-week Sunday being scored.
 */
export async function loadQcDepartedEmails(
  employees: readonly EmployeeRow[],
  periodStart: string,
): Promise<QcDepartedResult> {
  if (employees.length === 0 || !periodStart) return { emails: new Set(), error: null };

  const [evidenceByEmail, hoursFile] = await Promise.all([
    // WORK EMAIL ONLY. A personal inbox is shared across duplicate master
    // identities, so matching on it imports someone else's departure — the same
    // hazard that pulled carlath@'s resignation onto the live carla@ row, and
    // `offboarding_queue.employee_email` is a personal address on every
    // completed row.
    loadOffboardEvidenceByEmail('work').catch(() => null),
    sourceFileForWeek(periodStart).catch(() => null),
  ]);
  if (!evidenceByEmail) return EMPTY('Off-board evidence could not be read — nobody hidden.');

  // Hours in the scored week are a KEEP signal only: a timesheet row cannot be
  // forged by a stale stamp, so anyone who worked the week stays no matter what
  // the stamps say. This never decides the separate, still-open question of
  // whether zero-hours people should be scored (`qc-scoring.md` § Eligibility)
  // — it can only ever keep somebody, never drop them.
  const hours = hoursFile ? await loadCycleHoursIndex(hoursFile) : null;
  if (hours?.error) {
    return EMPTY(`This week’s timesheet couldn’t be read (${hours.error}) — nobody hidden.`);
  }

  const emails = new Set<string>();
  for (const e of employees) {
    const work = normEmail(e.work_email ?? null);
    if (!work) continue;
    const evidence = evidenceByEmail.get(work) ?? null;
    if (!evidence) continue;
    const departed = hasDepartedBeforeWeek({
      evidence,
      startDate: normalizeMasterDate(e.start_date ?? null),
      cycleWeekStart: periodStart,
      hasCycleHours: hours
        ? personWorkedCycle(hours, {
            emails: [e.work_email, e.personal_email],
            name: e.name,
          })
        : false,
    });
    if (!departed) continue;
    for (const addr of [e.work_email, e.personal_email]) {
      const n = normEmail(addr ?? null);
      if (n) emails.add(n);
    }
  }
  return { emails, error: null };
}
