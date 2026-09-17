/**
 * Dividing an FPU class's enrollees into groups — the pure half, browser-safe.
 *
 * Kane, 2026-09-17: HR types "how many people per group", sees the division, and
 * confirms it. The number is a TARGET, not a cap: 13 people at 4 per group is
 * 4/3/3/3, never 4/4/4/1 — the repo's only existing splitter (`dealDeptSlots`)
 * fixes the bucket count and spreads the remainder by at most one, and its test
 * pins that for deliberately awkward sizes.
 *
 * WHY SEEDED — the same reason `src/lib/seeded-shuffle.ts:9-17` gives. HR sees a
 * preview and then confirms it in a second request. With `Math.random()` those
 * are two different divisions and HR would commit one they never looked at, so
 * the preview carries a seed and the confirm RE-DERIVES from it rather than
 * trusting posted membership.
 */

import { seededShuffle } from '@/lib/seeded-shuffle';

/** One person to place. `enrollmentId` is the identity; the rest is for display. */
export interface FpuGroupCandidate {
  enrollmentId: string;
  email: string;
  name: string;
}

export interface FpuGroupDivision {
  groupNo: number;
  members: FpuGroupCandidate[];
}

/** Bounds that keep a typo out of the database (and match the DDL's CHECKs). */
export const FPU_MIN_PER_GROUP = 2;
export const FPU_MAX_PER_GROUP = 50;
export const FPU_MAX_GROUPS = 200;

/**
 * The seed a division is reproducible from.
 *
 * `perGroup` is IN the seed on purpose: changing 4 to 5 should produce a
 * genuinely different permutation, not the same running order re-cut — HR can
 * see that neighbours changed, which is the visible proof that the number did
 * something. `roll` increments when HR asks for another shuffle at the same size.
 */
export function fpuGroupSeed(classId: string, perGroup: number, roll: number): string {
  return `${classId}|${perGroup}|${roll}`;
}

/**
 * How many groups a population of `n` makes at `perGroup` each.
 *
 * Ceiling first, so the requested size is an upper target the groups sit at or
 * just under — 13 at 4 is four groups, not three.
 *
 * Then a floor that matters more than the target: NOBODY IS GROUPED ALONE. Five
 * people at two-per-group ceilings to three groups, which deals 2/2/1 and leaves
 * someone with no groupmates to attend with and no leader but themselves. Since
 * sizes differ by at most one, that happens exactly when the count exceeds n/2,
 * so the count is capped there and the last group runs one over target instead
 * (3/2). A group of one is only possible when the whole class is one person.
 */
export function fpuGroupCount(n: number, perGroup: number): number {
  if (n <= 0) return 0;
  const size = Math.max(1, Math.floor(perGroup));
  const target = Math.max(1, Math.ceil(n / size));
  if (n < 2) return 1;
  return Math.max(1, Math.min(target, Math.floor(n / 2)));
}

/**
 * Deal the class into groups: seeded shuffle, then round-robin.
 *
 * The population is sorted by `enrollmentId` FIRST. `seededShuffle` is
 * deterministic in `(items, seed)` — including the order it was handed — so a
 * caller passing rows in Postgres' natural order would get a different division
 * on the next read from the same seed. Sorting here means callers cannot get
 * that wrong.
 */
export function divideIntoGroups(
  candidates: readonly FpuGroupCandidate[],
  perGroup: number,
  seed: string,
): FpuGroupDivision[] {
  if (candidates.length === 0) return [];
  const stable = [...candidates].sort((a, b) => a.enrollmentId.localeCompare(b.enrollmentId));
  const count = fpuGroupCount(stable.length, perGroup);
  const shuffled = seededShuffle(stable, seed);
  const groups: FpuGroupDivision[] = Array.from({ length: count }, (_, i) => ({ groupNo: i + 1, members: [] }));
  shuffled.forEach((c, i) => {
    groups[i % count]!.members.push(c);
  });
  return groups;
}

/**
 * The group a late arrival joins — the least loaded, ties to the lowest number.
 *
 * A person approved after the division exists is BALANCE-FILLED, never dealt by
 * re-shuffling: the groups are already on screen, attendance may already hang
 * off them, and a re-deal would move people who have marks against them. Same
 * rule as `leastLoadedOfficer` in the QC deal.
 */
export function leastLoadedGroupNo(sizeByGroupNo: ReadonlyMap<number, number>): number | null {
  let best: number | null = null;
  let bestSize = Infinity;
  for (const [groupNo, size] of [...sizeByGroupNo.entries()].sort((a, b) => a[0] - b[0])) {
    if (size < bestSize) {
      best = groupNo;
      bestSize = size;
    }
  }
  return best;
}

export type PerGroupCheck = { ok: true; perGroup: number } | { ok: false; error: string };

/** Validate HR's number at the route boundary, in a sentence rather than a constraint name. */
export function validatePerGroup(raw: unknown, population: number): PerGroupCheck {
  const n = Number(raw);
  if (!Number.isInteger(n)) return { ok: false, error: 'Enter a whole number of people per group.' };
  if (n < FPU_MIN_PER_GROUP) return { ok: false, error: `Groups need at least ${FPU_MIN_PER_GROUP} people.` };
  if (n > FPU_MAX_PER_GROUP) return { ok: false, error: `That is more than ${FPU_MAX_PER_GROUP} people per group.` };
  if (population <= 0) return { ok: false, error: 'Nobody has an approved seat in this class yet.' };
  if (fpuGroupCount(population, n) > FPU_MAX_GROUPS) return { ok: false, error: `That makes more than ${FPU_MAX_GROUPS} groups.` };
  return { ok: true, perGroup: n };
}
