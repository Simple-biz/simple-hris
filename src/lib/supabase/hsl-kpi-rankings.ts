/**
 * The reads behind Manager → My Team → HSL — <sub-team> → Rankings. Fetch only — every
 * rule lives in the pure `src/lib/manager/hsl-kpi-money-order.ts` (server-only) and the
 * shared `deliverable-money-order.ts`. Doc: `docs/features/manager-hsl-kpi-rankings.md`.
 *
 * ## This read selects `calculated_bonus`, and nothing it returns carries it
 *
 * `calculated_bonus` is the card's whole stored bonus, what the Payroll Wizard pays
 * (`hsl-kpi-payout.ts`). It decides the order and never leaves this process: the
 * response is built ONLY by `toClientPayload` (counts + positions), and
 * `hsl-kpi-money-order.test.ts` serializes it from sentinel amounts. The projection
 * STRING is pinned by `hsl-kpi-rankings.test.ts` so it only widens on purpose.
 *
 * ## Addressed by the rail key, ranked on the HSL family
 *
 * The caller passes the sub-team's rail key (`hsl:<key>`), never its display label:
 * "HSL — Intake Specialist" normalizes to no department at all. The roster is the whole
 * HSL family (`departmentMatchesManagedAssignments` collapses every `hsl:*`), because a
 * branch's scorers sit on many sub-teams — Medical Records had 47 of its 64 scorers
 * placed in SSD (measured 2026-09-28). That is also exactly the scope the gate checks.
 */
import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { manilaTodayIso, sundayOf } from '@/lib/payroll/manila-week';
import { readWeekBadgeInputs } from '@/lib/supabase/appointment-rankings';
import { getDepartmentDaysWorked } from '@/lib/supabase/appointment-days';
import { getEmployeesForAuthorizedServerRoute, type EmployeeRow } from '@/lib/supabase/employees';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import { normEmail } from '@/lib/email/norm-email';
import { HSL_CATALOG_KPI_PREFIX } from '@/lib/hsl-bonus/catalog-bonus';
import type { DeliverableDailyPayload, DeliverableRankingsPayload } from '@/lib/manager/deliverable-rankings';
import { buildMoneyOrder, toClientPayload, type KpiData } from '@/lib/manager/deliverable-money-order';
import { buildHslKpiData, type HslCatalogDef, type HslEntryMoneyRow } from '@/lib/manager/hsl-kpi-money-order';

/** The entry projection. Pinned by a test. `calculated_bonus` is read HERE and never returned. */
export const HSL_ENTRY_SELECT = 'period_start, period_end, period_type, employee_email, kpi_data, calculated_bonus';

type Loaded =
  | { kind: 'error'; error: string }
  | { kind: 'unavailable' }
  | { kind: 'ok'; data: KpiData; members: EmployeeRow[] };

/** The Library bonus ids a branch's saved rows reference (`catalog:<id>` / `catalog:<id>:<Var>`). */
function catalogIdsIn(entries: readonly HslEntryMoneyRow[]): string[] {
  const ids = new Set<string>();
  for (const r of entries) {
    for (const key of Object.keys(r.kpi_data ?? {})) {
      if (!key.startsWith(HSL_CATALOG_KPI_PREFIX)) continue;
      const id = key.slice(HSL_CATALOG_KPI_PREFIX.length).split(':')[0];
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

/** Probe → the branch's weekly rows → Library defs → badge inputs → the HSL family roster. */
async function loadHslKpiData(railKey: string, branch: string, currentWeekStart: string): Promise<Loaded> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { kind: 'error', error: 'Supabase client unavailable' };

  // One row is enough to know a sub-team with no weekly scores (placement-only, noKpi,
  // monthly) has nothing to rank, before anything is paged.
  const probe = await supabase
    .from('hsl_bonus_entries')
    .select('period_start')
    .eq('department', branch)
    .eq('period_type', 'weekly')
    .limit(1);
  if (probe.error) return { kind: 'error', error: probe.error.message };
  if ((probe.data ?? []).length === 0) return { kind: 'unavailable' };

  // Intake alone is 2,306 rows — past the 1,000-row cap, so page.
  const { rows: entries, error: entriesErr } = await selectAllPaged<HslEntryMoneyRow>((from, to) =>
    supabase
      .from('hsl_bonus_entries')
      .select(HSL_ENTRY_SELECT)
      .eq('department', branch)
      .eq('period_type', 'weekly')
      .order('period_start', { ascending: false })
      .order('employee_email', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  // The rows ARE the ranking: without them there is nothing honest to show.
  if (entriesErr) return { kind: 'error', error: entriesErr };

  const ids = catalogIdsIn(entries);
  const [{ statuses, locks }, defsRes] = await Promise.all([
    readWeekBadgeInputs(supabase, branch),
    ids.length === 0
      ? Promise.resolve({ rows: [] as HslCatalogDef[], error: null })
      : selectAllPaged<HslCatalogDef>((from, to) =>
          supabase.from('bonus_catalog_bonuses').select('id, kind, formula').in('id', ids).order('id').range(from, to),
        ),
  ]);
  // The formulas decide what is SHOWN: without them the honest answer is an error.
  if (defsRes.error) return { kind: 'error', error: defsRes.error };

  const data = buildHslKpiData({ entries, statuses, locks, currentWeekStart, branch, catalog: defsRes.rows });
  if (!data.available) return { kind: 'unavailable' };

  const { employees, error: rosterErr } = await getEmployeesForAuthorizedServerRoute();
  if (rosterErr) return { kind: 'error', error: rosterErr };
  const members = employees.filter((e) => departmentMatchesManagedAssignments(e.department, [railKey]));
  return { kind: 'ok', data, members };
}

/** Every week of the branch's KPI counts, badged, plus the weekly/monthly order on the stored bonus. */
export async function getHslKpiRankings(
  railKey: string,
  branch: string,
  now: Date = new Date(),
): Promise<DeliverableRankingsPayload> {
  const currentWeekStart = sundayOf(manilaTodayIso(now));
  const empty = (error: string | null): DeliverableRankingsPayload => ({
    available: false,
    currentWeekStart,
    weeks: [],
    metrics: [],
    skippedRows: 0,
    order: null,
    error,
  });

  const loaded = await loadHslKpiData(railKey, branch, currentWeekStart);
  if (loaded.kind === 'error') return empty(loaded.error);
  if (loaded.kind === 'unavailable') return empty(null);

  // All bonuses is the only order (`allOnly`): no metric is ranked on its own.
  const order = buildMoneyOrder({
    moneyWeeks: loaded.data.moneyWeeks,
    metrics: [],
    members: loaded.members,
    days: null,
    basis: 'weekly',
    todayIso: manilaTodayIso(now),
  });
  return toClientPayload(loaded.data, order, currentWeekStart);
}

/**
 * `?basis=daily`: Hubstaff days worked and the per-day order on the stored bonus, in one
 * call. The days read covers the whole HSL family, so it is narrowed to the people who
 * scored on this branch — the rest could never be on this board. A failed days read
 * fails the whole payload.
 */
export async function getHslKpiDailyRankings(
  railKey: string,
  branch: string,
  now: Date = new Date(),
): Promise<DeliverableDailyPayload> {
  const currentWeekStart = sundayOf(manilaTodayIso(now));
  const [loaded, daysRes] = await Promise.all([
    loadHslKpiData(railKey, branch, currentWeekStart),
    getDepartmentDaysWorked(railKey),
  ]);
  if (loaded.kind === 'error') return { days: [], order: null, error: loaded.error };
  if (loaded.kind === 'unavailable') return { days: [], order: null, error: null };
  if (daysRes.error) return { days: [], order: null, error: daysRes.error };

  const scored = new Set(loaded.data.moneyWeeks.flatMap((w) => w.rows.map((r) => r.email)));
  const keep = new Set<string>();
  for (const m of loaded.members) {
    const emails = [m.work_email, m.personal_email, m.alternate_work_email, m.alternate_work_email_2]
      .map((raw) => normEmail(raw ?? null))
      .filter((e): e is string => !!e);
    if (emails.some((e) => scored.has(e))) for (const e of emails) keep.add(e);
  }
  const days = daysRes.days.filter((d) => keep.has(normEmail(d.email) ?? ''));

  const order = buildMoneyOrder({
    moneyWeeks: loaded.data.moneyWeeks,
    metrics: [],
    members: loaded.members,
    days,
    basis: 'daily',
    todayIso: manilaTodayIso(now),
  });
  return {
    days: days.map((d) => ({ email: d.email, weekStart: d.weekStart, days: d.days })),
    order,
    error: null,
  };
}
