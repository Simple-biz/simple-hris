import { listActiveMasterListPeople } from '@/lib/supabase/global-master-list-db';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import type { DepartmentTransferRequestRow } from '@/lib/supabase/department-transfer-requests';

/**
 * A stable comparison key for a department label. Two labels for the SAME team
 * (e.g. "Callback Team" / "Callbacks" / "callback", or "AI & API Team" / "devs")
 * must compare EQUAL, otherwise a request whose `from_department` is written one
 * way looks like it's for a different team than the roster's label and the
 * staleness check silently keeps a request that's actually resolved.
 *
 * Uses the payroll synonym map ({@link normalizeDeptToKey}) as the primary
 * canonicalizer; falls back to the trimmed-lowercased raw label for departments
 * the map doesn't know (e.g. Payment-Catalog custom departments), so custom
 * teams still compare by their own name rather than all collapsing to one key.
 */
export function deptMatchKey(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  return normalizeDeptToKey(trimmed) ?? trimmed.toLowerCase();
}

/** A person's name, lowercased and whitespace-collapsed, for name-based matching
 *  when an email lookup misses (email drift). Empty string when there's no name. */
export function nameMatchKey(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The active roster indexed two ways so a pending request can be located even
 * when the employee's email on the request has drifted from the roster:
 *   • byEmail — lowercased work/personal email -> set of dept MATCH KEYS the
 *     email currently sits in. The primary, most-reliable lens.
 *   • byName  — {@link nameMatchKey}(name) -> set of dept match keys. The fallback
 *     lens for email drift (recycled work email, corrected personal email).
 *
 * Departments are stored as MATCH KEYS ({@link deptMatchKey}), so a roster label
 * and a request's `from_department` that name the same team compare equal even
 * when spelled differently.
 */
export type ActiveDeptsIndex = {
  byEmail: Map<string, Set<string>>;
  byName: Map<string, Set<string>>;
};

/** Back-compat alias: the pre-name-index shape was just the email map. */
export type ActiveDeptsByEmail = ActiveDeptsIndex;

/** Build {@link ActiveDeptsIndex} from the active roster. One roster read. */
export async function loadActiveDeptsByEmail(): Promise<{
  index: ActiveDeptsIndex;
  error: string | null;
}> {
  const { people, error } = await listActiveMasterListPeople();
  const byEmail = new Map<string, Set<string>>();
  const byName = new Map<string, Set<string>>();
  const index: ActiveDeptsIndex = { byEmail, byName };
  if (error) return { index, error };
  const add = (map: Map<string, Set<string>>, key: string, dept: string) => {
    if (!key) return;
    const set = map.get(key) ?? new Set<string>();
    set.add(dept);
    map.set(key, set);
  };
  for (const p of people) {
    const dept = deptMatchKey(p.department);
    if (!dept) continue;
    for (const email of [p.work_email, p.personal_email]) {
      add(byEmail, email?.trim().toLowerCase() ?? '', dept);
    }
    add(byName, nameMatchKey(p.name), dept);
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
 * The employee is located by email FIRST (the reliable lens); if no email on the
 * request matches any active roster row, we fall back to matching by NAME — this
 * catches the common email-drift case (a recycled/changed work email) where the
 * person is plainly still on the roster under the same name. Departments compare
 * by MATCH KEY ({@link deptMatchKey}) so a request labelled "Callback Team" and a
 * roster row labelled "Callbacks" (same team) don't read as a move-out.
 *
 * Conservative on purpose: if the employee can't be located on the active roster
 * by email OR name (fully off-boarded / genuine identity gap) we DON'T treat it
 * as stale — a genuinely-pending request is never hidden on ambiguous data. Only
 * a confirmed move-out (located, but not in `from_department`) drops it.
 */
export function isStaleTransfer(
  row: DepartmentTransferRequestRow,
  index: ActiveDeptsIndex,
): boolean {
  const from = deptMatchKey(row.from_department);
  if (!from) return false;

  // Primary lens: any email on the request that the roster knows.
  const current = new Set<string>();
  let located = false;
  for (const email of transferEmails(row)) {
    const depts = index.byEmail.get(email);
    if (depts) {
      located = true;
      for (const d of depts) current.add(d);
    }
  }

  // Fallback lens: email drifted, but the same person is on the roster by name.
  if (!located) {
    const depts = index.byName.get(nameMatchKey(row.employee_name));
    if (depts) {
      located = true;
      for (const d of depts) current.add(d);
    }
  }

  if (!located) return false; // not found by email or name -> ambiguous -> keep
  return !current.has(from); // found, but no longer in from_department -> moved on
}

/**
 * Split pending rows into the ones still on their source team (`live`) vs. the
 * ones whose employee has already been transferred out (`stale`).
 */
export function partitionStaleTransfers(
  rows: DepartmentTransferRequestRow[],
  index: ActiveDeptsIndex,
): { live: DepartmentTransferRequestRow[]; stale: DepartmentTransferRequestRow[] } {
  const live: DepartmentTransferRequestRow[] = [];
  const stale: DepartmentTransferRequestRow[] = [];
  for (const r of rows) (isStaleTransfer(r, index) ? stale : live).push(r);
  return { live, stale };
}
