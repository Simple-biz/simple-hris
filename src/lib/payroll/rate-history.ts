import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";

// The pure resolution helpers + types now live in a client-safe module so the
// Payroll Wizard (a client component) can prorate mid-week rate changes exactly
// as this server compute does. Re-exported here so existing server imports
// (`from '@/lib/payroll/rate-history'`) keep working unchanged.
export {
  resolveRateAsOfDate,
  resolveRateFromMap,
  buildRateHistoryByEmail,
  historyMatchesCatalogAsOf,
  type RateHistoryRow,
  type RateHistoryByEmail,
  type CatalogNativeRate,
} from "./rate-history-resolve";
import { buildRateHistoryByEmail, type RateHistoryByEmail } from "./rate-history-resolve";
import {
  snapEffectiveFromToPayWeekStart,
  toLocalIsoDate,
  type PayWeekModel,
} from "./pay-week-effective-date";

/**
 * Fetch the entire rate-history table once and index it by email. Caller is
 * responsible for caching this between requests if needed — for a single
 * payroll cycle compute, one fetch is fine.
 *
 * MUST paginate: PostgREST caps un-ranged selects at `db.max-rows` (1000) and
 * the table passed 9,000 rows in Jul 2026 — an un-paged read silently returns
 * only the newest 1,000 rows (ordered by effective_from DESC), dropping every
 * old baseline (e.g. the 1970-dated backfills), which makes mid-week proration
 * fall back to the cache rate for pre-change days.
 */
export async function fetchAllRateHistory(): Promise<RateHistoryByEmail> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return new Map();

  const PAGE = 1000;
  const all: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('employee_rate_history')
      .select('employee_email, regular_rate, ot_rate, effective_from')
      .order('effective_from', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error || !data) break;
    all.push(...(data as Array<Record<string, unknown>>));
    if (data.length < PAGE) break;
  }
  if (all.length === 0) return new Map();
  return buildRateHistoryByEmail(all);
}

/**
 * Insert a new history row. Email is lowercased server-side via trigger.
 *
 * `effectiveFrom` is SNAPPED BACK to the start of the pay week that contains it
 * (Sunday, per {@link snapEffectiveFromToPayWeekStart}). Rates are resolved PER DAY by
 * `resolveRateAsOfDate`, so an effective date landing mid-week leaves the earlier days of
 * that same pay week resolving to the OLD rate — a silent partial-week underpayment. The
 * common way in is callers defaulting `effectiveFrom` to "today", which is whatever
 * weekday the raise happened to be entered on.
 *
 * A 2026 sweep found 64 stranded changes worth ₱44,125.52 this way — including a raise
 * entered eff Mon 2026-07-27 that left Sun 2026-07-26 paying the old rate, compounded for
 * HSL because the stranded day was a weekend day carrying the +₱15/h premium on the old
 * base. See scripts/audit-midweek-effective-date-underpay.mts.
 *
 * The Google Sheet Accounting pays from prices the whole week at the new rate, so this
 * snap is also what makes the engine agree with the sheet.
 */
export async function insertRateHistoryRow(args: {
  email: string;
  regularRate: string | number | null;
  otRate: string | number | null;
  effectiveFrom: Date;
  createdBy?: string;
  note?: string;
  /** Pay-week shape. Defaults to Sun→Sat, which is every department post-cutover. */
  weekModel?: PayWeekModel;
}): Promise<{ error: string | null; effectiveFrom: string; snappedFromMidWeek: boolean }> {
  const snap = snapEffectiveFromToPayWeekStart(args.effectiveFrom, args.weekModel ?? 'sun_sat');
  if (snap.moved) {
    console.warn(
      `[rate-history] effective_from snapped to pay-week start for ${args.email}: ` +
        `${toLocalIsoDate(args.effectiveFrom)} -> ${snap.iso} (back ${snap.daysMoved} day(s)); ` +
        'a mid-week effective date would strand the earlier days of that week on the old rate.',
    );
  }

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { error: 'supabase client unavailable', effectiveFrom: snap.iso, snappedFromMidWeek: snap.moved };
  }

  const { error } = await supabase.from('employee_rate_history').insert({
    employee_email: args.email,
    regular_rate: args.regularRate == null ? null : String(args.regularRate),
    ot_rate: args.otRate == null ? null : String(args.otRate),
    effective_from: snap.iso,
    note: args.note ?? null,
    created_by: args.createdBy ?? null,
  });
  return {
    error: error?.message ?? null,
    effectiveFrom: snap.iso,
    snappedFromMidWeek: snap.moved,
  };
}
