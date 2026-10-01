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
  /** Top-level dashboard tab id to switch to (e.g. an `HrTab`). Omitted for
   *  URL-based targets (see {@link NotificationActionTarget.href}). */
  tab?: string;
  /** Optional sub-tab within that tab's component (e.g. HrOnboarding's `subTab`). */
  subTab?: string;
  /** Optional id of the specific entity to open (e.g. an onboarding submission). */
  entityId?: string | null;
  /** URL-based target for actions that live OUTSIDE the host dashboard's tab
   *  state (e.g. the /tickets board). The NotificationsPanel routes to it
   *  itself, so hosts don't need an `onNavigate` handler for these. */
  href?: string;
}

export interface ResolvedNotificationAction extends NotificationActionTarget {
  /** Button label, e.g. "Review submission". */
  label: string;
  /**
   * Whether the button asks the viewer to DO something (review a submission,
   * reply on a ticket) rather than just take them to read about it. Only these
   * count toward the panel's "Need Action" tile. Required, so every new
   * resolver decides out loud instead of defaulting into the count.
   */
  needsAction: boolean;
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
        needsAction: true,
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
      needsAction: true,
    }),
  },
  employee: {
    // Someone replied on the recipient's HRIS-updates ticket → jump to the
    // /tickets board with the ticket auto-opened on its Updates thread.
    // `details.ticket_id` is stamped by POST /api/tickets/[id]/comments.
    'ticket.replied': (details) => {
      const id = readString(details, 'ticket_id');
      return {
        href: id ? `/tickets?ticket=${encodeURIComponent(id)}` : '/tickets',
        label: 'View & reply',
        needsAction: true,
      };
    },
    // Assigned a ticket to fix. The button helps assignees who hold a board
    // role; roleless assignees get bounced home by the proxy, so the
    // notification MESSAGE itself carries the full ask (see the tickets PATCH).
    'ticket.assigned': (details) => {
      const id = readString(details, 'ticket_id');
      return {
        href: id ? `/tickets?ticket=${encodeURIComponent(id)}` : '/tickets',
        label: 'Open ticket',
        needsAction: true,
      };
    },
    // The requester's ticket changed column. Same deep link as a reply — the
    // dialog opens on the activity feed, which is where the move is spelled
    // out. `details.ticket_id` is stamped by PATCH /api/tickets/[id].
    'ticket.moved': (details) => {
      const id = readString(details, 'ticket_id');
      return {
        href: id ? `/tickets?ticket=${encodeURIComponent(id)}` : '/tickets',
        label: 'Open ticket',
        // A column move is news, not a request: nothing waits on the reader.
        needsAction: false,
      };
    },
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

/* ───────────────────────── the panel's "Need Action" tile ───────────────── */

/**
 * The live outcome of an offboarding request's queue rows, as the panel
 * summarises them: `resolved` once every known row is terminal. `null` when no
 * row's status is known (not loaded, or not the HR panel).
 */
export type OffboardOutcome = { resolved: boolean } | null;

/**
 * Whether one notification still waits on this viewer.
 *
 * - Its button must ask for an action (`needsAction`), and must actually render
 *   here — pass the action the card shows, which is null when there is none.
 * - An offboarding request whose queue rows are known goes by the QUEUE: still
 *   pending/processing counts even after it was read; already actioned never
 *   counts. That is the one place the HRIS can see the outcome.
 * - Everything else goes by `read_at`, the only "handled" signal there is. The
 *   panel marks what it shows read 2s after display but keeps it highlighted for
 *   the visit, so the tile agrees with the "New" pills on screen.
 */
export function notificationNeedsAction(
  action: ResolvedNotificationAction | null,
  readAt: string | null,
  offboard: OffboardOutcome,
): boolean {
  if (!action || !action.needsAction) return false;
  if (offboard) return !offboard.resolved;
  return !readAt;
}

function readStringArray(details: Details, key: string): string[] {
  if (!details || typeof details !== 'object') return [];
  const v = (details as Record<string, unknown>)[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/**
 * What one action is ABOUT, so the same submission / ticket / request counts
 * once however many notifications point at it. Not hypothetical: measured
 * 2026-10-01, one HR account held 11,573 `onboarding.submitted` rows for 1,328
 * submissions (up to 49 per submission) — the onboarding backfill re-notifies.
 * A ticket's reply and its assignment are one ticket to look at.
 */
export function needActionKey(
  n: { id: string; details: Details },
  action: ResolvedNotificationAction,
): string {
  const requestIds = readStringArray(n.details, 'request_ids');
  if (requestIds.length > 0) return `request:${[...requestIds].sort().join(',')}`;
  if (action.entityId) return `entity:${action.tab ?? ''}/${action.subTab ?? ''}#${action.entityId}`;
  const ticketId = readString(n.details, 'ticket_id');
  if (ticketId) return `ticket:${ticketId}`;
  return `notification:${n.id}`;
}

/**
 * The "Need Action" figure: distinct things waiting on the viewer across the
 * list given (the whole loaded list — never a search result or one page).
 * `stateOf` returns what the card renders: its action (null when no button) and
 * its offboarding outcome.
 */
export function countNeedAction<N extends { id: string; details: Details; read_at: string | null }>(
  items: readonly N[],
  stateOf: (n: N) => { action: ResolvedNotificationAction | null; offboard: OffboardOutcome },
): number {
  const keys = new Set<string>();
  for (const n of items) {
    const { action, offboard } = stateOf(n);
    if (action && notificationNeedsAction(action, n.read_at, offboard)) keys.add(needActionKey(n, action));
  }
  return keys.size;
}
