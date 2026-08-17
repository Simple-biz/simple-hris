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
  // The manager published (or changed) this employee's KPI bonus for a
  // dept-week — carries the peso amount. Fired on Mark Ready/Lock and on any
  // change landing on an already-published week. Employee-only, ungated.
  'kpi.scored': ['employee'],
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
