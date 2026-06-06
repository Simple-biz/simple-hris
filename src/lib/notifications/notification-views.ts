import type { AppView } from '@/lib/rbac/views';

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
  'rate.change': ['employee'],
  'dispute.approved': ['employee'],
  'dispute.denied': ['employee'],
  'dispute.revoked': ['employee'],
  'time_adjustment.approved': ['employee'],
  'time_adjustment.denied': ['employee'],
  'payroll.processing_started': ['admin', 'hr', 'accounting'],
  'payroll.processing_stopped': ['admin', 'hr', 'accounting'],
};

/** Dashboards a notification of `type` belongs to. Unknown types -> none. */
export function viewsForNotificationType(type: string | null | undefined): AppView[] {
  if (!type) return [];
  return NOTIFICATION_TYPE_TO_VIEWS[type] ?? [];
}
