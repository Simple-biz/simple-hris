/**
 * What an APPROVED time adjustment makes a day's hours — the one rule, shared by
 * every surface that overlays adjustments onto tracked time.
 *
 * ## Why this exists (Kane, 2026-09-15)
 *
 * *"When it gets sent to accounting please lets just approve it or deny it we dont
 * need to put in the hours as the Employee side was already sent."*
 *
 * Until now Accounting typed the day's FINAL total and it was stored in
 * `approved_hours` as a SET-semantics override. Removing that input means the number
 * has to come from somewhere, and the only honest source is the submission itself:
 * the employee's `requested_segments` say exactly which time was missed, and
 * `requested_hours` is their sum.
 *
 * So an approved adjustment now means **"add the missed time the employee evidenced
 * to whatever was tracked that day"**, and the day total is derived at read time
 * rather than frozen at approval. That is strictly better than freezing it: a later
 * Hubstaff correction to the same day flows through instead of being overwritten by
 * a stale total. It is also the same number a clerk typed when they typed correctly,
 * so it is a no-op on correct history.
 *
 * ## A stored total always wins
 *
 * Rows approved before this change carry a real `approved_hours`, and so would any
 * future manual correction. Those are STATEMENTS by a human about that day and are
 * never recomputed — recomputing them would silently restate an already-paid figure.
 * The derivation only fills in where no total was ever stored.
 *
 * ## Why a shared function rather than six copies
 *
 * Six surfaces overlay approved adjustments onto tracked hours: the Payroll Wizard
 * (pay + PAB), the live pay estimate, HSL monthly pay, the Accounting Overview and
 * the employee's own attendance calendar. They key their day maps differently and
 * each already holds its own tracked figure, so this takes the tracked hours as an
 * argument and returns the day total. The RULE lives in one place; the lookup stays
 * where it already works. See `docs/features/time-adjustment-requests.md` § Pay wiring.
 */
import { pabDateKey } from '@/lib/hubstaff/calendar-column-dedupe';

/** The fields of a `time_adjustment_requests` row this rule reads. */
export type ApprovedAdjustmentFacts = {
  /** The day total a human stored, when one was ever stored. Wins outright. */
  approved_hours: number | null;
  /** Sum of `requested_segments` — the MISSED time to add. Never a day total. */
  requested_hours: number | null;
  /**
   * The missed time ranges. Their PRESENCE is what makes `requested_hours` a delta:
   * rows filed before 2026-07-17 stored a claimed day total in the same column, so a
   * row without segments must never be added to tracked hours.
   */
  requested_segments?: readonly unknown[] | null;
};

/**
 * The day's hours after an approved adjustment, or `null` when this row cannot say.
 *
 * `null` means "apply nothing" and is what every caller already does with a row it
 * cannot use, so an unusable row keeps behaving exactly as it did before.
 *
 * @param trackedHours what Hubstaff recorded for that day, in hours. 0 is a real
 *   value — a day nobody tracked is exactly the case these requests exist for.
 */
export function approvedAdjustmentDayHours(
  row: ApprovedAdjustmentFacts,
  trackedHours: number,
): number | null {
  // 1. A stored total is a human's statement about the day. Never recomputed.
  if (row.approved_hours != null && Number.isFinite(row.approved_hours) && row.approved_hours >= 0) {
    return row.approved_hours;
  }

  // 2. No stored total: add the evidenced missed time to what was tracked. Segments
  //    are REQUIRED here — without them `requested_hours` is a legacy day total and
  //    adding it would double-count the whole day.
  const segments = row.requested_segments ?? [];
  if (segments.length === 0) return null;

  const missed = row.requested_hours;
  if (missed == null || !Number.isFinite(missed) || missed <= 0) return null;

  const tracked = Number.isFinite(trackedHours) && trackedHours > 0 ? trackedHours : 0;
  return tracked + missed;
}

/**
 * Fold approved adjustments into a PAB "forgiven dates" map, resolving each one
 * against the tracked seconds for that day.
 *
 * The two server PAB paths — the dispatch engine and HSL monthly pay — both hold
 * their day hours as SECONDS keyed by {@link pabDateKey}, while adjustments and
 * disputes are keyed by ISO date. This is the one place that bridge is written.
 * Adjustments overlay a same-day dispute, matching the wizard's `effectiveOverrides`
 * ordering: the adjustment is the explicit "this is the real number" decision.
 *
 * Returns the original map untouched when there is nothing to fold in, so a caller
 * with no adjustments pays no cost and behaves exactly as it did before.
 */
export function mergeAdjustmentsIntoForgivenDates(
  forgiven: Map<string, number | null> | undefined,
  adjustments: Map<string, ApprovedAdjustmentFacts> | undefined,
  trackedSecondsByPabKey: Map<string, number>,
): Map<string, number | null> | undefined {
  if (!adjustments?.size) return forgiven;
  const merged = new Map<string, number | null>(forgiven ?? []);
  for (const [isoDate, facts] of adjustments) {
    const parts = isoDate.split('-');
    if (parts.length !== 3) continue;
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (Number.isNaN(d.getTime())) continue;
    const trackedHours = (trackedSecondsByPabKey.get(pabDateKey(d)) ?? 0) / 3600;
    const dayHours = approvedAdjustmentDayHours(facts, trackedHours);
    if (dayHours == null) continue;
    merged.set(isoDate, dayHours);
  }
  return merged;
}

/**
 * True when this row's day total has to be derived from tracked hours — i.e. it was
 * approved without anyone entering a total. Used by the surfaces that must look up
 * tracked hours before they can place the row on a calendar.
 */
export function adjustmentNeedsTrackedHours(row: ApprovedAdjustmentFacts): boolean {
  if (row.approved_hours != null && Number.isFinite(row.approved_hours) && row.approved_hours >= 0) {
    return false;
  }
  return (row.requested_segments ?? []).length > 0;
}
