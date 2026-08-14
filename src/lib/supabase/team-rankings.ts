/**
 * Weekly SP rankings for a department — the data behind the employee
 * "My Team → Rankings" tab.
 *
 * ## Where the numbers come from
 *
 * A manager scores the week in the KPI Calculator, which writes one
 * `bonus_catalog_applied` row per member carrying the raw inputs in `vars`.
 * For the AI/API Team (`devs`) the assigned bonus is the Payment Catalog's
 * **"AI Team Bonus"** (`bonus_msnh45vwee38zn33`, department-scoped, weekly):
 *
 *     =SP*15 + Project_SP*80
 *       + IF(Ranking=25, 1325, IF(Ranking=50, 530, IF(Ranking=1, 2650, 0)))
 *
 * so `vars` is `{ SP, Ranking, Project_SP }` and `Ranking` is a **tier flag**,
 * not a position: `1` = rank one, `25` = top 25%, `50` = top 50%, `0` = unranked.
 * The displayed position (#1, #2, …) is derived here by sorting on SP — it is
 * NOT stored, and the tier is what the money actually keys on.
 *
 * ## What this module deliberately does NOT return
 *
 * **No peso amounts.** `manager-my-team.md:13-17` strips pay from every My Team
 * surface, and this is the first roster surface where one teammate can see
 * another's KPI row. Kane confirmed 2026-08-14: SP + tier only. The employee's
 * own ₱ stays on the KPI Results tab, which is self-scoped.
 * `amount` is not selected — not selected-then-dropped — so it cannot leak
 * through a future refactor that widens the returned type.
 *
 * ## Visibility
 *
 * A week appears only once its `hsl_bonus_period_status` row is `ready` or
 * `locked`, mirroring {@link file://./employee-kpi-results.ts} exactly. A `draft`
 * week is a manager mid-scoring and must never be visible to the team.
 */
import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';

const APPLIED = 'bonus_catalog_applied';
const STATUS = 'hsl_bonus_period_status';

/** Ranking tiers as stored in `vars.Ranking`. */
export type RankTier = 1 | 25 | 50 | 0;

export interface TeamRankingRow {
  /** Derived position within the week (1-based), by SP descending. */
  position: number;
  name: string;
  /** Lower-cased; the caller matches this against the viewer to mark "You". */
  email: string;
  sp: number;
  projectSp: number;
  /** 1 = rank one · 25 = top 25% · 50 = top 50% · 0 = unranked. */
  tier: RankTier;
}

export interface TeamRankingWeek {
  /** YYYY-MM-DD (Sunday start, matching the Hubstaff upload week). */
  periodStart: string;
  periodEnd: string;
  status: 'ready' | 'locked';
  /** The catalog bonus the scores came from, e.g. "AI Team Bonus". */
  bonusName: string;
  rows: TeamRankingRow[];
}

export type AppliedRow = {
  period_start: string;
  period_end: string;
  department: string;
  employee_email: string | null;
  employee_name: string | null;
  bonus_name: string | null;
  vars: Record<string, unknown> | null;
};

export type StatusRow = {
  department: string;
  period_start: string;
  period_end: string | null;
  status: string;
};

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function toTier(v: unknown): RankTier {
  const n = num(v);
  return n === 1 || n === 25 || n === 50 ? n : 0;
}

/**
 * True when a department's KPI rows carry SP-style rankings. Driven by the data
 * itself (a `vars.SP` key), not a hardcoded department list, so a second team
 * adopting the same bonus shape lights up without a code change. The route still
 * scopes WHO may read it.
 */
export function hasSpRankings(rows: { vars: Record<string, unknown> | null }[]): boolean {
  return rows.some((r) => r.vars != null && 'SP' in r.vars);
}

/**
 * Assemble visible ranked weeks from raw rows. PURE — the DB call below is a
 * thin fetch around this, so every visibility and ordering rule is unit-testable
 * without a database (`team-rankings.test.ts`).
 *
 * Drops: rows whose week is missing a status row or is still `draft`, and rows
 * with no employee email. Sorts weeks newest-first and rows by SP descending.
 */
export function buildRankingWeeks(
  applied: AppliedRow[],
  statuses: StatusRow[],
): TeamRankingWeek[] {
  const statusByStart = new Map<string, StatusRow>();
  for (const s of statuses) {
    if (s.status === 'ready' || s.status === 'locked') statusByStart.set(s.period_start, s);
  }

  const byWeek = new Map<string, TeamRankingWeek>();
  for (const r of applied) {
    const status = statusByStart.get(r.period_start);
    if (!status) continue; // draft or missing — a week mid-scoring stays private
    const email = (r.employee_email ?? '').trim().toLowerCase();
    if (!email) continue;

    let week = byWeek.get(r.period_start);
    if (!week) {
      week = {
        periodStart: r.period_start,
        periodEnd: status.period_end ?? r.period_end,
        status: status.status === 'locked' ? 'locked' : 'ready',
        bonusName: r.bonus_name?.trim() || 'KPI',
        rows: [],
      };
      byWeek.set(r.period_start, week);
    }
    week.rows.push({
      position: 0, // assigned below, once the week is complete
      name: r.employee_name?.trim() || email,
      email,
      sp: num(r.vars?.SP),
      projectSp: num(r.vars?.Project_SP),
      tier: toTier(r.vars?.Ranking),
    });
  }

  const weeks = Array.from(byWeek.values()).sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
  for (const week of weeks) {
    // Rank by SP, then Project SP, then name — a stable order so two people on
    // the same SP don't swap places between renders.
    week.rows.sort(
      (a, b) =>
        b.sp - a.sp ||
        b.projectSp - a.projectSp ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    week.rows.forEach((row, i) => {
      row.position = i + 1;
    });
  }
  return weeks;
}

/**
 * Every visible ranked week for `deptKey`, newest first.
 *
 * Returns an empty list (not an error) for a department that has never been
 * scored on an SP bonus — the caller hides the tab rather than showing an
 * empty state that implies the team should have scores.
 */
export async function getTeamRankings(
  deptKey: string,
): Promise<{ weeks: TeamRankingWeek[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { weeks: [], error: 'Supabase client unavailable' };

  const key = deptKey.trim();
  if (!key) return { weeks: [], error: null };

  // NB: `amount` is intentionally absent from this projection — see the module
  // header. Adding it here is what would leak pay onto the roster.
  const { rows: applied, error: appliedErr } = await selectAllPaged<AppliedRow>((from, to) =>
    supabase
      .from(APPLIED)
      .select('period_start, period_end, department, employee_email, employee_name, bonus_name, vars')
      .eq('department', key)
      .order('period_start', { ascending: false })
      .order('employee_email', { ascending: true })
      .range(from, to),
  );
  if (appliedErr) return { weeks: [], error: appliedErr };
  if (applied.length === 0 || !hasSpRankings(applied)) return { weeks: [], error: null };

  const starts = Array.from(new Set(applied.map((r) => r.period_start)));
  const { rows: statuses, error: statusErr } = await selectAllPaged<StatusRow>((from, to) =>
    supabase
      .from(STATUS)
      .select('department, period_start, period_end, status')
      .eq('department', key)
      .in('period_start', starts)
      .order('period_start', { ascending: false })
      .range(from, to),
  );
  if (statusErr) return { weeks: [], error: statusErr };

  return { weeks: buildRankingWeeks(applied, statuses), error: null };
}
