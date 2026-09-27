/**
 * Days worked per person-week for one department — the denominator of the
 * Rankings leaderboard's DAILY average (Kane, Q2 → a: appointments ÷ Hubstaff days
 * worked). Fetch only; every rule is in `src/lib/manager/appointment-averages.ts`.
 * Doc: `docs/features/manager-appointment-leaderboard.md`.
 *
 * ## No money
 *
 * `hubstaff_hours` carries pay columns (`Spent total`, `Currency`). The projection
 * below is exactly the email and the seven day columns; `appointment-days.test.ts`
 * pins the string. What leaves the server is an email, a week and a count of
 * days — no hours, no amounts.
 *
 * ## Why per FILE, filtered in memory
 *
 * An exact `.in('Email', …)` would miss the 26 mixed-case rows (`Alyson@`, measured
 * 2026-09-26), so each weekly file is read whole (~1,100 rows) and matched
 * case-insensitively against the department's roster emails, which are resolved
 * HERE from the roster — the client never supplies an email.
 */
import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { listHubstaffUploads } from '@/lib/supabase/hubstaff-hours-db';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import { normEmail } from '@/lib/email/norm-email';
import { buildDaysWorked, weeklyHubstaffWeek, type DaysWorkedRow } from '@/lib/manager/appointment-averages';

/** The Hubstaff projection. Pinned by a test — never add a pay column. */
export const HUBSTAFF_DAYS_SELECT = 'Email, sunday, monday, tuesday, wednesday, thursday, friday, saturday';

/** Files read at once. ~30 weekly files of ~1,100 rows (2 pages each); bounded so a
 *  cold call cannot fan out unboundedly. At 6 the Lead Gen read measured 7.4s. */
const CONCURRENCY = 10;

export interface DepartmentDaysPayload {
  days: DaysWorkedRow[];
  error: string | null;
}

export async function getDepartmentDaysWorked(departmentLabel: string): Promise<DepartmentDaysPayload> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { days: [], error: 'Supabase client unavailable' };

  // The department's roster, as every email it owns.
  const { employees, error: rosterErr } = await getEmployeesForAuthorizedServerRoute();
  if (rosterErr) return { days: [], error: rosterErr };
  const allowed = new Set<string>();
  for (const e of employees) {
    if (!departmentMatchesManagedAssignments(e.department, [departmentLabel])) continue;
    for (const raw of [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]) {
      const n = normEmail(raw ?? null);
      if (n) allowed.add(n);
    }
  }
  if (allowed.size === 0) return { days: [], error: null };

  let files: string[];
  try {
    const uploads = await listHubstaffUploads();
    files = [
      ...new Set(
        uploads
          .map((u) => u.source_file)
          .filter((f): f is string => !!f && weeklyHubstaffWeek(f) !== null),
      ),
    ];
  } catch (e) {
    return { days: [], error: e instanceof Error ? e.message : String(e) };
  }

  const table = process.env.NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE?.trim() || 'hubstaff_hours';
  const read: { sourceFile: string; rows: Record<string, unknown>[] }[] = [];
  let firstError: string | null = null;
  for (let i = 0; i < files.length && !firstError; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((sourceFile) =>
        selectAllPaged<Record<string, unknown>>((from, to) =>
          supabase
            .from(table)
            .select(HUBSTAFF_DAYS_SELECT)
            .eq('source_file', sourceFile)
            .order('id', { ascending: true })
            .range(from, to),
        ).then((r) => ({ sourceFile, ...r })),
      ),
    );
    for (const r of results) {
      if (r.error) firstError = firstError ?? r.error;
      else read.push({ sourceFile: r.sourceFile, rows: r.rows });
    }
  }
  // A partial read would under-count days and INFLATE daily averages, so any
  // failed file fails the whole read — the pane then says daily couldn't be checked.
  if (firstError) return { days: [], error: firstError };

  return { days: buildDaysWorked(read, allowed), error: null };
}
