import type { AppView } from '@/lib/rbac/views';
import type { FeatureViewKey, FeaturePermissionsMap } from '@/lib/rbac/feature-permissions';

/**
 * Maps each `employee_notifications.type` to the dashboard(s) where the
 * recipient would act on it. A single notification can belong to more than one
 * dashboard (e.g. an onboarding submission is actionable from both HR and
 * Admin), so values are arrays.
 *
 * This is the single source of truth that lets the Switch View component show a
 * per-dashboard unread badge even though every notification lives in one table
 * keyed only by recipient email. When a new notification flow is added, map its
 * type here so its count surfaces on the right dashboard.
 */
export const NOTIFICATION_TYPE_TO_VIEWS: Record<string, AppView[]> = {
  'onboarding.submitted': ['hr', 'admin'],
  'transfer.requested': ['hr', 'admin'],
  // Department Transfers v2 (managers-only): the source dept manager is asked to
  // release; the receiving manager is told the outcome; the employee learns when
  // the move actually takes effect. All ungated so managers always see them.
  'transfer.release_requested': ['manager'],
  'transfer.released': ['manager'],
  'transfer.declined': ['manager'],
  'transfer.applied': ['manager', 'employee'],
  'offboarding.requested': ['hr', 'admin'],
  'offboarding.request_completed': ['manager'],
  'offboarding.request_dismissed': ['manager'],
  'offboarding.request_returned': ['manager'],
  // Employee resigns → their department manager reviews it in My Team; the
  // employee is told the outcome. (submitted → manager; approved/rejected → employee)
  'resignation.submitted': ['manager'],
  'resignation.approved': ['employee'],
  'resignation.rejected': ['employee'],
  'rate.change': ['employee'],
  'dispute.approved': ['employee'],
  'dispute.denied': ['employee'],
  'dispute.revoked': ['employee'],
  'time_adjustment.approved': ['employee'],
  'time_adjustment.denied': ['employee'],
  'special_transfer.recorded': ['employee'],
  'bank_info.requested': ['employee'],
  'people.banking.self_updated': ['accounting', 'admin', 'ceo'],
  'people.banking.overridden': ['employee'],
  'payroll.processing_started': ['admin', 'hr', 'accounting'],
  'payroll.processing_stopped': ['admin', 'hr', 'accounting'],
  // Payment Dispatch marked this employee's salary paid. Lands in their own
  // notification panel with an "Open Pay Stub" button (the same statement we
  // email). Employee-only, ungated.
  'payroll.paid': ['employee'],
  // Accounting uploaded a new Hubstaff week (Payroll Wizard CSV upload / API
  // sync): the employee's salary for that week is ready to view. Same
  // "Open Pay Stub" button as payroll.paid. Employee-only, ungated.
  'payroll.available': ['employee'],
  // A freshly ingested Hubstaff week left N active roster members with no hours
  // and no explanation (not an untracked dept, not approved leave, not a new
  // hire) — Accounting reconciles whether they are still active, on leave, sick,
  // or were never actually offboarded. ACCOUNTING ONLY (Kane 2026-08-21): it
  // names headcount, not money, and HR has its own offboarding queue — adding a
  // second view here would put a payroll-operations chore on the HR chime.
  'payroll.hours_gap': ['accounting'],
  // Accounting excluded (or restored) this employee from a month's Perfect
  // Attendance Bonus in the Payroll Wizard's PAB settings modal. Informational
  // card only, no click-through action. Employee-only, ungated.
  'pab.excluded': ['employee'],
  'pab.restored': ['employee'],
  // Someone replied on the recipient's HRIS-updates ticket. Lives in the
  // Employee dashboard's notification panel (everyone who can file a ticket
  // has one), which is also where it's marked read.
  'ticket.replied': ['employee'],
  // The recipient was assigned a ticket to fix. Same home as replies — the
  // assignee may hold NO board role, so the message itself carries the ask.
  'ticket.assigned': ['employee'],
  // The recipient's own ticket changed column. Same home as the other two —
  // the requester is an employee first, whatever dashboard they also hold.
  'ticket.moved': ['employee'],
  // Employee Support live chat. Both are the EMPLOYEE's, never the agent's —
  // the five answerers watch the queue itself, they do not need a badge for
  // their own work.
  //
  // These must stay mapped. `viewsForNotificationType` returns [] for an
  // unknown type, `useNotificationCountsByView` then adds the row to no view's
  // count, and the ViewSwitcher badge never lights — so an unmapped type is a
  // notification that exists in the table and reaches nobody. That is worst for
  // `became_ticket`, which carries the ES- number the employee is owed after
  // their chat went unanswered: the one message they are relying on would be
  // the one that never surfaces. Changed together with
  // references/sql/alter/2026-09-19_add_chat_notification_types.sql, which says
  // the same thing from the other side.
  'support_chat.replied': ['employee'],
  'support_chat.became_ticket': ['employee'],
  // Employee Support TICKETS — the second door behind the Employee dashboard's
  // Help button (Kane, 2026-09-21: "Chat Support or a Ticket"). Both are the
  // EMPLOYEE's, for the same reason as the chat pair above: the five answerers
  // work the queueing line and the board on /tickets, and a badge on that
  // dashboard for their own replies would be noise. No type exists for the
  // staff side — the two widens admit exactly these three, all the employee's —
  // so an employee's reply reaches the answerers through the line they already
  // watch, not a badge.
  //
  //   support.replied   a staff member replied on the employee's ES- ticket.
  //                     Carla signed "A notification the moment someone
  //                     replies" (2026-09-15); this is that notification.
  //   support.answered  the ticket reached Answered on the employee's track
  //                     map (SUPPORT_STATUS_LABELS, src/lib/support/types.ts:58-63),
  //                     which `nextStatus` does on the FIRST staff reply
  //                     (src/lib/support/lifecycle.ts:194-198) — the reply that
  //                     stamps `first_response_at` and that Carla's
  //                     one-working-day promise is measured against.
  //
  // Both must stay mapped, for the reason spelled out above the chat pair: an
  // unmapped type is a notification that exists in the table and reaches
  // nobody, and here it would be the answer the employee has been promised.
  // The mapping does not depend on which reply the route files under which
  // type — either way it is the employee's. Changed together with
  // references/sql/alter/2026-09-21_support_notification_types.sql, which adds
  // exactly these two values and says the same thing from the other side;
  // notification-views.test.ts holds the files to each other.
  'support.replied': ['employee'],
  'support.answered': ['employee'],
  //   support.closed    a staff member closed the employee's ES- ticket (Kane,
  //                     2026-09-25: "make sure that the Employee is to be
  //                     notified of this"). Closing ends their expectation of a
  //                     reply, so it is theirs for the same reason as the two
  //                     above. Admitted by its OWN widen,
  //                     references/sql/alter/2026-09-25_add_support_closed_notification_type.sql;
  //                     notification-views.test.ts holds this family to the
  //                     UNION of both files' `added` lists.
  'support.closed': ['employee'],
  // Somebody filled in or updated their tenure-gift delivery details — through
  // the public /update-gift-address link, their Employee dashboard card, or a
  // staff entry. HR ONLY (Kane, 2026-09-22: "HR Dashboard people with HR - Gift
  // Tracker Access"), because the Gift Tracker lives on the HR dashboard and
  // that is where the "Recently filled / updated" sub-tab it points at lives.
  //
  // ONE type for all three channels: same news, same readers, and which surface
  // it came from is a detail on the row rather than a different notification.
  //
  // The MAP is the view scope; the RECIPIENT list is narrower still and is
  // resolved from the `hr / gift_tracker` grant in
  // `src/lib/notifications/gift-shipping-submitted.ts` — mapping to ['hr'] keeps
  // the chime, the badge and the panel agreeing with each other for the people
  // who do receive it. Changed together with
  // references/sql/alter/2026-09-22_add_gift_shipping_notification_type.sql.
  'gift_shipping.submitted': ['hr'],
  // The manager published (or changed) this employee's KPI bonus for a
  // dept-week — carries the peso amount. Fired on Mark Ready/Lock and on any
  // change landing on an already-published week. Employee-only, ungated.
  'kpi.scored': ['employee'],
  // A department manager marked a dept-week's KPI bonuses Ready or Locked, so the
  // week is scored and payable — including weeks scored AHEAD of their Hubstaff file
  // (Kane, 2026-09-10). Fired on publish only, never per autosave. ACCOUNTING ONLY,
  // the payroll.hours_gap rule: it is a payroll-operations signal, and employees
  // already hear about their own amounts through kpi.scored.
  'kpi.published': ['accounting'],
  // A QC officer locked a week of KPI scores; the reviewing dept managers act on
  // it inside the KPI Calculator, which lives on the Manager dashboard.
  'qc.scores_submitted': ['manager'],
  // A manager returned KPI scores for revision; the QC officers who own that
  // dept-week fix them from the QC dashboard.
  'qc.scores_returned': ['qc'],
  // An employee submitted a document (pay stubs / COE / award) for signing;
  // Accounting acts on it in the Documents tab. The outcome goes back to the
  // employee — signed copies download from Profile → Request Documents.
  'documents.requested': ['accounting'],
  'documents.signed': ['employee'],
  'documents.rejected': ['employee'],
};

/** Dashboards a notification of `type` belongs to. Unknown types -> none. */
export function viewsForNotificationType(type: string | null | undefined): AppView[] {
  if (!type) return [];
  return NOTIFICATION_TYPE_TO_VIEWS[type] ?? [];
}

/**
 * Notification types that must be HIDDEN when the panel is scoped to `view` —
 * i.e. every *mapped* type whose dashboard list does not include `view`. Types
 * with no mapping at all are deliberately absent from this list: an unknown /
 * unmapped type is treated as global and shown on every dashboard rather than
 * silently vanishing. Feeds the `?view=` exclusion in
 * `GET /api/employee-notifications`.
 */
export function hiddenTypesForView(view: AppView): string[] {
  return Object.entries(NOTIFICATION_TYPE_TO_VIEWS)
    .filter(([, views]) => !views.includes(view))
    .map(([type]) => type);
}

/**
 * Notification types whose *visibility* is gated behind a feature grant. A
 * recipient only sees a gated notification if they (a) hold a role that maps to
 * the gate's `view` and (b) have at least `view` access to the named feature
 * there — i.e. they were given access from the HR / Admin Roles tab. Admins
 * always see everything.
 *
 * Types NOT listed here are "global": every recipient sees them regardless of
 * feature permissions. The payroll-processing lock (`payroll.processing_started`
 * / `payroll.processing_stopped`) is intentionally absent — starting the payroll
 * wizard is a company-wide alert that everyone receiving it should see.
 *
 * Gating is enforced server-side in `GET /api/employee-notifications`, which
 * also backs `useNotificationCountsByView`, so the panel and the per-dashboard
 * unread badges stay in sync.
 */
export const NOTIFICATION_TYPE_FEATURE_GATE: Record<
  string,
  { view: FeatureViewKey; feature: string }
> = {
  'onboarding.submitted': { view: 'hr', feature: 'onboarding' },
  // Only HR users with offboarding access should see the "new offboarding
  // request" alert; the manager-facing outcome notifications stay ungated so
  // the requesting manager always learns what happened to their request.
  'offboarding.requested': { view: 'hr', feature: 'offboarding' },
  // Only accounting users granted the Documents tab (the Accounting Head)
  // should be pinged about new signing requests; the employee-facing outcome
  // notifications stay ungated.
  'documents.requested': { view: 'accounting', feature: 'documents' },
};

/**
 * Whether a viewer may *see* a notification of `type`. Ungated types (those
 * absent from {@link NOTIFICATION_TYPE_FEATURE_GATE}) and unknown types are
 * always visible — that's how the global payroll-lock alert reaches everyone.
 * A gated type requires either admin or at least `view` access to its owning
 * feature, i.e. the same perms-overlay grant the dashboards use for tab
 * visibility (see view-tabs.ts). Pure logic — safe on both server and client.
 */
export function canViewNotificationType(
  type: string | null | undefined,
  viewer: { isAdmin?: boolean; perms?: FeaturePermissionsMap | null },
): boolean {
  if (!type) return true;
  const gate = NOTIFICATION_TYPE_FEATURE_GATE[type];
  if (!gate) return true; // global / ungated
  if (viewer.isAdmin) return true;
  const access = viewer.perms?.[gate.view]?.[gate.feature] ?? 'hidden';
  return access === 'view' || access === 'edit';
}
