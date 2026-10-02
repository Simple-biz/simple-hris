/**
 * What the CEO "Payments to send" card may keep in the Accounting tab cache
 * (`TAB_CACHE_KEYS.ceoPaymentsLive`), and how it is read back.
 *
 * The card's live state (`usePaymentsLive`) carries two kinds of data:
 *
 * - **Counters** — the cycle, its label, total / paid / remaining, and the
 *   per-department paid progress. Company aggregates. These are cached so a tab
 *   switch or a reload paints the card at once instead of a skeleton.
 * - **`recent`** — the "being paid now" feed: names, work emails and the USD /
 *   PHP / COP amount each person was paid. A per-person pay figure. It is
 *   **never** cached: the value written here is built field by field from an
 *   allow-list, so a field added to the live state later cannot ride along.
 *
 * The cache only PAINTS. `usePaymentsLive` always refetches on mount, and the
 * seeded state never sets `recentHydrated` (the live modal's "newly paid" diff
 * would otherwise treat a cached copy as a real snapshot). The envelope
 * guarantees identity, version and age but not shape, so every field is
 * re-checked on read and anything malformed reads as "nothing cached".
 *
 * See `docs/features/accounting-dashboard-cache.md` § *CEO Overview*.
 */

export interface CachedDeptProgress {
  key: string;
  name: string;
  total: number;
  paid: number;
}

export interface CachedPaymentsLive {
  sourceFile: string | null;
  label: string;
  total: number;
  paid: number;
  remaining: number;
  departments: CachedDeptProgress[];
}

/** The live fields the cached value is built from. `recent` is deliberately absent. */
export interface PaymentsLiveCounters {
  sourceFile: string | null;
  label: string;
  total: number;
  paid: number;
  remaining: number;
  departments: readonly CachedDeptProgress[];
}

/** Build the cacheable value from the live state, allow-listed field by field. */
export function toCachedPaymentsLive(live: PaymentsLiveCounters): CachedPaymentsLive {
  return {
    sourceFile: live.sourceFile,
    label: live.label,
    total: live.total,
    paid: live.paid,
    remaining: live.remaining,
    departments: live.departments.map((d) => ({
      key: d.key,
      name: d.name,
      total: d.total,
      paid: d.paid,
    })),
  };
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseDept(raw: unknown): CachedDeptProgress | null {
  if (!isRecord(raw)) return null;
  const { key, name, total, paid } = raw;
  if (typeof key !== 'string' || typeof name !== 'string') return null;
  if (!isCount(total) || !isCount(paid)) return null;
  return { key, name, total, paid };
}

/**
 * The cached counters, or `null` when there is nothing trustworthy to paint.
 *
 * Fails closed on the whole entry: one malformed department or a non-integer
 * count rejects everything rather than painting a partial card.
 */
export function parseCachedPaymentsLive(raw: unknown): CachedPaymentsLive | null {
  if (!isRecord(raw)) return null;
  const { sourceFile, label, total, paid, remaining, departments } = raw;
  if (sourceFile !== null && typeof sourceFile !== 'string') return null;
  if (typeof label !== 'string' || label.trim() === '') return null;
  if (!isCount(total) || !isCount(paid) || !isCount(remaining)) return null;
  if (!Array.isArray(departments)) return null;
  const depts: CachedDeptProgress[] = [];
  for (const d of departments) {
    const parsed = parseDept(d);
    if (!parsed) return null;
    depts.push(parsed);
  }
  return { sourceFile, label, total, paid, remaining, departments: depts };
}
