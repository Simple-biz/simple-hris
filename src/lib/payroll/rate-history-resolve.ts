import { normEmail } from '@/lib/email/norm-email';

/**
 * Client-safe rate-history resolution — the PURE half of rate-history.ts (no DB,
 * no server-only imports), so client components (the Payroll Wizard) can resolve
 * a rate as-of a date and prorate a mid-week rate change the exact same way the
 * server dispatch compute (current-pay.ts) does. rate-history.ts re-exports these
 * so server callers keep their existing import path.
 */

export interface RateHistoryRow {
  email: string;
  regularRate: number | null;
  otRate: number | null;
  effectiveFrom: Date;
}

/** Map<lowercased-email, sorted-desc-by-effective-from RateHistoryRow[]>. */
export type RateHistoryByEmail = Map<string, RateHistoryRow[]>;

export function parseRateNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM-DD…' → local-midnight Date (same construction as current-pay.ts). */
export function parseEffectiveDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Resolve the rate row in effect on `date`: the newest history row with
 * `effective_from <= date`. `rows` MUST be sorted DESCENDING by effectiveFrom.
 */
export function resolveRateAsOfDate(
  rows: RateHistoryRow[] | undefined,
  date: Date,
): { regularRate: number | null; otRate: number | null } | null {
  if (!rows || rows.length === 0) return null;
  const t = date.getTime();
  for (const r of rows) {
    if (r.effectiveFrom.getTime() <= t) {
      return { regularRate: r.regularRate, otRate: r.otRate };
    }
  }
  return null;
}

export function resolveRateFromMap(
  byEmail: RateHistoryByEmail,
  email: string,
  date: Date,
): { regularRate: number | null; otRate: number | null } | null {
  const em = normEmail(email);
  if (!em) return null;
  return resolveRateAsOfDate(byEmail.get(em), date);
}

/** An employee-scope Payment Catalog rate in its NATIVE currency, for the
 *  consistency check below (never FX-converted — a PHP history row can only
 *  vouch for a PHP structure). */
export interface CatalogNativeRate {
  currency: string;
  regular: number;
  ot: number | null;
}

/** Rates are money; compare to the centavo. */
const CATALOG_RATE_EPSILON = 0.005;

/**
 * Is the dated rate history CATALOG-CONSISTENT as of `asOf` — i.e. does the
 * history row in effect on that date state the same rate the employee's
 * Payment Catalog structure decrees?
 *
 * This is the shared gate that lets BOTH pay engines (the wizard's
 * `proratePayForMidPeriodChange` and Dispatch's `computeProratedRowPay`)
 * prorate a catalog-managed person through their dated history instead of
 * flattening the whole period at the catalog rate. A match proves the history
 * is catalog-authored (the pay-structures route writes a dated row on every
 * save), so resolving per-day from it can only replay the catalog's own
 * timeline. ANY disagreement — a stale structure, a stale history row, a
 * non-PHP structure whose PHP-equivalent floats with FX — fails closed to the
 * flat-at-catalog behavior, so this can never resurrect a superseded rate.
 */
export function historyMatchesCatalogAsOf(
  rows: RateHistoryRow[] | undefined,
  catalog: CatalogNativeRate,
  asOf: Date,
): boolean {
  if (catalog.currency !== 'PHP') return false;
  if (!Number.isFinite(catalog.regular)) return false;
  const r = resolveRateAsOfDate(rows, asOf);
  if (!r || r.regularRate == null) return false;
  if (Math.abs(r.regularRate - catalog.regular) > CATALOG_RATE_EPSILON) return false;
  if (
    r.otRate != null &&
    catalog.ot != null &&
    Math.abs(r.otRate - catalog.ot) > CATALOG_RATE_EPSILON
  ) {
    return false;
  }
  return true;
}

/**
 * Build the per-email, effective-from-DESC index from raw
 * `employee_rate_history` rows (as returned by the API). Client-safe.
 */
export function buildRateHistoryByEmail(
  raw: Array<{ employee_email?: unknown; regular_rate?: unknown; ot_rate?: unknown; effective_from?: unknown }>,
): RateHistoryByEmail {
  const out: RateHistoryByEmail = new Map();
  for (const r of raw) {
    const em = normEmail(String(r.employee_email ?? '')) ?? null;
    const eff = parseEffectiveDate(r.effective_from);
    if (!em || !eff) continue;
    const row: RateHistoryRow = {
      email: em,
      regularRate: parseRateNum(r.regular_rate),
      otRate: parseRateNum(r.ot_rate),
      effectiveFrom: eff,
    };
    const list = out.get(em);
    if (list) list.push(row);
    else out.set(em, [row]);
  }
  // Ensure DESC order so resolveRateAsOfDate returns the newest applicable row.
  for (const list of out.values()) {
    list.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  }
  return out;
}
