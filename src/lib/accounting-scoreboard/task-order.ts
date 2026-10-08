/**
 * Rearranging a task list (Aliviah, relayed by Kane 2026-10-08: "each user could rearrange their task list").
 * Pure: the server reads, this decides, the server writes.
 *
 * The rules:
 *   - One request orders ONE owner's live tasks of ONE frequency: a task never moves between frequency cards (that is
 *     "change how often", which makes a new task).
 *   - The request lists EVERY live task in that card, each once. A list that misses one (it was added since the page
 *     loaded) or names one that is gone is refused as stale, never applied in part: nothing drops out of the order.
 *   - The new order is written as sort_order 0, 1, 2… within the card. Only rows whose number changes are written.
 *     New tasks still go last: createTask takes the owner's highest sort_order + 1, across every card.
 * Who may: the owner (by any of their addresses), or an Admin. That check is the server's (it knows the viewer).
 *
 * Governing doc: docs/features/accounting-scoreboard-tasks.md § Rearranging a list.
 */

import type { TaskFrequency } from './tasks';

/** At most this many ids in one request: a card is never near it, and it keeps `.in('id', …)` far below the URL ceiling. */
export const TASK_ORDER_MAX = 100;

export interface OrderableTask {
  id: string;
  ownerEmail: string;
  frequency: TaskFrequency;
  sortOrder: number;
  createdAt: string;
  archived: boolean;
}

export type OrderPlan =
  | { ok: true; ownerEmail: string; frequency: TaskFrequency; updates: Array<{ id: string; sortOrder: number }> }
  | { ok: false; status: 404 | 409 | 422; code: string; message: string };

const STALE = 'This list changed since it was loaded. Refresh and try again.';

/**
 * `named` = the tasks the ids name (any state); `card` = every LIVE task of the first named task's owner and frequency.
 */
export function planTaskOrder(ids: readonly string[], named: readonly OrderableTask[], card: readonly OrderableTask[]): OrderPlan {
  const byId = new Map(named.map((t) => [t.id, t]));
  const first = byId.get(ids[0] ?? '');
  if (!first || ids.some((id) => !byId.has(id))) {
    return { ok: false, status: 404, code: 'not_found', message: 'A task in this list is not on the board any more. Refresh and try again.' };
  }
  if (ids.some((id) => byId.get(id)!.archived)) return { ok: false, status: 409, code: 'stale', message: STALE };
  const { ownerEmail, frequency } = first;
  if (ids.some((id) => byId.get(id)!.ownerEmail !== ownerEmail)) {
    return { ok: false, status: 422, code: 'mixed_owners', message: "Tasks from two people's boards can't be ordered together." };
  }
  if (ids.some((id) => byId.get(id)!.frequency !== frequency)) {
    return {
      ok: false,
      status: 422,
      code: 'mixed_frequencies',
      message: 'A task stays in its own card. To move it to another card, change how often it is done.',
    };
  }
  const live = card.filter((t) => !t.archived && t.ownerEmail === ownerEmail && t.frequency === frequency);
  if (live.length !== ids.length || live.some((t) => !ids.includes(t.id))) {
    return { ok: false, status: 409, code: 'stale', message: STALE };
  }
  const current = new Map(live.map((t) => [t.id, t.sortOrder]));
  const updates = ids.flatMap((id, i) => (current.get(id) === i ? [] : [{ id, sortOrder: i }]));
  return { ok: true, ownerEmail, frequency, updates };
}

/** The board's order: sort_order, then oldest first, then id. The server sorts the same way. */
export function compareTaskOrder(
  a: Pick<OrderableTask, 'sortOrder' | 'createdAt' | 'id'>,
  b: Pick<OrderableTask, 'sortOrder' | 'createdAt' | 'id'>,
): number {
  return a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
