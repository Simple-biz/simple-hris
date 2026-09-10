/**
 * Dealing QC member slots to officers.
 *
 * THE RULE THIS EXISTS TO ENFORCE
 * ------------------------------
 * Carla, 2026-09-09: *"in accounting I would rather have it randomized so that no
 * one has a buddy on a certain team and they're like, oh I'm going to give them 10
 * appointments."* Jackie agreed. Kane answered *"it's randomized already"* — and it
 * was not: `ensureQcAssignmentsForPeriod` sorted each department's slots by email
 * and dealt them `i % officers.length`, so officer #1 held the alphabetically-first
 * slice of Lead Gen every single week, indefinitely. The *even* half of that claim
 * was true; the random half was the whole point of the control.
 *
 * WHY SEEDED, AND WHY ON (period_start, department)
 * -------------------------------------------------
 * `Math.random()` would be worse than the bug it replaces. The deal is recomputed
 * on every read of `/api/qc/assignments`, so an unseeded shuffle would hand the
 * same week a different split each time a dashboard loaded — an officer's slice
 * would be unreproducible, unauditable, and would appear to change under them
 * mid-scoring.
 *
 * Seeding on the week and the department instead gives all three properties the
 * control actually needs:
 *   - **reproducible within a week** — the same week always deals the same way, so
 *     a re-read is a no-op and the diff-only write stays a no-op;
 *   - **independent across weeks** — a new `period_start` is a genuinely different
 *     permutation, which is what "randomized every week" means;
 *   - **testable** — the even split and the not-alphabetical property can both be
 *     pinned, which is how this stays fixed.
 */

import { seededShuffle } from '@/lib/seeded-shuffle';

/** One (member, department) pair. Mirrors `slotKey(email, dept)` in `qc-db.ts`. */
export interface DealSlot {
  email: string;
  dept: string;
}

/**
 * Deal one department's slots across its officers, evenly and unpredictably.
 *
 * Returns `slotIndex -> officer` as a parallel array aligned to the SHUFFLED order,
 * so callers should read the returned pairs rather than re-deriving positions.
 *
 * Evenness is preserved exactly as the round-robin had it: dealing position `i` to
 * `officers[i % officers.length]` over a permutation still differs by at most one
 * per officer. Only the ORDER the positions are handed out in changes.
 */
export function dealDeptSlots(
  slots: readonly DealSlot[],
  officers: readonly string[],
  periodStart: string,
  dept: string,
): Array<{ slot: DealSlot; officer: string }> {
  if (officers.length === 0 || slots.length === 0) return [];
  // Seed on the week AND the department: two departments in one week must not
  // receive correlated deals, or an officer drawing the first slice of one draws
  // the first slice of the other too.
  const ordered = seededShuffle(slots, `${periodStart}|${dept}`);
  return ordered.map((slot, i) => ({ slot, officer: officers[i % officers.length]! }));
}

/**
 * Pick the least-loaded officer, for a slot that appears mid-week.
 *
 * The sticky-snapshot rule keeps prior attributions, so a new slot cannot be dealt
 * by re-shuffling the week — it has to be balance-filled against the load already
 * on the board. Ties break by the officer order given, which is
 * `employee_roles.assigned_at`, so a tie is at least stable rather than arbitrary.
 */
export function leastLoadedOfficer(
  officers: readonly string[],
  load: ReadonlyMap<string, number>,
): string | null {
  if (officers.length === 0) return null;
  let best = officers[0]!;
  for (const o of officers) {
    if ((load.get(o) ?? 0) < (load.get(best) ?? 0)) best = o;
  }
  return best;
}
