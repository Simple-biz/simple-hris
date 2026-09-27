/**
 * The reads behind Manager → My Team → Appointments. Fetch only — every rule
 * (which variable, which badge, which month, who is ranked) lives in the pure
 * `src/lib/manager/appointment-rankings.ts`. Doc:
 * `docs/features/manager-appointment-rankings.md`.
 *
 * **`amount` is not in the projection** — not selected-then-dropped. Managers
 * never see pay on My Team (`manager-my-team.md:13-17`), appointments × ₱250 is
 * the pay, and `appointment-rankings.test.ts` pins this projection string so a
 * widened SELECT fails a test rather than shipping.
 *
 * Unlike `team-rankings.ts` this does NOT hide draft weeks: the readers are the
 * department's own managers, who can already open a draft week in the KPI
 * Calculator, and Kane asked for every week with a badge (Q3, 2026-09-26).
 */
import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { manilaTodayIso, sundayOf } from '@/lib/payroll/manila-week';
import {
  DISPATCH_LOCK_PREFIX,
  buildAppointmentWeeks,
  type AppliedApptRow,
  type AppointmentRankingsPayload,
  type ApptStatusRow,
  type LockSettingRow,
} from '@/lib/manager/appointment-rankings';

/** The applied-row projection. Pinned by a test — never add `amount`. */
export const APPOINTMENT_APPLIED_SELECT = 'period_start, period_end, employee_email, vars';

/** Every week of `deptKey`, badged, newest first. */
export async function getAppointmentRankings(
  deptKey: string,
  now: Date = new Date(),
): Promise<AppointmentRankingsPayload> {
  const currentWeekStart = sundayOf(manilaTodayIso(now));
  const empty = (error: string | null): AppointmentRankingsPayload => ({
    available: false,
    currentWeekStart,
    weeks: [],
    error,
  });

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return empty('Supabase client unavailable');
  const key = deptKey.trim();
  if (!key) return empty(null);

  // Lead Gen alone is 6,387 rows — past the 1,000-row cap, so page.
  const { rows: applied, error: appliedErr } = await selectAllPaged<AppliedApptRow>((from, to) =>
    supabase
      .from('bonus_catalog_applied')
      .select(APPOINTMENT_APPLIED_SELECT)
      .eq('department', key)
      .order('period_start', { ascending: false })
      .order('employee_email', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
  // The applied read is the ranking itself: without it there is nothing honest to show.
  if (appliedErr) return empty(appliedErr);

  // The badge reads fail SOFT — a failed read is `null`, which the pure module
  // turns into "Couldn't check" on every scored week rather than a guess.
  const [statusRes, lockRes] = await Promise.all([
    selectAllPaged<ApptStatusRow>((from, to) =>
      supabase
        .from('hsl_bonus_period_status')
        .select('period_start, status')
        .eq('department', key)
        .order('period_start', { ascending: false })
        .range(from, to),
    ),
    selectAllPaged<LockSettingRow>((from, to) =>
      supabase
        .from('app_settings')
        .select('key, value')
        .like('key', `${DISPATCH_LOCK_PREFIX}%`)
        .order('key', { ascending: true })
        .range(from, to),
    ),
  ]);

  const { available, weeks } = buildAppointmentWeeks({
    applied,
    statuses: statusRes.error ? null : statusRes.rows,
    locks: lockRes.error ? null : lockRes.rows,
    currentWeekStart,
  });
  return { available, currentWeekStart, weeks, error: null };
}
