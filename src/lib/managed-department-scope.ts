import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

function normDeptRaw(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Matches a roster/leave-record department string against admin assignments in `department_managers`.
 * Uses case-insensitive raw equality plus {@link normalizeDeptToKey} (e.g. "Accounting" vs "Accounting Team").
 */
export function departmentMatchesManagedAssignments(
  rowDepartment: string | null | undefined,
  managedDepartmentStrings: readonly string[],
): boolean {
  if (managedDepartmentStrings.length === 0) return false;
  const empRaw = normDeptRaw(rowDepartment);
  const empKey = normalizeDeptToKey(rowDepartment);

  for (const m of managedDepartmentStrings) {
    const mRaw = normDeptRaw(m);
    if (empRaw && mRaw && empRaw === mRaw) return true;
    const mKey = normalizeDeptToKey(m);
    if (empKey && mKey && empKey === mKey) return true;
  }
  return false;
}
