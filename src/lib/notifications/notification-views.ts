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
  'offboarding.requested': ['hr', 'admin'],
  'offboarding.request_completed': ['manager'],
  'offboarding.request_dismissed': ['manager'],
  'offboarding.request_returned': ['manager'],
  'rate.change': ['employee'],
  'dispute.approved': ['employee'],
  'dispute.denied': ['employee'],
  'dispute.revoked': ['employee'],
  'time_adjustment.approved': ['employee'],
  'time_adjustment.denied': ['employee'],
  'special_transfer.recorded': ['employee'],
  'bank_info.requested': ['employee'],
  'people.banking.self_updated': ['accounting', 'admin', 'ceo'],
  'payroll.processing_started': ['admin', 'hr', 'accounting'],
  'payroll.processing_stopped': ['admin', 'hr', 'accounting'],
};

/** Dashboards a notification of `type` belongs to. Unknown types -> none. */
export function viewsForNotificationType(type: string | null | undefined): AppView[] {
  if (!type) return [];
  return NOTIFICATION_TYPE_TO_VIEWS[type] ?? [];
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
