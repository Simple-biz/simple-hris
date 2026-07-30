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

/** Insert a new history row. Email is lowercased server-side via trigger. */
export async function insertRateHistoryRow(args: {
  email: string;
  regularRate: string | number | null;
  otRate: string | number | null;
  effectiveFrom: Date;
  createdBy?: string;
  note?: string;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { error: 'supabase client unavailable' };

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const { error } = await supabase.from('employee_rate_history').insert({
    employee_email: args.email,
    regular_rate: args.regularRate == null ? null : String(args.regularRate),
    ot_rate: args.otRate == null ? null : String(args.otRate),
    effective_from: fmt(args.effectiveFrom),
    note: args.note ?? null,
    created_by: args.createdBy ?? null,
  });
  return { error: error?.message ?? null };
}
