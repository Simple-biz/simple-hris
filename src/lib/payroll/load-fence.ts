/**
 * A monotonic ticket counter that lets an async loader ignore results from a
 * load that is no longer the newest one.
 *
 * Why this exists: the Payment Dispatch queue reloads from several triggers at
 * once — the `refresh()` after a Mark Paid, the 15 s signature poll, a remote
 * clerk's broadcast, a tab-focus refetch. Each load takes seconds (the pay
 * computation is slow). With no ordering, a load that STARTED before a Mark Paid
 * could FINISH after it, and its rows — still listing the person just paid —
 * overwrote the optimistic removal. The person reappeared in Pending, the clerk
 * paid them again, and the server (until 2026-09-03) accepted it.
 *
 * Usage: `const t = fence.start()` when a load begins; after every await,
 * `if (!fence.isCurrent(t)) return;` before touching state.
 */
export interface LoadFence {
  /** Begin a load; returns its ticket. Invalidates every earlier ticket. */
  start(): number;
  /** True only for the most recently started load. */
  isCurrent(ticket: number): boolean;
}

export function createLoadFence(): LoadFence {
  let latest = 0;
  return {
    start: () => ++latest,
    isCurrent: (ticket) => ticket === latest,
  };
}
