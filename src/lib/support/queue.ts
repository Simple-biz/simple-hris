/**
 * Employee Support LIVE CHAT — the queue, as arithmetic.
 *
 * `chat-types.ts` is the vocabulary and `chat-live.ts` is the wire; this is the
 * third sibling and it owns exactly one question: **given the set of people
 * waiting, where is this one, and how sure are we?** Nothing here touches the
 * network, a clock, or Supabase — hand it rows, get a rank.
 *
 * WHY A MODULE AND NOT TWENTY LINES IN THE ROUTE
 * ---------------------------------------------------------------------------
 * It is already twenty lines in the route AND twenty lines in the component:
 * `app/api/employee/support/chat/route.ts:105-122` and `:260-273` declare
 * `QueueRow`, `QueueState`, `QUEUE_UNRESOLVED` and `queueStateFor`, and
 * `src/components/employee/EmployeeSupportChat.tsx:133-139` declares the same
 * `QueueState` and the same `QUEUE_UNRESOLVED` a second time. Two copies of an
 * ordering rule are two chances to order differently, and the invariant at
 * stake — *a position never rises* — is precisely the one that breaks when two
 * readers of the same set disagree about what "first" means. Plan task 5 names
 * this file; both of those are meant to import it.
 *
 * THE THREE RULES THIS FILE EXISTS TO HOLD
 * ---------------------------------------------------------------------------
 * 1. **"Nobody is waiting" and "we cannot tell" are different states and must
 *    never both render as `0`** (plan `:91-92`). So a position is
 *    `number | null` where **null means UNKNOWN**, carried alongside a
 *    `resolved` flag that says which kind of null it is: `resolved: true` with
 *    `position: null` is "you are not in the line"; `resolved: false` is "we
 *    could not work it out, show a skeleton". A count of `0` is a fact, and it
 *    is only ever written when we counted.
 * 2. **A position never rises** (plan `:93-94`). Rank is `queued_at` and
 *    nothing else. `queued_at` is stamped once and the DB trigger RAISES on any
 *    attempt to move it (SQL `:363-369`), so an agent who claims a chat and
 *    then disconnects returns the employee to the line with their ORIGINAL
 *    stamp and their original rank falls straight back out of this function.
 *    There is deliberately no special case for it: the rule is structural, not
 *    a branch someone can forget.
 * 3. **The ordering lives here, so a component cannot re-derive it.**
 *    {@link compareQueueRank} is the one comparator, {@link queuePositionFor}
 *    applies it to whatever order the caller happened to receive, and no export
 *    trusts the caller's array order. A caller that sorted differently gets the
 *    same answer as one that did not sort at all.
 *
 * WHAT THIS FILE CANNOT DO FOR YOU
 * ---------------------------------------------------------------------------
 * **Page the read.** PostgREST caps a result set at 1000 rows with no error and
 * no flag — even with an explicit `.range(0, 99999)`
 * (`src/lib/supabase/select-all-paged.ts:4-11`) — and a truncated set is
 * indistinguishable from a short one once it is an array in memory. A caller
 * that reads the waiting set with anything but `selectAllPaged` gets a
 * confident, well-typed, wrong number out of this module, and this module never
 * knows. `queue.test.ts` demonstrates the exact lie at the boundary.
 *
 * Plan: docs/superpowers/plans/2026-09-19-employee-support-chat.md (task 5).
 */

import { needsAnAgent, type ChatSessionStatus } from './chat-types';

/**
 * The two columns a rank needs, and deliberately no more.
 *
 * The queue read selects exactly this (`route.ts:245`) because the set is
 * materialised in full in order to be counted, so every extra column is paid
 * for once per waiter. `id` is not decoration — it is the tiebreak of last
 * resort, and the only way a caller can point at their own row in the set.
 */
export type QueueRank = { id: string; queued_at: string };

/**
 * Why a position is unknown. Diagnostic only — never rendered, because all four
 * read the same way to the employee ("we are still working it out") and which
 * read fell over is our problem, not theirs.
 */
export type QueueUnknownReason =
  /** Nothing has been read yet. The dialog's opening state. */
  | 'not_read'
  /** The read errored. We hold no opinion about the line's length either. */
  | 'read_failed'
  /**
   * The session says `waiting` but it is not in the set we just read — an agent
   * claimed it between the two reads. The line's size is still a fact; this
   * caller's own place is not, and the next poll settles it.
   */
  | 'not_in_set'
  /**
   * A stamp in the set would not parse, so "who is ahead" is not answerable.
   * `queued_at` is `timestamptz not null` (SQL `:118`) and cannot be malformed
   * coming out of the DB — but this module is also handed JSON, and an
   * unrankable row quietly sorted to one end would move somebody's place.
   */
  | 'unrankable';

/**
 * The caller's standing in the line.
 *
 * Field-for-field the shape already on the wire (`route.ts:108-120`,
 * `EmployeeSupportChat.tsx:133-137`) plus the optional `reason`, so adopting
 * this module is an import swap rather than a rewrite of the JSON contract.
 */
export type QueueState = {
  /** How many people are in the line. `null` when the queue could not be read. */
  waiting: number | null;
  /**
   * The caller's 1-based place. **`null` means one of two different things**,
   * and `resolved` is how you tell them apart: with `resolved: true` the caller
   * is genuinely not in the line (connected, ended, or never entered); with
   * `resolved: false` we could not work it out and the UI owes them a skeleton.
   */
  position: number | null;
  /** FALSE MEANS WE CANNOT TELL. Never render `0`, never render "you're next". */
  resolved: boolean;
  /** Present only when `resolved` is false. See {@link QueueUnknownReason}. */
  reason?: QueueUnknownReason;
};

/**
 * Nothing read yet. Frozen because it is a shared singleton, and a caller that
 * mutated it would corrupt every other caller's answer — the route and the
 * component each keep their own unfrozen copy today (`route.ts:122`,
 * `EmployeeSupportChat.tsx:139`).
 */
export const QUEUE_UNRESOLVED: Readonly<QueueState> = Object.freeze({
  waiting: null,
  position: null,
  resolved: false,
  reason: 'not_read' as const,
});

/** The read failed outright: we do not even know how long the line is. */
export const QUEUE_READ_FAILED: Readonly<QueueState> = Object.freeze({
  waiting: null,
  position: null,
  resolved: false,
  reason: 'read_failed' as const,
});

/**
 * PostgREST's silent cap, restated here for one reason: so `queue.test.ts` can
 * name the number the bug hides behind.
 *
 * There is deliberately **no** `looksTruncated(rows)` helper. A set of exactly
 * 1000 rows is a legitimate paged result as well as the signature of an unpaged
 * one, so such a helper would have to call a real queue unreadable in order to
 * catch a caller's mistake — and that mistake is already impossible for a
 * caller that uses `selectAllPaged`, which is the rule and not a suggestion.
 */
export const POSTGREST_MAX_ROWS = 1000;

/**
 * Parse a `queued_at` into a comparable instant. `null` when it will not parse.
 *
 * Not exported: a caller should be asking for a rank, not for a number it can
 * compare itself — comparing it itself is how the second ordering gets invented.
 */
function stampMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * THE ordering: longest-waiting first, three tiebreaks deep.
 *
 * 1. `queued_at` as an instant. This is the rank, and it is the whole rule.
 * 2. The RAW STRING, when two stamps land in the same millisecond. Postgres
 *    stores `timestamptz` to the microsecond and `Date.parse` truncates to the
 *    millisecond, so two rows 100µs apart are *equal* to JavaScript while the
 *    DB still has an opinion about them. The raw PostgREST stamps carry those
 *    digits and share one normalised offset format within a response, so
 *    comparing them as text recovers the precision the parse threw away — and
 *    agrees with the order `.order('queued_at')` produced server-side rather
 *    than quietly fighting it.
 * 3. `id`, so that the total order is total. Two rows identical to the
 *    microsecond have to break somewhere, and breaking on a uuid is at least
 *    stable across reads — which is the property that stops a position bouncing.
 *
 * An unparseable stamp sorts to the END rather than throwing, purely so this
 * comparator is safe to call on anything; {@link queuePositionFor} refuses to
 * answer at all when the set contains one, which is the behaviour that matters.
 */
export function compareQueueRank(a: QueueRank, b: QueueRank): number {
  const am = stampMs(a.queued_at);
  const bm = stampMs(b.queued_at);
  if (am === null || bm === null) {
    if (am === bm) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return am === null ? 1 : -1;
  }
  if (am !== bm) return am - bm;
  if (a.queued_at !== b.queued_at) return a.queued_at < b.queued_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The line in rank order. Copies rather than sorting in place: the argument is
 * very often the route's own paged read, and a function that quietly reorders
 * what it was handed is a function whose second caller gets a surprise.
 */
export function sortQueue(rows: readonly QueueRank[]): QueueRank[] {
  return [...rows].sort(compareQueueRank);
}

/**
 * Who an agent gets when they take "the next waiter" — the longest-waiting one,
 * never a specific one (plan `:30-31`).
 *
 * Returns `null` for an empty line AND for an unreadable one, which is safe
 * only because the two mean the same thing to THIS caller: there is nobody to
 * hand over either way. Anything that has to tell an employee the difference
 * asks {@link queuePositionFor}, which keeps them apart.
 */
export function nextWaiter(rows: readonly QueueRank[] | null): QueueRank | null {
  if (!rows || rows.length === 0) return null;
  let best: QueueRank | null = null;
  for (const row of rows) {
    if (best === null || compareQueueRank(row, best) < 0) best = row;
  }
  return best;
}

/**
 * Rank the caller against the line. **Never returns `0` for "we could not read
 * it"**, and never returns a position the caller did not earn.
 *
 * @param waiting every session whose status is `waiting`, in any order, or
 *   `null` when the read failed. It must be the WHOLE set — see the header.
 * @param session the caller's own session, or `null` when they have none. Only
 *   `id` and `status` are read, so a caller holding a full row passes it as-is.
 */
export function queuePositionFor(
  waiting: readonly QueueRank[] | null,
  session: { id: string; status: ChatSessionStatus } | null,
): QueueState {
  if (!waiting) return { ...QUEUE_READ_FAILED };

  // The line's length is a fact the moment the read succeeds, and it stays a
  // fact even when this caller's own place turns out not to be answerable.
  const count = waiting.length;

  // `needsAnAgent` rather than `status === 'waiting'`, so the definition of
  // "still in the line" lives in the vocabulary module beside every other one
  // (`chat-types.ts:127-135`). A claimed or live session is not in the queue: it
  // has left the front of it, which is the good outcome and not an unknown.
  if (!session || !needsAnAgent(session.status)) {
    return { waiting: count, position: null, resolved: true };
  }

  const ordered = sortQueue(waiting);

  // One unrankable stamp poisons EVERY position, not only its own row: if we
  // cannot say whether that row is ahead of the caller, we cannot say how many
  // people are. The count survives; the place does not.
  for (const row of ordered) {
    if (stampMs(row.queued_at) === null) {
      return { waiting: count, position: null, resolved: false, reason: 'unrankable' };
    }
  }

  const index = ordered.findIndex((row) => row.id === session.id);
  if (index < 0) {
    return { waiting: count, position: null, resolved: false, reason: 'not_in_set' };
  }

  return { waiting: count, position: index + 1, resolved: true };
}
