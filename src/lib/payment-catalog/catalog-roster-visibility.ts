/**
 * Who drops off the Payment Catalog's people surfaces.
 *
 * The catalog's search results, person pickers, department headcounts and
 * Summary spend all walk `active_employees`, which cannot tell that someone has
 * left: HR keeps a leaver on the master sheet through their final pay, and the
 * off-board stamp lands on a duplicate `global_master_list` row rather than the
 * one the view serves. Measured 2026-08-21: **zero** of 1,287 active rows carry
 * an `off_boarded_at`, while 294 of those people are off-boarded per the three
 * evidence sources (`@/lib/roster/offboard-evidence`).
 *
 * So the evidence has to come from elsewhere — and the moment it does, the
 * failure mode inverts. The Payment Catalog is the **rate source of truth**: a
 * person Accounting cannot find here is a person whose rate cannot be set, which
 * is how someone silently rides a department base or an old individual rate. On
 * this surface a leaver lingering is cosmetic and an active worker vanishing is
 * money. Every guard below therefore resolves toward KEEPING the person, and the
 * predicate only hides someone when all four agree they are gone.
 *
 * Pure — no I/O — so every branch is exercised by node:test.
 */
import { VALID_OFFBOARD_REASONS } from '@/lib/hr/offboard-reasons';

/** The off-board record that supplied a person's latest evidence. */
export interface CatalogOffboardEvidence {
  /** `YYYY-MM-DD`, latest across all three sources. */
  offDate: string;
  /** Reason on that record, when it carries one. */
  reason: string | null;
}

export interface CatalogVisibilityInput {
  /** Latest off-board evidence for this person, or null when there is none.
   *  Must be matched on the person's WORK email — a personal inbox is shared
   *  across duplicate master identities, so matching on it imports someone
   *  else's departure (`loadOffboardEvidenceByEmail('work')`). */
  evidence: CatalogOffboardEvidence | null;
  /** The person's own master-list Start Date, normalized (`normalizeMasterDate`).
   *  Null when the cell is blank or unparseable. */
  startDate: string | null;
  /** Sunday of the pay week currently being processed (`payrollNotesWeekStart`). */
  cycleWeekStart: string;
  /** True when this person has a row in the current cycle's Hubstaff timesheet. */
  hasCycleHours: boolean;
}

/**
 * Reasons that mean a person actually LEFT — an ALLOWLIST, deliberately.
 *
 * `off_boarded_reason` is free text and holds far more than the canonical enum.
 * Measured across the 688 stamped `global_master_list` rows and the 3,816
 * `offboarded_sheet` rows on 2026-08-21: both casings of every enum value
 * (`Performance` 107 / `performance` 167), sheet-authored labels
 * (`Policy Violation`, `No Show During Orientation`, `Declined Offer`,
 * `Reschedule For Next Week`, `Agent Passed Away`, even `Active`), and — the
 * dangerous ones — **synthetic markers that are not departures at all**:
 * `duplicate_cleanup` (94 rows, migration #65 retiring duplicate
 * (Work Email, Department) rows, its own note says "Reversible") and
 * `sheet_sync` (2). `jan@simple.biz` carries one of those across 95 master rows
 * while working normally.
 *
 * A denylist would have to grow every time someone invents a marker, and every
 * miss hides a live person. An allowlist inverts that: an unrecognised or absent
 * reason keeps them visible. It costs nothing today — all 178 people the filter
 * currently hides carry a canonical value (`performance` 96, `ncns` 48,
 * `resigned` 18, `other` 11, `attendance` 4, `time_manipulation` 1).
 *
 * `temporary_pause` is excluded from the list on purpose: it suspends the
 * Workspace account for approved leave and the person returns via re-onboard.
 * Hiding them would take a still-employed person's rate off the surface that
 * sets it — the mirror image of the hazard `isEligibleForFinalPayReview` guards
 * on the final-pay list.
 */
const DEPARTURE_REASONS: ReadonlySet<string> = new Set(
  VALID_OFFBOARD_REASONS.filter((r) => r !== 'temporary_pause'),
);

/** Free text → comparable key: `"Temporary Pause"` and `temporary_pause` are the
 *  same reason, and both appear in the data. */
function reasonKey(raw: string | null): string | null {
  const k = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return k || null;
}

/**
 * True when this active-roster person should be dropped from the Payment
 * Catalog's people surfaces.
 *
 * All four must hold:
 *
 *  1. **There is evidence of an actual DEPARTURE.** No record ⇒ on the roster ⇒
 *     shown, and a record whose reason is not a canonical departure (a
 *     `duplicate_cleanup` migration marker, a `temporary_pause` suspension, a
 *     sheet-authored label nobody recognises, a blank) ⇒ also shown.
 *     Note what this does *not* test: hours. A zero-hours active member still
 *     shows, which is the whole point of the
 *     catalog-visible-dispatch-absent-means-no-hours ruling — absence from a
 *     money surface is not evidence of off-boarding.
 *
 *  2. **The record post-dates the person's own Start Date.** A re-hire inherits
 *     their predecessor's stamp, or their own previous stint's, and the master
 *     Start Date is what separates the two. Same guard Payroll Readiness applies
 *     before it will even *label* someone "Left". An unparseable start date
 *     fails safe: keep them.
 *
 *  3. **They left before the week being paid.** Payroll runs a week in arrears,
 *     so someone who left during or after the current cycle may still need a
 *     final-pay rate set. (Their dedicated home is Payroll Notes → Offboarded,
 *     but the rate source of truth should not go dark on them mid-run.)
 *
 *  4. **They have no hours in the current cycle's timesheet.** The stamps lie:
 *     18 people carrying evidence that clears guards 2 and 3 logged hours in the
 *     Aug 9–15 file — re-hires whose master Start Date never moved (Sherwin
 *     Santos, Kevin Cosico, both named in the readiness-bank-offboard-aging
 *     memory), plus `jeff@` and `jan@`. A timesheet row cannot be forged by a
 *     stale stamp: either the week has you or it does not.
 *
 * Callers must fail OPEN — an unresolvable evidence or timesheet read hides
 * nobody. See `loadCatalogOffboardedEmails`.
 */
export function isOffboardedForPaymentCatalog(input: CatalogVisibilityInput): boolean {
  const { evidence, startDate, cycleWeekStart, hasCycleHours } = input;
  if (!evidence) return false;
  const reason = reasonKey(evidence.reason);
  if (!reason || !DEPARTURE_REASONS.has(reason)) return false;
  if (!startDate || evidence.offDate <= startDate) return false;
  if (!cycleWeekStart || evidence.offDate >= cycleWeekStart) return false;
  if (hasCycleHours) return false;
  return true;
}
