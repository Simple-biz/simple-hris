import 'server-only';

import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from './select-all-paged';
import type { InsightAppliedRow, InsightStatusRow } from '@/lib/manager/kpi-insights';

// Reads behind the KPI Calculator insight cards (`docs/features/kpi-calculator-insights.md`).
//
// Every read is PAGED. A single week of `bonus_catalog_applied` already crosses
// PostgREST's 1,000-row cap (1,071 rows for 2026-09-20), and the un-paged
// `summarizeApplied` beside this file is capped there today (audit item 244(f)).
// The applied read runs ONE paged query PER WEEK, in parallel: twelve weeks is
// ~11k rows, and draining that as one sequential 12-page scan is what made the
// card slow in the first place. Projections only — one money column per table
// (`bonus_catalog_applied.amount`, `hsl_bonus_entries.calculated_bonus`), each the
// stored PHP the Payroll Wizard pays. The status reads serve both calculators:
// HSL branch-weeks and catalog dept-weeks share `hsl_bonus_period_status`.

const APPLIED = 'bonus_catalog_applied';
const HSL_ENTRIES = 'hsl_bonus_entries';
const STATUS = 'hsl_bonus_period_status';

export async function readInsightStatuses(
  depts: readonly string[],
  weeks: readonly string[],
): Promise<{ rows: InsightStatusRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  if (depts.length === 0 || weeks.length === 0) return { rows: [], error: null };
  return selectAllPaged<InsightStatusRow>((from, to) =>
    supabase
      .from(STATUS)
      .select('department, period_start, status')
      .in('department', [...depts])
      .in('period_start', [...weeks])
      .order('id', { ascending: true })
      .range(from, to),
  );
}

export async function readInsightApplied(
  depts: readonly string[],
  weeks: readonly string[],
): Promise<{ rows: InsightAppliedRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  if (depts.length === 0 || weeks.length === 0) return { rows: [], error: null };
  const results = await Promise.all(
    [...new Set(weeks)].map((week) =>
      selectAllPaged<InsightAppliedRow>((from, to) =>
        supabase
          .from(APPLIED)
          .select('department, period_start, employee_email, employee_name, amount')
          .in('department', [...depts])
          .eq('period_start', week)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ),
  );
  const failed = results.find((r) => r.error);
  // A partial read is not a smaller answer — a week that failed would draw as a
  // dip nobody paid. Refuse the whole thing instead.
  if (failed) return { rows: [], error: failed.error };
  return { rows: results.flatMap((r) => r.rows), error: null };
}

/**
 * The HSL Branches twin of {@link readInsightApplied}: one paged read of
 * `hsl_bonus_entries` per week, in parallel, with the same all-or-nothing rule.
 *
 * `calculated_bonus` is the one money column read. It is what the HSL grid and
 * its Total pill show, and what the Wizard's `hslKpiAmounts` pays for every
 * branch except Managers Weekly, which the Wizard recomputes from `kpi_data`
 * against the spec dated to the week (`hsl-kpi-calculator-2026-07.md` §Specs
 * are DATED). These cards show the stored figure, as the grid does.
 */
export async function readHslInsightEntries(
  branches: readonly string[],
  weeks: readonly string[],
): Promise<{ rows: InsightAppliedRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  if (branches.length === 0 || weeks.length === 0) return { rows: [], error: null };
  type EntryRow = Omit<InsightAppliedRow, 'amount'> & { calculated_bonus: number | string | null };
  const results = await Promise.all(
    [...new Set(weeks)].map((week) =>
      selectAllPaged<EntryRow>((from, to) =>
        supabase
          .from(HSL_ENTRIES)
          .select('department, period_start, employee_email, employee_name, calculated_bonus')
          .in('department', [...branches])
          .eq('period_start', week)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ),
  );
  const failed = results.find((r) => r.error);
  if (failed) return { rows: [], error: failed.error };
  return {
    rows: results.flatMap((r) =>
      r.rows.map(({ calculated_bonus, ...rest }) => ({ ...rest, amount: calculated_bonus })),
    ),
    error: null,
  };
}

/**
 * The newest week on or before `onOrBefore` in which any of these departments
 * SENT (ready/locked) — where the trend window ends.
 *
 * The chart is "sent to Accounting", so its right edge is the last week anything
 * was sent. Ending at the calendar week, or at the newest SAVED week, would put a
 * ₱0 point on the edge every Monday (and on every score-ahead draft) that reads as
 * a collapse; the live week joins the chart the moment its first department is sent.
 */
export async function readLatestSentWeek(
  depts: readonly string[],
  onOrBefore: string,
): Promise<{ week: string | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { week: null, error: 'Supabase not configured' };
  if (depts.length === 0) return { week: null, error: null };
  // `.limit(1)` is the whole answer, so this is the one read here that is not
  // paged: the 1,000-row cap cannot truncate a single row. (`selectAllPaged`
  // with a page size of 1 would walk the entire table one row per request.)
  const { data, error } = await supabase
    .from(STATUS)
    .select('period_start')
    .in('department', [...depts])
    .in('status', ['ready', 'locked'])
    .lte('period_start', onOrBefore)
    .order('period_start', { ascending: false })
    .limit(1);
  if (error) return { week: null, error: error.message };
  return { week: (data?.[0] as { period_start?: string } | undefined)?.period_start ?? null, error: null };
}
