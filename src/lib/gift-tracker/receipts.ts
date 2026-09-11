/**
 * Tenure-gift FULFILMENT state — the one place that decides whether a gift is
 * received, owed, not yet due, or simply unknown.
 *
 * Shared by the backfill importer, the API route, the Gift Tracker roster and
 * the roster export, for the same reason `gift-milestones.ts` is shared: the
 * screen, the file and the script must never disagree about who Simple owes.
 *
 * FOUR STATES, AND `unknown` IS LOAD-BEARING
 * ------------------------------------------
 *   received   somebody stated the gift was given.
 *   owed       the milestone has come due AND somebody stated it was not given.
 *   not_due    the milestone has not arrived yet. Nothing is owed.
 *   unknown    nobody has stated anything about a milestone that HAS come due.
 *
 * `unknown` exists because 239 people on the active roster were absent from the
 * 2026-09-11 source sheet entirely. Collapsing them into `owed` invents a
 * backlog; collapsing them into `received` hides one. Neither is true, so the
 * type refuses to say either — see docs/features/gift-tracker-receipts.md.
 *
 * A person with no start date cannot have a due milestone at all, so every
 * milestone is `unknown` for them rather than silently `not_due`.
 */
import {
  addMonths,
  diffDays,
  milestoneLabel,
  MONTHS_PER_MILESTONE,
} from '@/lib/gift-milestones';

export { milestoneLabel };

/** Upper bound on milestone_index, matching the loop cap in `gift-milestones.ts`. */
export const MAX_MILESTONE_INDEX = 60;

export type GiftReceiptState = 'received' | 'owed' | 'not_due' | 'unknown';

/**
 * The date a given milestone falls on, by the ONE date rule
 * (`gift-milestones.ts`). Do not inline `addMonths` at a call site — the whole
 * point of routing through here is that there is a single implementation.
 */
export function milestoneDateFor(start: Date, milestoneIndex: number): Date {
  return addMonths(start, milestoneIndex * MONTHS_PER_MILESTONE);
}

/**
 * Has this milestone arrived? Day-grain, via `diffDays`, so a milestone falling
 * today counts as due.
 *
 * A null start date is not "not due" — it is unanswerable, and the caller must
 * treat it as such. It returns false here only so this predicate stays total;
 * `receiptStateFor` maps the null start to `unknown` before this matters.
 */
export function isMilestoneDue(
  start: Date | null,
  milestoneIndex: number,
  today: Date,
): boolean {
  if (!start) return false;
  return diffDays(milestoneDateFor(start, milestoneIndex), today) <= 0;
}

/**
 * Resolve one (person, milestone) to its state.
 *
 * `received` is `undefined` when no receipt row exists — that is the UNKNOWN
 * case and it must never be coerced to `false`. The parameter is deliberately
 * `boolean | undefined` rather than `boolean` with a default for exactly that
 * reason.
 *
 * A `received: true` assertion wins even on a milestone that has not come due.
 * The source sheet carries one such cell (rhysl@simple.biz, milestone 2, dated
 * 2027-01-05) and dropping it would discard a stated fact; the tracker flags it
 * instead, via `isEarlyReceipt`.
 */
export function receiptStateFor(args: {
  start: Date | null;
  milestoneIndex: number;
  today: Date;
  received: boolean | undefined;
}): GiftReceiptState {
  const { start, milestoneIndex, today, received } = args;
  if (received === true) return 'received';
  if (!start) return 'unknown';
  if (!isMilestoneDue(start, milestoneIndex, today)) return 'not_due';
  return received === false ? 'owed' : 'unknown';
}

/**
 * True when a gift was recorded as received before its milestone arrived. Not
 * an error state — it is a discrepancy worth showing rather than swallowing.
 */
export function isEarlyReceipt(args: {
  start: Date | null;
  milestoneIndex: number;
  today: Date;
  received: boolean | undefined;
}): boolean {
  const { start, milestoneIndex, today, received } = args;
  if (received !== true || !start) return false;
  return !isMilestoneDue(start, milestoneIndex, today);
}

export interface GiftMilestoneReceipt {
  milestoneIndex: number;
  /** `null` when the person has no start date, so no date can be computed. */
  date: Date | null;
  /** "6-month", "12-month", … */
  label: string;
  state: GiftReceiptState;
  /** Recorded early — received before the milestone arrived. */
  early: boolean;
}

export interface GiftPersonReceiptSummary {
  milestones: GiftMilestoneReceipt[];
  /** Milestones that have come due (received + owed + unknown). */
  dueCount: number;
  receivedCount: number;
  /** What Simple owes this person right now. */
  owedCount: number;
  /** Due milestones nobody has said anything about. */
  unknownCount: number;
  /** Lowest-indexed owed milestone — the oldest debt. `null` when none. */
  oldestOwed: GiftMilestoneReceipt | null;
}

/**
 * Every milestone this person has reached (plus any milestone an assertion
 * exists for, so an early `received` is never dropped), each resolved to a
 * state.
 *
 * Walks only as far as it must: the last due milestone, or the highest index
 * carrying an assertion, whichever is greater — capped at MAX_MILESTONE_INDEX.
 * A person with no start date and no receipts yields an empty list, which is
 * the honest answer, not a bug.
 */
export function buildPersonReceiptSummary(args: {
  start: Date | null;
  today: Date;
  /** milestone_index → received. Absent key = no assertion on record. */
  receiptsByIndex: ReadonlyMap<number, boolean>;
}): GiftPersonReceiptSummary {
  const { start, today, receiptsByIndex } = args;

  let lastDue = 0;
  if (start) {
    for (let i = 1; i <= MAX_MILESTONE_INDEX; i += 1) {
      if (!isMilestoneDue(start, i, today)) break;
      lastDue = i;
    }
  }
  const highestAsserted = receiptsByIndex.size
    ? Math.max(...receiptsByIndex.keys())
    : 0;
  const walkTo = Math.min(Math.max(lastDue, highestAsserted), MAX_MILESTONE_INDEX);

  const milestones: GiftMilestoneReceipt[] = [];
  for (let i = 1; i <= walkTo; i += 1) {
    const received = receiptsByIndex.get(i);
    milestones.push({
      milestoneIndex: i,
      date: start ? milestoneDateFor(start, i) : null,
      label: milestoneLabel(i),
      state: receiptStateFor({ start, milestoneIndex: i, today, received }),
      early: isEarlyReceipt({ start, milestoneIndex: i, today, received }),
    });
  }

  const receivedCount = milestones.filter((m) => m.state === 'received').length;
  const owedCount = milestones.filter((m) => m.state === 'owed').length;
  const unknownCount = milestones.filter((m) => m.state === 'unknown').length;

  return {
    milestones,
    dueCount: lastDue,
    receivedCount,
    owedCount,
    unknownCount,
    oldestOwed: milestones.find((m) => m.state === 'owed') ?? null,
  };
}
