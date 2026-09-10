/**
 * The "Need a time adjustment?" nudge on the employee Time Adjustments calendar.
 *
 * Pure and side-effect-free so both halves of the feature read ONE definition: the
 * memo that builds the cycle list and the tile that renders the bubble.
 *
 * WHY A RED-ONLY TRIGGER, and what it deliberately misses
 * -------------------------------------------------------
 * Kane's spec (2026-09-10) is "any day that they missed the pay that disqualifies
 * them — any red". Red on this calendar means the day HAS tracked hours and they
 * fall short, which is narrower than the feature itself: per
 * `docs/features/time-adjustment-requests.md`, a request is "requestable before
 * Hubstaff upload" and works on "days with zero or missing Hubstaff data" — the
 * forgot-the-tracker case. Those days render sky "Processing" or orange "Pending",
 * never red, so the nudge will not appear on them.
 *
 * That is the accepted trade, and it buys something real: a day with no data is
 * frequently a day the SYSTEM has not read, not a day the employee missed. The
 * leading Sunday of every 8-day Sun→Sun Hubstaff export is still dropped outright
 * (`docs/notes/hubstaff-sunday-overlap.md`, root cause OPEN), and
 * `docs/features/employee-my-hours-calendar.md` is explicit that "orange would tell
 * an employee they missed a day the system simply has not read". Requiring real
 * hours closes that whole class by construction rather than by another check.
 *
 * Widening the trigger is therefore a ONE-LINE change here, on purpose.
 */

/** The per-day facts the predicate needs. All derivable in a memo or in render. */
export interface MissedDayCell {
  /** The cell falls inside the month being viewed (not a leading/trailing filler day). */
  inMonth: boolean;
  /** Saturday or Sunday. Non-HSL weekends are display-only and never scoring. */
  weekend: boolean;
  /** A US holiday, which renders blue and is never a miss. */
  isHoliday: boolean;
  /** Hubstaff actually reported this day. FALSE covers both "not uploaded yet" and
   *  "dropped by the Sun→Sun overlap bug". */
  hasData: boolean;
  /** Passing on its own hours OR forgiven — approved dispute, orphanage coverage, or
   *  an HSL overnight pair. Mirrors the tile's `effectivelyPasses`. */
  effectivelyPasses: boolean;
  /** Today, or later. Today is still in progress and renders orange, never red. */
  isFutureOrToday: boolean;
  /** The tile's own filing predicate (`canRequestAdjust`): in-month and not in the
   *  future. Load-bearing — a future day carrying partial data would otherwise fall
   *  through to red, and this is the only term that excludes it. */
  canRequestAdjust: boolean;
  /** A time-adjustment request already exists for this (employee, day) — pending or
   *  decided. Either way there is nothing to nudge: a pending one is filed, and a
   *  decided one is locked (409 on edit). */
  hasRequest: boolean;
}

/**
 * True when the tile renders RED **and** the employee can still act on it.
 *
 * The first six terms mirror the tone chain's final `else` in
 * `EmployeeMyHours.tsx` — red is what is left after holiday, weekend, passing,
 * no-data and today have each been taken. **Change one and you must change the
 * other**; `missed-day-nudge.test.ts` walks the branches as the tripwire.
 */
export function isNudgeableMissedDay(cell: MissedDayCell): boolean {
  if (!cell.inMonth) return false;
  if (cell.isHoliday) return false;
  if (cell.weekend) return false;
  if (cell.effectivelyPasses) return false;
  if (!cell.hasData) return false;
  if (cell.isFutureOrToday) return false;
  // Beyond the tone: only nudge what the employee can actually file.
  if (!cell.canRequestAdjust) return false;
  if (cell.hasRequest) return false;
  return true;
}

/** FNV-1a. Small, dependency-free, and stable across runs — which is the point. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — one seeded 32-bit PRNG, good enough to shuffle a dozen dates. */
function mulberry32(seed: number): () => number {
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
 * Kane asked for random order. This is a **seeded** shuffle, not `Math.random()`,
 * for three reasons:
 *
 *  - `Math.random()` in a render or a memo reshuffles on every recompute, so the
 *    5-second cycle would jump around mid-sequence instead of advancing.
 *  - The same month must deal the same order twice, or paging away and back
 *    restarts the employee somewhere arbitrary.
 *  - A seeded shuffle is testable; an unseeded one is not.
 *
 * The seed is the ISO list itself, so a different month — or the same month after a
 * day is filed or newly falls short — is a genuinely different order.
 *
 * Fisher–Yates. Input is not mutated.
 */
export function orderNudgeDays(isos: readonly string[]): string[] {
  const out = [...isos];
  if (out.length < 2) return out;
  const rand = mulberry32(hashString(out.join('|')));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** How long one bubble stays up before the next takes over. Kane: "like 5 seconds". */
export const NUDGE_INTERVAL_MS = 5000;
