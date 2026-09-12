/**
 * What the public gift-address page shows one person, and what their address
 * is collected FOR.
 *
 * Pure and total — no I/O, no clock of its own. The route supplies the roster
 * start date, the fulfilment rows and the submissions already on file.
 *
 * WHY THIS IS NOT "THE CURRENT MILESTONE"
 * ---------------------------------------
 * The in-app employee form asks only about the milestone whose 30-day window is
 * open and freezes everything earlier as read-only. That is why the 592 gifts
 * recorded as owed on 2026-09-11 had no address-collection path at all — the
 * people owed a gift from two years ago could not tell anyone where to send it.
 * Kane, 2026-09-12: *"They should be able to see all the gifts they are owed
 * since their start dates."* So this walks EVERY milestone they have reached.
 *
 * "PENDING" IS NOT A PROMISE
 * --------------------------
 * A reached milestone that is not recorded as received is either `owed` (someone
 * stated it was missed) or `unknown` (nobody has assessed it — 239 active people
 * were absent from the source sheet entirely). **Both are collected for, and
 * both are presented the same way**, because the distinction is about OUR
 * bookkeeping and the employee cannot act on it. Telling someone "you are owed
 * this gift" when the truth is "we never checked" would promise a parcel that
 * may already have arrived; the copy says we have their address on file for it,
 * which is true either way.
 *
 * Anything already recorded as RECEIVED is shown as received and is never
 * collected for — the page celebrates it rather than asking again.
 */
import { milestoneLabel } from '@/lib/gift-milestones';
import { isMilestoneDue, milestoneDateFor, MAX_MILESTONE_INDEX } from '@/lib/gift-tracker/receipts';
import { giftMilestoneMessage, tenureLabel } from '@/lib/gift-tracker/milestone-copy';

/** What the employee is shown for one milestone. */
export type GiftAskState = 'received' | 'pending';

export interface GiftAskMilestone {
  milestoneIndex: number;
  /** ISO date (YYYY-MM-DD) the milestone fell on. */
  date: string;
  /** "6-month" — the internal label, shared with the tracker and the export. */
  label: string;
  /** "1 Year" — the celebratory label the employee sees. */
  tenure: string;
  /** The milestone's thank-you copy, shared with the employee dashboard card. */
  message: string;
  state: GiftAskState;
  /** True when a delivery address is already on file for this milestone. */
  hasAddress: boolean;
}

export interface GiftAsk {
  /** Every milestone reached, oldest first. */
  milestones: GiftAskMilestone[];
  /** The indexes the submitted address will be written against. */
  collectFor: number[];
  receivedCount: number;
  pendingCount: number;
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Build the page's model.
 *
 * `receiptsByIndex` maps milestone_index → received. An ABSENT key means nobody
 * has assessed that milestone, which is `pending` here — never `received`.
 * Coercing an absence to received would hide a real debt from the one person who
 * would notice.
 *
 * A person with no start date reaches nothing: the walk is empty and
 * `collectFor` is empty, so the page asks for no address rather than inventing a
 * milestone. That is a roster problem to fix upstream, not something to paper
 * over with a guess.
 */
export function buildGiftAsk(args: {
  start: Date | null;
  today: Date;
  receiptsByIndex: ReadonlyMap<number, boolean>;
  /** milestone_index values that already have a submitted address. */
  submittedIndexes: ReadonlySet<number>;
}): GiftAsk {
  const { start, today, receiptsByIndex, submittedIndexes } = args;

  const milestones: GiftAskMilestone[] = [];
  if (start) {
    for (let i = 1; i <= MAX_MILESTONE_INDEX; i += 1) {
      if (!isMilestoneDue(start, i, today)) break;
      const received = receiptsByIndex.get(i) === true;
      milestones.push({
        milestoneIndex: i,
        date: isoOf(milestoneDateFor(start, i)),
        label: milestoneLabel(i),
        tenure: tenureLabel(i * 6),
        message: giftMilestoneMessage(i),
        state: received ? 'received' : 'pending',
        hasAddress: submittedIndexes.has(i),
      });
    }
  }

  const pending = milestones.filter((m) => m.state === 'pending');
  return {
    milestones,
    collectFor: pending.map((m) => m.milestoneIndex),
    receivedCount: milestones.length - pending.length,
    pendingCount: pending.length,
  };
}
