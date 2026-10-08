import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';

/**
 * Who hears that HR returned an offboarding request to the manager (Open item 397).
 *
 * Until 2026-10-07 the queue PATCH told `requested_by` alone. On 2026-10-06 HR
 * returned Carla's request for Mark Arriola (Lead Gen) and Jackie, who manages
 * Lead Gen, was never a recipient: "Jackie didn't get a notification on that
 * and that's she wants one set up." A requester is often not the person's
 * manager (Carla raises rows for every department), so the department's
 * managers are told too.
 *
 * Recipients: the requester, plus every active manager of the departing
 * person's department, de-duplicated case-insensitively. Never the person who
 * did the return, and never the person being offboarded (a manager can be
 * offboarded out of a department they manage).
 *
 * Pure: the route reads the grants and does the insert.
 */

/**
 * Already admitted by `employee_notifications_type_check` (since 2026-07-02) and
 * mapped to the Manager dashboard (`notification-views.ts`). A new type would
 * need a CHECK ALTER first, and a rejected insert looks exactly like success.
 */
export const RETURNED_NOTIFICATION_TYPE = 'offboarding.request_returned' as const;

const TITLE = 'Offboarding Request Returned';

export type ManagerAssignment = { manager_email: string; department: string };

export type ReturnedNotificationInput = {
  requestId: string;
  /** `employee_name`, or the queue key when there is no name. */
  employeeName: string;
  employeeEmail: string;
  /** Every address of the departing person (queue key, work, personal). Never notified. */
  subjectEmails: readonly (string | null)[];
  requestedBy: string;
  requestedByName: string | null;
  /** From {@link departmentManagersFor}. */
  departmentManagers: readonly string[];
  returnedBy: string;
  /** The return reason. The route requires one, so null only reaches here from old callers. */
  note: string | null;
};

export type ReturnedNotificationRow = {
  recipient_email: string;
  type: typeof RETURNED_NOTIFICATION_TYPE;
  tone: 'neutral';
  title: string;
  message: string;
  details: {
    request_id: string;
    employee_email: string;
    employee_name: string;
    processed_by: string;
    requested_by: string;
    note: string | null;
    audience: 'requester' | 'department_manager';
  };
};

function norm(e: string | null | undefined): string {
  return (e ?? '').trim().toLowerCase();
}

/**
 * Active managers of `department`, using the SAME predicate the queue POST uses
 * to decide whether a manager may raise a request for that department
 * (`departmentMatchesManagedAssignments`: raw equality, then the department
 * key, so "Callbacks" and "Callback Team" are one). Whoever could have raised
 * the request is told when it comes back. Sorted, lower-cased, de-duplicated.
 */
export function departmentManagersFor(
  department: string | null | undefined,
  assignments: readonly ManagerAssignment[],
): string[] {
  if (!(department ?? '').trim()) return [];
  const out = new Set<string>();
  for (const a of assignments) {
    const email = norm(a.manager_email);
    if (!email) continue;
    if (departmentMatchesManagedAssignments(department, [a.department])) out.add(email);
  }
  return Array.from(out).sort();
}

/** One insertable `employee_notifications` row per recipient. */
export function buildReturnedNotifications(i: ReturnedNotificationInput): ReturnedNotificationRow[] {
  const excluded = new Set([norm(i.returnedBy), ...i.subjectEmails.map(norm)].filter(Boolean));
  const requester = norm(i.requestedBy);
  const tail = i.note ? `: "${i.note}"` : '.';
  const requesterLabel = i.requestedByName?.trim() || requester;
  const whose = requesterLabel ? `${requesterLabel}'s request` : 'a request';

  const rows: ReturnedNotificationRow[] = [];
  const seen = new Set<string>();
  const push = (recipient: string, audience: ReturnedNotificationRow['details']['audience']) => {
    if (!recipient || excluded.has(recipient) || seen.has(recipient)) return;
    seen.add(recipient);
    rows.push({
      recipient_email: recipient,
      type: RETURNED_NOTIFICATION_TYPE,
      tone: 'neutral',
      title: TITLE,
      message:
        audience === 'requester'
          ? `HR sent your request to offboard ${i.employeeName} back for another look${tail}`
          : `HR sent ${whose} to offboard ${i.employeeName} back for another look${tail}`,
      details: {
        request_id: i.requestId,
        employee_email: i.employeeEmail,
        employee_name: i.employeeName,
        processed_by: norm(i.returnedBy),
        requested_by: requester,
        note: i.note,
        audience,
      },
    });
  };

  // The requester first, so a requester who also manages the department keeps
  // the "your request" wording.
  push(requester, 'requester');
  for (const m of i.departmentManagers) push(norm(m), 'department_manager');
  return rows;
}
