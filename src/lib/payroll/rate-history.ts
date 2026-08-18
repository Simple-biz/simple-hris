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

/** `YYYY-MM-DD` for a local date — never `toISOString()`, which shifts across timezones. */
function toLocalIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
 * `effectiveFrom` is persisted VERBATIM (ruling 2026-08-18 — "doc stands").
 * A mid-week effective date is a real, meaningful event: a department transfer
 * or dated raise landing inside the pay week makes both engines prorate the
 * week per day and the paystub disclose the split (amber "Prorated" chip +
 * per-rate basis line — see prorate-mid-period.ts / paystub-dispatch.md).
 *
 * This function used to SNAP the date back to the pay week's Sunday
 * (pay-week-effective-date.ts, now deleted) on the theory that rate changes
 * are week-grained. That snap silently rewrote the 2026-08-13/14 transfer
 * dates Accounting had typed for 23 Lead Gen → HSL moves to 2026-08-09,
 * flattening every one of those weeks to a single rate and erasing the
 * proration the paystubs were built to explain. A whole-week rate change is
 * still expressible — enter it effective on the pay week's start date.
 */
export async function insertRateHistoryRow(args: {
  email: string;
  regularRate: string | number | null;
  otRate: string | number | null;
  effectiveFrom: Date;
  createdBy?: string;
  note?: string;
}): Promise<{ error: string | null; effectiveFrom: string }> {
  const iso = toLocalIsoDate(args.effectiveFrom);
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) {
    return { error: 'supabase client unavailable', effectiveFrom: iso };
  }

  const { error } = await supabase.from('employee_rate_history').insert({
    employee_email: args.email,
    regular_rate: args.regularRate == null ? null : String(args.regularRate),
    ot_rate: args.otRate == null ? null : String(args.otRate),
    effective_from: iso,
    note: args.note ?? null,
    created_by: args.createdBy ?? null,
  });
  return {
    error: error?.message ?? null,
    effectiveFrom: iso,
  };
}
