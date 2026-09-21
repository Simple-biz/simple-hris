/**
 * Employee Support — the queueing line, the board, and the two counts.
 *
 * Plan: docs/superpowers/plans/2026-09-21-employee-support-tickets-board.md
 * (task 4). Pure: no I/O, no Supabase, no clock of its own — every function
 * that needs "now" is handed one, so a test can pin it and two readers can
 * never disagree about what day it is.
 *
 * KANE'S TWO STAGES ARE DERIVED, NEVER STORED
 * ---------------------------------------------------------------------------
 * "There should be a queing line then they rank it by urgency which goes up to
 * the board" (2026-09-18). Ranking IS the promotion, so there is no third state
 * between the two and no `triage_state` column:
 *
 *     in the line  <->  priority is null
 *     on the board <->  priority is not null
 *
 * A second status axis would force somebody to answer "can a closed ticket be
 * in the line?". A derived stage never has to.
 *
 * THE COUNTS SPAN BOTH STAGES, AND THAT IS NOT AN IMPLEMENTATION DETAIL
 * ---------------------------------------------------------------------------
 * Carla signed "One screen listing every question" and "Counts at a glance: how
 * many need a reply, how many were answered today". A line plus a board is two
 * lists; a count scoped to one of them hides exactly the work the split
 * created. {@link supportCounts} therefore takes the WHOLE open set and
 * partitions it — it is never handed one stage.
 *
 * STARVATION IS THE FAILURE MODE OF A LINE
 * ---------------------------------------------------------------------------
 * An un-triaged ticket nobody ranks never reaches the board. That is why the
 * line is the default view and why {@link supportCounts} counts it — a backlog
 * nobody can see is the same as a backlog nobody has.
 */

import { needsStaffReply, type SupportStatus } from './types';
import { TICKET_PRIORITIES, type TicketPriority } from '@/lib/tickets/types';

/**
 * The support side's priority: the dev board's four values, plus null.
 *
 * The VALUES are shared so the two boards speak one language
 * (`src/lib/tickets/types.ts:33`). The COLUMN is not: `public.tickets.priority`
 * is `not null default 'medium'` and this one is nullable, because null carries
 * a meaning the dev board has no use for.
 *
 * >> NEVER widen `TICKET_PRIORITIES` or `TICKET_PRIORITY_LABELS` to admit null
 * >> or a fifth 'none'. That Record is total over four keys and the dev board
 * >> depends on it. The nullability lives HERE, on the side that needs it.
 */
export type SupportPriority = TicketPriority | null;

/** Which of Kane's two stages a ticket is in. Derived, never stored. */
export type TicketStage = 'line' | 'board';

/** The least a row needs for any of this. A superset is fine; this is the contract. */
export type TriageRow = {
  status: SupportStatus;
  priority: SupportPriority;
  /** When the EMPLOYEE filed it. The waiting clock, and never the triage time. */
  created_at: string;
  first_response_at: string | null;
};

/**
 * Rank order, high to low. Declared as an explicit map rather than the index of
 * `TICKET_PRIORITIES`, because that array's order is a display order on another
 * surface and nothing there promises it is also a severity order.
 */
const PRIORITY_RANK: Record<TicketPriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function isSupportPriority(value: unknown): value is TicketPriority {
  return typeof value === 'string' && (TICKET_PRIORITIES as readonly string[]).includes(value);
}

/** `null` is the line. Anything else is the board. One place, both readers. */
export function stageOf(row: Pick<TriageRow, 'priority'>): TicketStage {
  return row.priority === null ? 'line' : 'board';
}

/**
 * Still somebody's problem. Mirrors the SQL's `..._open_idx` predicate
 * (`status in ('open','claimed')`) so the index and this agree about what
 * "open" means — if they drift, the read stops using the index and nothing
 * says so.
 */
export function isOpenTicket(row: Pick<TriageRow, 'status'>): boolean {
  return row.status === 'open' || row.status === 'claimed';
}

/**
 * THE SORT. Urgency descending, then longest-waiting first inside each band.
 *
 * Both halves are load-bearing and they come from different people:
 *
 *   - Urgency first is Kane's, 2026-09-18 — "they can rank it", and a rank that
 *     did not outrank age would not be a rank.
 *   - Longest-waiting inside the band is CARLA'S, signed: "sorted so the
 *     longest-waiting unanswered question is at the top, not the newest". Her
 *     rule survives underneath his, rather than being replaced by it.
 *
 * Age is measured from `created_at` — when the EMPLOYEE FILED — never from
 * `triaged_at`. Time a ticket spent sitting in the line unranked is time the
 * one-working-day promise was already burning, and dating the wait from triage
 * would hide precisely the delay the line introduces.
 *
 * Ties break three deep: rank, then filing instant, then the raw stamp string.
 * The last one is not paranoia — Postgres keeps `timestamptz` to the
 * microsecond and `Date.parse` truncates to the millisecond, so two rows the
 * server already ordered can parse equal and would otherwise swap between
 * reads, moving a row under somebody's cursor.
 */
export function compareBoard(a: TriageRow, b: TriageRow): number {
  const ra = a.priority === null ? 0 : PRIORITY_RANK[a.priority];
  const rb = b.priority === null ? 0 : PRIORITY_RANK[b.priority];
  if (ra !== rb) return rb - ra;

  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  const va = Number.isFinite(ta);
  const vb = Number.isFinite(tb);
  // An unparseable stamp sorts LAST rather than throwing: one bad row must not
  // take the whole board down, and last is where somebody will notice it.
  if (!va || !vb) {
    if (va !== vb) return va ? -1 : 1;
  } else if (ta !== tb) {
    return ta - tb;
  }
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

/** Non-mutating, so a component cannot reorder the caller's array underneath it. */
export function sortBoard(rows: readonly TriageRow[]): TriageRow[] {
  return [...rows].sort(compareBoard);
}

/**
 * Split the open set into Kane's two stages, each already in display order.
 *
 * The LINE is sorted by the same comparator, which for an all-null-priority set
 * degenerates to longest-waiting first — so the two stages cannot disagree
 * about what "top" means, and a ticket does not jump when it is ranked.
 */
export function partitionStages(rows: readonly TriageRow[]): {
  line: TriageRow[];
  board: TriageRow[];
} {
  const open = rows.filter(isOpenTicket);
  return {
    line: sortBoard(open.filter((r) => stageOf(r) === 'line')),
    board: sortBoard(open.filter((r) => stageOf(r) === 'board')),
  };
}

/** What Carla asked to see at a glance. `null` anywhere means WE COULD NOT TELL. */
export type SupportCounts = {
  /** Open, never answered — across BOTH stages. */
  needsReply: number | null;
  /** First staff reply stamped today, in the support zone. */
  answeredToday: number | null;
  /** Still un-triaged. Not Carla's, but the number that makes starvation visible. */
  inLine: number | null;
  /** FALSE means the numbers are unknown and the UI owes a skeleton, never a 0. */
  resolved: boolean;
};

/** Nothing read yet. Frozen: a shared singleton a caller mutated would poison every other. */
export const COUNTS_UNRESOLVED: Readonly<SupportCounts> = Object.freeze({
  needsReply: null,
  answeredToday: null,
  inLine: null,
  resolved: false,
});

/**
 * "Answered today" is a calendar day in the SUPPORT zone, and the support zone
 * is Eastern (Carla's Decision 3; Kane confirmed 2026-09-18 that every employee
 * is on EST too). It is deliberately NOT `manilaDayIso`, which the rest of the
 * HRIS uses for pay weeks and Penny's allowance.
 *
 * The answerers read this number during their own working day, so it has to
 * roll over at their midnight. A Manila day would reset it at roughly noon
 * their time — mid-shift, with half the morning's answers vanishing from a
 * count somebody is using to decide whether they are keeping up.
 */
export const SUPPORT_COUNT_ZONE = 'America/New_York';

/** `YYYY-MM-DD` in the support zone. `en-CA` formats exactly that way. */
export function supportDayIso(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SUPPORT_COUNT_ZONE }).format(at);
}

/**
 * The two counts Carla signed, plus the line depth.
 *
 * Takes the WHOLE set, never one stage — see the header. A `null` row array is
 * "the read failed", which returns {@link COUNTS_UNRESOLVED} rather than zeroes:
 * "nobody needs a reply" and "we could not look" are different things to put in
 * front of somebody deciding whether to go home.
 */
export function supportCounts(
  rows: readonly TriageRow[] | null,
  now: Date,
): SupportCounts {
  if (!rows) return { ...COUNTS_UNRESOLVED };

  const today = supportDayIso(now);
  let needsReply = 0;
  let answeredToday = 0;
  let inLine = 0;

  for (const row of rows) {
    if (needsStaffReply(row)) needsReply += 1;
    if (isOpenTicket(row) && stageOf(row) === 'line') inLine += 1;

    const first = row.first_response_at;
    if (first !== null) {
      const parsed = new Date(first);
      // An unparseable stamp is not today. It is also not a crash: one bad row
      // must not blank a number the whole team is reading.
      if (!Number.isNaN(parsed.getTime()) && supportDayIso(parsed) === today) {
        answeredToday += 1;
      }
    }
  }

  return { needsReply, answeredToday, inLine, resolved: true };
}
