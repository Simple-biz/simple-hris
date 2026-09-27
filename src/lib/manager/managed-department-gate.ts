import 'server-only';

import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';

/**
 * My Team's department scope, as ONE function, for every appointment read on
 * Manager → My Team (the Appointments view and the Rankings leaderboard).
 *
 * Kane, 2026-09-26: *"The my team tab lets you only see what Departments were
 * assigned to you."* So this mirrors `/api/manager/department-members` — the
 * roster those views sit on — exactly:
 *
 * - manager / admin / elevated roles only;
 * - a caller WITH `department_managers` rows is scoped to them, even when they
 *   also hold an elevated role;
 * - only an elevated caller with NO assignments may read any department.
 *
 * It deliberately does not consult `canViewTeamRankings` / `managerMayReadRankings`:
 * those govern the SP Rankings read, a different surface with its own rulings.
 * Never "harmonize" the two. `appointment-rankings-route.test.ts` pins the shape.
 */
export type ManagedDepartmentGate =
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'error'; error: string }
  | { kind: 'out_of_scope' }
  | { kind: 'allowed'; sessionEmail: string };

export async function authorizeManagedDepartment(department: string): Promise<ManagedDepartmentGate> {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const sessionEmail = (user?.email ?? '').trim().toLowerCase();
  if (!sessionEmail) return { kind: 'unauthenticated' };

  const roles = (user?.roles ?? []) as string[];
  const elevated = hasElevatedRole(roles);
  if (!(roles.includes('manager') || roles.includes('admin') || elevated)) return { kind: 'forbidden' };

  if (!department.trim()) return { kind: 'out_of_scope' };

  const { rows: assigns, error: dmErr } = await listDepartmentsForManager(sessionEmail);
  if (dmErr) return { kind: 'error', error: dmErr };
  const managed = assigns.map((a) => a.department.trim()).filter(Boolean);
  if (managed.length > 0) {
    if (!departmentMatchesManagedAssignments(department, managed)) return { kind: 'out_of_scope' };
  } else if (!elevated) {
    return { kind: 'out_of_scope' };
  }
  return { kind: 'allowed', sessionEmail };
}
