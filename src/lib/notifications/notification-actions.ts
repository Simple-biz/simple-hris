import type { AppView } from '@/lib/rbac/views';

/**
 * Turns a notification into a "jump to the thing it's about" action.
 *
 * In-dashboard navigation here is state-based, not URL-based (see HrApp: it
 * swaps components off an `activeTab` state, and HrOnboarding swaps off a
 * `subTab` state). So a deep-link is expressed as the tab/sub-tab to switch to
 * plus the id of the entity to open — the dashboard shell reads this and drives
 * its own state down to the leaf component (e.g. opening the submission drawer).
 *
 * This is the single place that maps a notification `type` (per dashboard) to
 * where the recipient would act on it. To make a new HR/manager/etc.
 * notification clickable, add a resolver under its view + type here — the button
 * then appears automatically wherever {@link NotificationsPanel} is mounted with
 * a matching `view` + `onNavigate`.
 */
export interface NotificationActionTarget {
  /** Top-level dashboard tab id to switch to (e.g. an `HrTab`). */
  tab: string;
  /** Optional sub-tab within that tab's component (e.g. HrOnboarding's `subTab`). */
  subTab?: string;
  /** Optional id of the specific entity to open (e.g. an onboarding submission). */
  entityId?: string | null;
}

export interface ResolvedNotificationAction extends NotificationActionTarget {
  /** Button label, e.g. "Review submission". */
  label: string;
}

type Details = Record<string, unknown> | null | undefined;

function readString(details: Details, key: string): string | null {
  if (!details || typeof details !== 'object') return null;
  const v = (details as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Per view, per notification type: build a target from the notification's details. */
type ActionResolver = (details: Details) => ResolvedNotificationAction | null;

const ACTIONS: Partial<Record<AppView, Record<string, ActionResolver>>> = {
  hr: {
    // A hire finished their onboarding paperwork → open the submission drawer in
    // Onboarding → Onboarding Form. `details.submission_id` is stamped by
    // notifyHrOfSubmission (app/api/onboarding/[token]/route.ts).
    'onboarding.submitted': (details) => {
      const id = readString(details, 'submission_id');
      if (!id) return null;
      return {
        tab: 'onboarding',
        subTab: 'onboarding-form',
        entityId: id,
        label: 'Review submission',
      };
    },
    // A manager sent someone to offboarding (or an approved resignation queued
    // them) → open the Offboarding → Queue tab, mirroring the onboarding
    // "Review submission" jump. The queue is HrOffboarding's default sub-tab, so
    // switching to the tab lands on the pending requests; no entity id needed.
    'offboarding.requested': () => ({
      tab: 'offboarding',
      subTab: 'queue',
      label: 'Review request',
    }),
  },
};

/**
 * Resolve the click-through action for a notification within a given dashboard,
 * or `null` when there's nothing to jump to (unknown type, wrong view, or the
 * details payload is missing the id we'd need to open the entity).
 */
export function resolveNotificationAction(
  view: AppView | null | undefined,
  type: string | null | undefined,
  details: Details,
): ResolvedNotificationAction | null {
  if (!view || !type) return null;
  const resolver = ACTIONS[view]?.[type];
  return resolver ? resolver(details) : null;
}
