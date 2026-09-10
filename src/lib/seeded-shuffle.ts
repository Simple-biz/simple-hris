/**
 * Reproducible shuffling from a string seed.
 *
 * Two surfaces need "random, but the same random twice" and they must not each
 * carry their own copy of a PRNG: the QC officer deal
 * (`src/lib/qc/deal.ts`) and the missed-day nudge rotation
 * (`src/lib/employee/missed-day-nudge.ts`).
 *
 * WHY NOT `Math.random()`
 * ----------------------
 * Both callers re-derive their order inside a memo or on every server read, so an
 * unseeded shuffle would deal a different answer each time:
 *   - the QC deal would hand the same week a different split on every page load,
 *     which makes an officer's slice unreproducible and un-auditable;
 *   - the nudge rotation would jump mid-sequence instead of advancing.
 * An unseeded shuffle also cannot be tested, so neither the even-split guarantee
 * nor the "not alphabetical" guarantee could be pinned.
 */

/** FNV-1a. Small, dependency-free, and stable across processes — which is the point. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — one seeded 32-bit PRNG, ample for ordering a few hundred items. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates over a seeded PRNG. Pure: the input is never mutated.
 *
 * The same `(items, seed)` always yields the same order; a different seed yields
 * an independent one.
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  if (out.length < 2) return out;
  const rand = mulberry32(hashSeed(seed));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
