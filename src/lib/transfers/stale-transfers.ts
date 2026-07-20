import { listActiveMasterListPeople } from '@/lib/supabase/global-master-list-db';
import type { DepartmentTransferRequestRow } from '@/lib/supabase/department-transfer-requests';

/**
 * Map of lowercased employee email -> the set of (lowercased) departments that
 * email currently sits in on the ACTIVE Global Master List. A person holding
 * rows in several departments contributes each one; the same human's work and
 * personal emails both point at the same department set.
 *
 * This is the lens used to spot a release request whose employee has already
 * been transferred OUT of the source department by another path — the request
 * shouldn't keep sitting in that source manager's queue.
 */
export type ActiveDeptsByEmail = Map<string, Set<string>>;

/** Build {@link ActiveDeptsByEmail} from the active roster. One roster read. */
export async function loadActiveDeptsByEmail(): Promise<{
  index: ActiveDeptsByEmail;
  error: string | null;
}> {
  const { people, error } = await listActiveMasterListPeople();
  const index: ActiveDeptsByEmail = new Map();
  if (error) return { index, error };
  for (const p of people) {
    const dept = (p.department ?? '').trim().toLowerCase();
    if (!dept) continue;
    for (const email of [p.work_email, p.personal_email]) {
      const key = email?.trim().toLowerCase();
      if (!key) continue;
      const set = index.get(key) ?? new Set<string>();
      set.add(dept);
      index.set(key, set);
    }
  }
  return { index, error: null };
}

/** The employee emails a transfer row can be matched on (lowercased, deduped). */
function transferEmails(row: DepartmentTransferRequestRow): string[] {
  const out = new Set<string>();
  for (const e of [row.employee_email, row.employee_work_email, row.employee_personal_email]) {
    const k = e?.trim().toLowerCase();
    if (k) out.add(k);
  }
  return [...out];
}

/**
 * A pending release request is STALE when the employee has already left its
 * `from_department` — i.e. we can positively locate them on the active roster
 * but none of their current departments is the one the request wants to release
 * them from. Releasing such a request is a no-op (the master-list apply finds no
 * matching source-department row), so it should not sit in the source manager's
 * queue.
 *
 * Conservative on purpose: if the employee can't be located on the active roster
 * at all (email mismatch, off-boarded, roster gap) we DON'T treat it as stale —
 * a genuinely-pending request is never hidden on ambiguous data. Only a
 * confirmed move-out drops it.
 */
export function isStaleTransfer(
  row: DepartmentTransferRequestRow,
  index: ActiveDeptsByEmail,
): boolean {
  const from = row.from_department.trim().toLowerCase();
  if (!from) return false;
  const current = new Set<string>();
  for (const email of transferEmails(row)) {
    for (const d of index.get(email) ?? []) current.add(d);
  }
  if (current.size === 0) return false; // not found -> ambiguous -> keep
  return !current.has(from); // found, but no longer in from_department -> moved on
}

/**
 * Split pending rows into the ones still on their source team (`live`) vs. the
 * ones whose employee has already been transferred out (`stale`).
 */
export function partitionStaleTransfers(
  rows: DepartmentTransferRequestRow[],
  index: ActiveDeptsByEmail,
): { live: DepartmentTransferRequestRow[]; stale: DepartmentTransferRequestRow[] } {
  const live: DepartmentTransferRequestRow[] = [];
  const stale: DepartmentTransferRequestRow[] = [];
  for (const r of rows) (isStaleTransfer(r, index) ? stale : live).push(r);
  return { live, stale };
}
