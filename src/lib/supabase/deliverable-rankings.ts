/**
 * The reads behind Manager → My Team → PM Team → Rankings. Fetch only — every rule
 * lives in the pure `src/lib/manager/deliverable-rankings.ts` (counts, client-safe)
 * and `src/lib/manager/deliverable-money-order.ts` (pesos → positions, server-only).
 * Doc: `docs/features/manager-pm-rankings.md`.
 *
 * ## This read selects `amount`, and nothing it returns carries it
 *
 * Kane, 2026-09-26: the ranking is *"based on their Bonus … without displaying it"*.
 * So unlike every other My Team read, the projection includes `amount` — and the
 * response is built ONLY by `toClientPayload` (counts + positions). Managers never see
 * pay on My Team (`manager-my-team.md:13-17`), which here means the pesos never leave
 * this process: `deliverable-money-order.test.ts` serializes the payload from sentinel
 * amounts and fails on any of them, and `deliverable-rankings.test.ts` pins this
 * projection string so it can only be widened on purpose.
 *
 * ## Two reads, cheapest first
 *
 * The Rankings pill fetches this for every department a manager opens. A one-row probe
 * (`vars->>X` not null for a PM KPI variable) answers "does this department have the
 * view" before paging anything: 0 rows for Lead Gen's 6,387 and AI/API's 188, measured
 * 2026-09-26. Only then is the department read in full — ALL of its rows, not only the
 * PM variables, because a bonus added tomorrow must be ranked without a code change.
 */
import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { manilaTodayIso, sundayOf } from '@/lib/payroll/manila-week';
import { readWeekBadgeInputs } from '@/lib/supabase/appointment-rankings';
import { getDepartmentDaysWorked } from '@/lib/supabase/appointment-days';
import { getEmployeesForAuthorizedServerRoute, type EmployeeRow } from '@/lib/supabase/employees';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import {
  PM_KPI_VARS,
  type DeliverableDailyPayload,
  type DeliverableRankingsPayload,
} from '@/lib/manager/deliverable-rankings';
import {
  buildKpiData,
  buildMoneyOrder,
  toClientPayload,
  type AppliedMoneyRow,
  type KpiData,
} from '@/lib/manager/deliverable-money-order';

/** The applied-row projection. Pinned by a test. `amount` is read HERE and never returned. */
export const DELIVERABLE_APPLIED_SELECT = 'period_start, period_end, employee_email, bonus_name, vars, amount';

/** PostgREST `or` filter: the row's `vars` names at least one PM KPI variable. */
export const PM_KPI_VARS_FILTER = PM_KPI_VARS.map((v) => `vars->>${v}.not.is.null`).join(',');

type Loaded =
  | { kind: 'error'; error: string }
  | { kind: 'unavailable' }
  | { kind: 'ok'; data: KpiData; members: EmployeeRow[] };

/** Probe → full department read → badge inputs → the department's roster. */
async function loadKpiData(deptKey: string, deptLabel: string, currentWeekStart: string): Promise<Loaded> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { kind: 'error', error: 'Supabase client unavailable' };
  const key = deptKey.trim();
  if (!key) return { kind: 'unavailable' };

  const probe = await supabase
    .from('bonus_catalog_applied')
    .select('period_start')
    .eq('department', key)
    .or(PM_KPI_VARS_FILTER)
    .limit(1);
  if (probe.error) return { kind: 'error', error: probe.error.message };
  if ((probe.data ?? []).length === 0) return { kind: 'unavailable' };

  // PM Team alone is 7,121 rows — past the 1,000-row cap, so page.
  const { rows: applied, error: appliedErr } = await selectAllPaged<AppliedMoneyRow>((from, to) =>
    supabase
      .from('bonus_catalog_applied')
      .select(DELIVERABLE_APPLIED_SELECT)
      .eq('department', key)
      .order('period_start', { ascending: false })
      .order('employee_email', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  // The applied read is the ranking itself: without it there is nothing honest to show.
  if (appliedErr) return { kind: 'error', error: appliedErr };

  const { statuses, locks } = await readWeekBadgeInputs(supabase, key);
  const data = buildKpiData({ applied, statuses, locks, currentWeekStart });
  if (!data.available) return { kind: 'unavailable' };

  // The same roster My Team shows for this department: `/api/manager/department-members`
  // reads the same source through the same matcher.
  const { employees, error: rosterErr } = await getEmployeesForAuthorizedServerRoute();
  if (rosterErr) return { kind: 'error', error: rosterErr };
  const members = employees.filter((e) => departmentMatchesManagedAssignments(e.department, [deptLabel]));
  return { kind: 'ok', data, members };
}

/** Every week of the department's KPI counts, badged, plus the weekly/monthly bonus order. */
export async function getDeliverableRankings(
  deptKey: string,
  deptLabel: string,
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

  const loaded = await loadKpiData(deptKey, deptLabel, currentWeekStart);
  if (loaded.kind === 'error') return empty(loaded.error);
  if (loaded.kind === 'unavailable') return empty(null);

  const order = buildMoneyOrder({
    moneyWeeks: loaded.data.moneyWeeks,
    metrics: loaded.data.metrics,
    members: loaded.members,
    days: null,
    basis: 'weekly',
    todayIso: manilaTodayIso(now),
  });
  return toClientPayload(loaded.data, order, currentWeekStart);
}

/**
 * `?basis=daily`: Hubstaff days worked (the shown per-day averages) and the per-day
 * bonus order, in one call — both need the slow days read (~6s cold), so it runs once.
 * A failed days read fails the whole payload: a partial read would under-count days
 * and inflate every per-day figure.
 */
export async function getDeliverableDailyRankings(
  deptKey: string,
  deptLabel: string,
  now: Date = new Date(),
): Promise<DeliverableDailyPayload> {
  const currentWeekStart = sundayOf(manilaTodayIso(now));
  const [loaded, daysRes] = await Promise.all([
    loadKpiData(deptKey, deptLabel, currentWeekStart),
    getDepartmentDaysWorked(deptLabel),
  ]);
  if (loaded.kind === 'error') return { days: [], order: null, error: loaded.error };
  if (loaded.kind === 'unavailable') return { days: [], order: null, error: null };
  if (daysRes.error) return { days: [], order: null, error: daysRes.error };

  const order = buildMoneyOrder({
    moneyWeeks: loaded.data.moneyWeeks,
    metrics: loaded.data.metrics,
    members: loaded.members,
    days: daysRes.days,
    basis: 'daily',
    todayIso: manilaTodayIso(now),
  });
  return {
    days: daysRes.days.map((d) => ({ email: d.email, weekStart: d.weekStart, days: d.days })),
    order,
    error: null,
  };
}
