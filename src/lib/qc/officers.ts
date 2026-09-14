/**
 * Who the QC officers are, and what a slot's lifecycle status means.
 *
 * Both answers used to come from the wrong place.
 *
 * **Officers** were an admin grant — `employee_roles.role='qc'` — which drifts from
 * the roster and stays drifted. Measured 2026-09-14: the grant held 10 people, the QC
 * department held 9, and the odd one out (`jeromer@`) had moved to Callback Team while
 * still being dealt 34 Lead Gen slots that week. Kane: *"I dont want the admin
 * provisions to be the source of the QC Pickers I just want the people under the QC
 * Department to assist the LEADGEN manager in scoring their KPI's."*
 *
 * **Slot status** claimed to distinguish a transfer from an offboard and could not.
 * `roster_status='transferred'` was structurally unreachable — 0 of 8,537 rows — because
 * the roster feeding the deal is pre-narrowed to the scored departments, so anyone who
 * left them had no "current department" to record. Everyone read as `removed`, which is
 * also what quitting looks like.
 *
 * Pure — no I/O — so every branch is exercised by node:test.
 */
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

/**
 * The department QC officers themselves belong to.
 *
 * Not to be confused with `QC_DEPT_KEYS`, which is the set of departments QC officers
 * SCORE (`['lead_gen']`). One is where the scorers sit, the other is who gets scored;
 * conflating them would either enrol Lead Gen people as officers or make officers score
 * themselves.
 */
export const QC_OFFICER_DEPT_KEY = 'qc';

/** The minimum this module needs to know about a roster row.
 *  Every field is optional-nullable because `EmployeeRow` genuinely is — these are
 *  columns that can be absent, and every read below normalises through `norm()`. */
export interface QcRosterPerson {
  department?: string | null;
  work_email?: string | null;
  personal_email?: string | null;
}

/** Lower-cased, trimmed; '' when absent. */
function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * The identity a QC officer is keyed by.
 *
 * WORK email, falling back to personal — the same precedence `employee_roles` used, so
 * switching the source does not silently re-key anybody's existing slots.
 */
export function officerKey(p: QcRosterPerson): string {
  return norm(p.work_email) || norm(p.personal_email);
}

/**
 * Active QC officers, derived from the roster.
 *
 * Sorted for determinism: the deal is seeded, and an unstable officer ORDER would make a
 * reproducible seed produce a different split on every read.
 */
export function officersFromRoster(roster: readonly QcRosterPerson[]): string[] {
  const out = new Set<string>();
  for (const p of roster) {
    if (normalizeDeptToKey(p.department) !== QC_OFFICER_DEPT_KEY) continue;
    const key = officerKey(p);
    if (key) out.add(key);
  }
  return [...out].sort();
}

/**
 * The officer set a week is actually dealt with.
 *
 * **A dealt week is FROZEN.** Once slots exist, the officers for that week are the
 * officers already on those slots — not whoever is in the QC department right now.
 *
 * This is the guard that makes a roster-derived officer list safe. Under the old admin
 * grant the set only moved when somebody clicked; derived from the roster, an ordinary
 * department transfer, an offboard, or a master-sheet clobber (a documented live risk —
 * see `hris-is-dept-source-of-truth`) would change the set mid-week, and an officer-set
 * change re-deals the current week. Without this freeze, routine roster churn would
 * reshuffle every officer's slice underneath people who are already scoring.
 *
 * Kane, 2026-09-14, choosing it for the Jerome case: he finishes the week he is in and
 * is not dealt the next one.
 *
 * A week with no slots yet is not frozen — it deals with the live set.
 */
export function freezeOfficers(
  existingOfficers: readonly string[],
  liveOfficers: readonly string[],
): { officers: string[]; frozen: boolean } {
  const existing = [...new Set(existingOfficers.map(norm).filter(Boolean))].sort();
  if (existing.length === 0) return { officers: [...liveOfficers], frozen: false };
  return { officers: existing, frozen: true };
}

/**
 * Every roster person's CURRENT department key, whatever department that is.
 *
 * Deliberately built from the FULL active roster rather than the scored-department
 * subset. That narrowing is precisely what made `transferred` unreachable: someone who
 * moved out of Lead Gen vanished from the only roster the deal could see, so there was
 * nowhere to read "where are they now" from.
 *
 * Indexed on both emails because a slot may have been written against either.
 */
export function currentDeptByEmail(roster: readonly QcRosterPerson[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of roster) {
    const dept = normalizeDeptToKey(p.department);
    if (!dept) continue;
    for (const e of [norm(p.work_email), norm(p.personal_email)]) {
      if (e && !out.has(e)) out.set(e, dept);
    }
  }
  return out;
}

/** What a slot's lifecycle says about the person in it. */
export type QcSlotStatus = 'active' | 'transferred' | 'removed';

export interface QcSlotClassification {
  status: QcSlotStatus;
  /** Where they are NOW. Null only when they are off the roster entirely. */
  currentDepartment: string | null;
}

/**
 * Classify one slot.
 *
 * The three states are now distinct facts rather than two facts and a synonym:
 *
 * - `active` — still in the department this slot scores.
 * - `transferred` — still employed, in a different department. Carries where.
 * - `removed` — not on the active roster at all: they left.
 *
 * **None of them means "stop scoring."** Kane, 2026-09-14: *"we still need to score
 * people who quit by the way like offboarded people"*, and for a midweek move: *"if they
 * have an appointment set for KPI on monday they should still be able to be scored."*
 * The officer's list carries every status on purpose (`assignments/route.ts:67` filters
 * on officer only) and must never gain a status filter. Status drives what the surface
 * SAYS about a person, never whether they can be paid for work they did.
 */
export function classifySlot(
  isLive: boolean,
  slotDepartment: string,
  currentDepartment: string | null | undefined,
): QcSlotClassification {
  if (isLive) return { status: 'active', currentDepartment: slotDepartment };
  const current = norm(currentDepartment);
  if (current) return { status: 'transferred', currentDepartment: current };
  return { status: 'removed', currentDepartment: null };
}
