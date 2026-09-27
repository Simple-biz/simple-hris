/**
 * Accounting → Issues: which rows changed status between two reads, and the colour that
 * change sweeps (`issue-row-flash-*` in `src/index.css`, drawn by
 * `src/components/payroll/issue-row-motion.tsx`).
 *
 * Pure so the one rule that matters is pinned by a test: the table swaps between
 * per-filter slices, so a row missing from the slice being read must KEEP its last known
 * status — otherwise switching Pending → All would flash every row as "changed".
 */

export type IssueFlashTone = 'approved' | 'denied' | 'moved';

/** The outcome a status landed on, or neutral `moved` for a hand-off (e.g. a time
 *  adjustment's second signature arriving at `manager_approved`). */
export function issueFlashTone(status: string): IssueFlashTone {
  if (status === 'approved' || status === 'accounting_approved') return 'approved';
  if (status.endsWith('denied')) return 'denied';
  return 'moved';
}

/**
 * Records every `[key, status]` read into `known` and returns the keys whose status
 * differs from the last one recorded. First sight of a key is silent; `known` only
 * grows, so rows absent from this read keep their previous status.
 */
export function noteIssueStatuses(
  known: Map<string, string>,
  rows: Iterable<readonly [key: string, status: string]>,
): [key: string, tone: IssueFlashTone][] {
  const changed: [string, IssueFlashTone][] = [];
  for (const [key, status] of rows) {
    const was = known.get(key);
    if (was !== undefined && was !== status) changed.push([key, issueFlashTone(status)]);
    known.set(key, status);
  }
  return changed;
}
