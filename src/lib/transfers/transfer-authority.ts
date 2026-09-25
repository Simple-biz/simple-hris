import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import { deptCellSatisfiesTarget } from '@/lib/departments/hsl-subdept';

/**
 * Who may raise, and who may decide, a department transfer — the pure core of
 * `POST /api/department-transfers`, `PATCH /api/department-transfers/[id]`
 * (release / decline) and the "Request transfer in" picker.
 *
 * Kane, 2026-09-25 (audit item 205, resolution (b)): a manager who ALSO manages
 * the person's current department may raise the request. cjm@ was granted
 * Lead Gen on 2026-09-23 and every one of her 252 requests is FROM Lead Gen, so
 * the old "never from a department you manage" rule silently took her whole job
 * away. The two-person consent that rule protected moves to the decision:
 * a non-admin may never release or decline a request THEY raised, so someone
 * else still has to say yes. See docs/features/department-transfers.md §1.
 */

type Person = { department: string | null };

/**
 * Why a move from `fromDept` to `toDept` is a NO-OP (400), or null when it is a
 * real move. Every role. The same predicate the dialog gates Submit on, so a
 * dialog-legal move is never refused here. It closes what dropping the source
 * check opened: `Client VA` → `Client - VA` differs as a raw string but is one
 * department (the same family key), and it used to be refused only because
 * cjm@ manages both spellings. A namespaced target (`hsl:x`, `lead_gen:y`) still
 * demands the exact cell, so Lead Gen → `hsl:intake_specialist` is a real move.
 */
export function transferNoOpDenial(fromDept: string, toDept: string): string | null {
  if (fromDept.trim().toLowerCase() === toDept.trim().toLowerCase()) {
    return 'Target department must differ from the current one';
  }
  if (deptCellSatisfiesTarget(fromDept, toDept)) {
    return 'They are already in that department — pick a different target.';
  }
  return null;
}

/**
 * Why a caller may NOT raise a transfer into `toDept`, or null when they may.
 * A non-admin with explicit assignments must manage the TARGET. The source is
 * deliberately not checked (2026-09-25) — see the module comment.
 */
export function initiateTransferDenial(args: {
  isAdmin: boolean;
  managedDepts: readonly string[];
  toDept: string;
}): string | null {
  if (args.isAdmin || args.managedDepts.length === 0) return null;
  if (!departmentMatchesManagedAssignments(args.toDept, args.managedDepts)) {
    return 'You can only transfer people into a department you manage.';
  }
  return null;
}

/**
 * Why a caller may NOT release/decline this request, or null when they may.
 * Non-admin: must manage the SOURCE department, and must not be the requester.
 * Admins are unrestricted, exactly as they are for raising one.
 */
export function transferDecisionDenial(args: {
  isAdmin: boolean;
  sessionEmail: string;
  requestedBy: string | null | undefined;
  fromDept: string;
  managedDepts: readonly string[];
}): string | null {
  if (args.isAdmin) return null;
  if (!departmentMatchesManagedAssignments(args.fromDept, args.managedDepts)) {
    return 'Only a manager of the current department can decide this transfer';
  }
  const me = args.sessionEmail.trim().toLowerCase();
  if (me && (args.requestedBy ?? '').trim().toLowerCase() === me) {
    return 'You raised this request — another manager of the current department must release or decline it. Use Withdraw to cancel it.';
  }
  return null;
}

/**
 * A manager's "Release requests" queue without the requests they raised
 * themselves — those are theirs to withdraw, never theirs to release.
 */
export function withoutOwnRequests<T extends { requested_by: string | null }>(
  rows: readonly T[],
  sessionEmail: string,
): T[] {
  const me = sessionEmail.trim().toLowerCase();
  return rows.filter((r) => (r.requested_by ?? '').trim().toLowerCase() !== me);
}

/**
 * The roster `GET /api/manager/transfer-candidates` serves before `?q=` /
 * `?department=` narrow it.
 *
 *  - `purpose: 'transfer'` (the "Request transfer in" dialog) → everyone. A
 *    manager may pull someone out of a department they also manage.
 *  - anything else (the KPI calculators' "add external member" pickers and
 *    "Add missing as externals") → the manager's OWN departments are dropped,
 *    because those callers treat every returned person as external to the team.
 *    Unchanged since before 2026-09-25; do not fold the two back together.
 *
 * Admins, and managers with no assignments, always get everyone.
 */
export function candidatePool<T extends Person>(
  people: readonly T[],
  args: { isAdmin: boolean; managedDepts: readonly string[]; purpose: string | null },
): T[] {
  if (args.isAdmin || args.purpose === 'transfer') return [...people];
  const ownDepts = new Set(args.managedDepts.map((d) => d.trim().toLowerCase()).filter(Boolean));
  if (ownDepts.size === 0) return [...people];
  return people.filter((p) => {
    const d = (p.department ?? '').trim().toLowerCase();
    return !(d && ownDepts.has(d));
  });
}
