/**
 * What changed between two OMS pulls of the same week. Pure.
 *
 * Keyed by normalized email — the Orphanage column holds one value per person, so a
 * person is the unit of change. Hours compare as numbers to 4dp so "12.5" and 12.50
 * are the same row, not a change.
 *
 * Doc: docs/features/orphanage-oms-pull.md § Detecting changes
 */

import { normEmail } from '@/lib/email/norm-email';
import type { OrphanageHourRow } from '@/lib/payroll/orphanage-rows';

export interface OmsRowChange {
  email: string;
  kind: 'added' | 'removed' | 'changed';
  /** Hours before (removed/changed) and after (added/changed). */
  before: number | null;
  after: number | null;
}

export interface OmsPullDiff {
  added: OmsRowChange[];
  removed: OmsRowChange[];
  changed: OmsRowChange[];
  /** Total rows touched. 0 = the two pulls agree person for person. */
  total: number;
}

function hoursOf(r: OrphanageHourRow): number | null {
  const n = typeof r.hours === 'number' ? r.hours : Number(String(r.hours).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : null;
}

/** Last row wins for a repeated email — the resolver refuses the duplicate anyway. */
function index(rows: readonly OrphanageHourRow[]): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const r of rows) {
    const k = normEmail(r.email);
    if (k) m.set(k, hoursOf(r));
  }
  return m;
}

export function diffOmsPulls(previous: readonly OrphanageHourRow[], next: readonly OrphanageHourRow[]): OmsPullDiff {
  const a = index(previous);
  const b = index(next);
  const added: OmsRowChange[] = [];
  const removed: OmsRowChange[] = [];
  const changed: OmsRowChange[] = [];
  for (const [email, after] of b) {
    if (!a.has(email)) added.push({ email, kind: 'added', before: null, after });
    else {
      const before = a.get(email) ?? null;
      if (before !== after) changed.push({ email, kind: 'changed', before, after });
    }
  }
  for (const [email, before] of a) {
    if (!b.has(email)) removed.push({ email, kind: 'removed', before, after: null });
  }
  const byEmail = (x: OmsRowChange, y: OmsRowChange) => x.email.localeCompare(y.email);
  added.sort(byEmail);
  removed.sort(byEmail);
  changed.sort(byEmail);
  return { added, removed, changed, total: added.length + removed.length + changed.length };
}

/**
 * Has OMS moved since a pull, judged from the cheap status call alone: a different
 * approved-row count, or a newer "latest updated" stamp. Either is enough to say
 * "load again"; neither says WHAT changed — that is `diffOmsPulls` after the re-load.
 */
export function omsChangedSincePull(
  pull: { approvedCount: number; latestUpdatedAt: string | null },
  status: { approvedCount: number; latestUpdatedAt: string | null },
): { countDelta: number; stampMoved: boolean } | null {
  const countDelta = status.approvedCount - pull.approvedCount;
  const stampMoved =
    status.latestUpdatedAt !== null && pull.latestUpdatedAt !== null
      ? status.latestUpdatedAt > pull.latestUpdatedAt
      : status.latestUpdatedAt !== pull.latestUpdatedAt;
  if (countDelta === 0 && !stampMoved) return null;
  return { countDelta, stampMoved };
}
