import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import {
  toSchedulePeriod,
  toScheduleRow,
  departmentHasScheduling,
  type SchedulePeriodRow,
} from '@/lib/manager/scheduling-rows';
import { findOverlaps } from '@/lib/manager/scheduling';
import type { SchedulePeriod } from '@/lib/manager/scheduling';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLE = 'employee_schedule_periods';

/** PostgREST's code for "relation does not exist". */
const UNDEFINED_TABLE = '42P01';

function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Is this error the table simply not being there yet?
 *
 * The DDL ships as a script with an `--apply` gate that Kane runs, so the code
 * can be deployed before the table exists. That window must read as "not migrated
 * yet", not as a 500 — a surface that errors out looks broken, while one that says
 * schedules cannot be saved yet is telling the truth. Note this is a REAL error
 * check: `head: true` counts are known to hide a missing table entirely
 * (memory/postgrest-head-true-hides-missing-table), so never probe that way.
 */
function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === UNDEFINED_TABLE) return true;
  const m = (err.message ?? '').toLowerCase();
  return m.includes('does not exist') && m.includes(TABLE);
}

/** The departments this session may read/write schedules for. */
async function resolveScope(
  sessionEmail: string,
  roles: string[],
): Promise<{ departments: string[]; elevated: boolean }> {
  const { rows } = await listDepartmentsForManager(sessionEmail);
  const departments = rows.map((r) => r.department.trim()).filter(Boolean);
  return { departments, elevated: hasElevatedRole(roles) };
}

/**
 * GET — every schedule period in the caller's department scope.
 *
 * Scoped exactly like `/api/manager/department-members`: explicit
 * `department_managers` rows win whenever the list is non-empty, and the full set
 * applies only to an elevated session with no assignments. `departmentMatchesManagedAssignments`
 * collapses every `hsl:*` onto one family key, so a manager granted a sub-team sees
 * the whole HSL family — the same behaviour their My Team roster already has, and
 * the rail is what narrows it to one sub-team on screen.
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
    const sessionEmail = normEmail(user?.email ?? null);
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

    const roles = (user?.roles ?? []) as string[];
    if (!roles.includes('manager') && !roles.includes('admin') && !hasElevatedRole(roles)) {
      return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
    }

    const sb = createSupabaseServiceRoleClient();
    if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

    const { departments, elevated } = await resolveScope(sessionEmail, roles);
    if (departments.length === 0 && !elevated) {
      return NextResponse.json({ migrated: true, periods: [], departments: [] });
    }

    // PostgREST truncates at 1000 rows even with an explicit .range()
    // (memory/postgrest-1000-cap-sweep) and 591 HSL people will each accumulate a
    // period per schedule change, so this is paged from the first day.
    const { rows, error } = await selectAllPaged<SchedulePeriodRow>((from, to) =>
      sb.from(TABLE).select('*').order('id', { ascending: true }).range(from, to),
    );

    if (error) {
      if (isMissingTable(error as { code?: string; message?: string })) {
        return NextResponse.json({ migrated: false, periods: [], departments });
      }
      return NextResponse.json({ error: String(error) }, { status: 500 });
    }

    const scoped =
      departments.length > 0
        ? rows.filter((r) => departmentMatchesManagedAssignments(r.department, departments))
        : rows;

    return NextResponse.json({
      migrated: true,
      departments,
      periods: scoped.map(toSchedulePeriod),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * PUT — replace this person's schedule periods.
 *
 * The unit is a PERIOD: changing a schedule closes the current one and opens a
 * new one, and a past period is never edited. The client sends the person's full
 * period list and this writes it, which is what makes "close and open" expressible
 * in one call.
 *
 * **Overlaps are refused, not warned about.** An overlapping date has two answers.
 * The unique index stops an exact duplicate but cannot stop a straddle, so the
 * check lives here too — the same reason `findOverlaps` exists on the client.
 */
export async function PUT(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
    const sessionEmail = normEmail(user?.email ?? null);
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

    const roles = (user?.roles ?? []) as string[];
    if (!roles.includes('manager') && !roles.includes('admin') && !hasElevatedRole(roles)) {
      return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
    }

    const body = (await req.json()) as { workEmail?: string; periods?: SchedulePeriod[] };
    const workEmail = normEmail(body.workEmail);
    const periods = Array.isArray(body.periods) ? body.periods : null;
    if (!workEmail || !periods) {
      return NextResponse.json({ error: 'workEmail and periods are required' }, { status: 400 });
    }

    // Every period must name a department this session manages AND one that
    // actually carries Scheduling. Both halves matter: the first stops a manager
    // writing another team's schedule, the second stops the surface being used for
    // a department it was never turned on for.
    const { departments, elevated } = await resolveScope(sessionEmail, roles);
    for (const p of periods) {
      if (!departmentHasScheduling(p.department)) {
        return NextResponse.json(
          { error: `Scheduling is not enabled for ${p.department}` },
          { status: 400 },
        );
      }
      const allowed =
        departments.length > 0
          ? departmentMatchesManagedAssignments(p.department, departments)
          : elevated;
      if (!allowed) {
        return NextResponse.json({ error: 'Out of your department scope' }, { status: 403 });
      }
      if (normEmail(p.workEmail) !== workEmail) {
        return NextResponse.json(
          { error: 'Every period must belong to the named person' },
          { status: 400 },
        );
      }
    }

    const overlaps = findOverlaps(periods);
    if (overlaps.length > 0) {
      return NextResponse.json(
        { error: 'Overlapping periods — an overlapping date has two answers', overlaps },
        { status: 409 },
      );
    }

    const sb = createSupabaseServiceRoleClient();
    if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

    const del = await sb.from(TABLE).delete().eq('work_email', workEmail);
    if (del.error) {
      if (isMissingTable(del.error)) {
        return NextResponse.json(
          { error: 'Schedules cannot be saved until the migration has run', migrated: false },
          { status: 503 },
        );
      }
      return NextResponse.json({ error: del.error.message }, { status: 500 });
    }

    if (periods.length > 0) {
      const ins = await sb
        .from(TABLE)
        .insert(periods.map((p) => ({ ...toScheduleRow(p), updated_by: sessionEmail })));
      if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });
    }

    return NextResponse.json({ migrated: true, saved: periods.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
