/**
 * The ONE parser for `/api/employee-rate-history` rows.
 *
 * ## Why this is a module and not a local helper
 *
 * The cache stores the RAW api rows and derives the render shape, because
 * `effectiveFrom` is a `Date` and a `Date` does not survive `JSON.stringify` —
 * it returns as a string and the next `.getTime()` throws
 * (`employee-dashboard-cache.md` § Shapes that do not survive JSON.stringify).
 * That only holds if the seeded path and the fetched path derive **identically**,
 * which is why the parser has to be module scope and pure.
 *
 * It was module scope in `EmployeeDashboard.tsx` and separately re-implemented
 * inside `EmployeeMyHours.tsx`'s fetch callback. Two copies of a parser behind
 * one cache key is the shape that produced item 167 (six private copies of
 * `parseHMS`, and the seventh reader reached for `Number()` because there was
 * nothing to import). One exported parser, two importers.
 *
 * `effective_from` is read as a LOCAL calendar date — deliberately NOT
 * `new Date(iso)`, which is parsed as UTC and lands on the previous day in
 * Manila, against the PAB calendar's locally-built cell dates.
 */

/** A rate-history row exactly as the API returns it — plain JSON, cacheable. */
export interface RawRateHistoryRow {
  regular_rate: string | null;
  ot_rate: string | null;
  effective_from: string;
}

/** The parsed form the rate resolvers walk. Holds a `Date`; never cached. */
export interface RateHistoryEntry {
  effectiveFrom: Date;
  regularRate: number | null;
  otRate: number | null;
}

/**
 * `"1,250.50"` → `1250.5`; anything else → `null`, never `NaN` and never a
 * partial read.
 *
 * The WHOLE string must be a number. Both copies this replaces used a bare
 * `parseFloat`, which stops at the first character it cannot use and returns
 * what it got: `parseFloat("8:20:29")` is **8**, and `parseFloat("175abc")` is
 * **175**. That is the item-167 failure class with a worse ending — `Number()`
 * at least produced a visible `NaN`, whereas this hands back a plausible rate
 * and nothing on screen says it was invented.
 *
 * No real rate is rejected by this: the stored values are plain decimal strings,
 * optionally with thousands separators. A value that fails here yields `null`,
 * which the callers already render as "no rate on file".
 */
export function parseRateText(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse raw rows into entries, newest first.
 *
 * A row whose `effective_from` is not a `YYYY-MM-DD` prefix is DROPPED rather
 * than coerced: a rate with an unreadable start date cannot be placed on a
 * timeline, and guessing one would silently re-rate a day.
 *
 * The API already sorts descending; the sort here is defensive, because
 * `resolveRateAsOf` walks the list and takes the FIRST entry at or before the
 * day — out of order, that returns an older rate than the one in force.
 */
export function parseRateHistoryRows(rows: RawRateHistoryRow[]): RateHistoryEntry[] {
  const parsed: RateHistoryEntry[] = [];
  for (const row of rows) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(row.effective_from ?? '');
    if (!m) continue;
    parsed.push({
      effectiveFrom: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
      regularRate: parseRateText(row.regular_rate),
      otRate: parseRateText(row.ot_rate),
    });
  }
  parsed.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  return parsed;
}
