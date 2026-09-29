/**
 * The in-page signal `useNotificationChime` fires the moment it announces NEW
 * notifications — so a surface showing the number a notification is about can
 * refetch on the toast instead of on its own, unsynchronised timer.
 *
 * Why this exists: the Employee Overview's KPI Bonus card read `/api/kpi-results`
 * ONCE on mount, and the employee shell keeps tabs mounted, so a "KPI Bonus
 * Scored" toast arrived while the card beside it kept the old peso figure until
 * a reload. A poll alone cannot close that — two independent 30s timers still
 * drift up to 30s apart, which is exactly "the notification goes first".
 *
 * Client-safe on purpose: `kpi-scored.ts` imports the service-role client, so the
 * type string is mirrored here and a test pins it equal to `KPI_SCORED_TYPE`.
 */

export const NOTIFICATION_ARRIVED_EVENT = 'notification:arrived';

/** Mirror of `KPI_SCORED_TYPE` (`src/lib/notifications/kpi-scored.ts`). */
export const KPI_SCORED_NOTIFICATION = 'kpi.scored';

export type NotificationArrivedDetail = {
  /** The chime's view scope, or null for an unscoped mount. */
  view: string | null;
  /** The `type` of every notification announced in this batch. */
  types: string[];
};

/** True when `detail` is a well-formed announcement carrying any of `wanted`. */
export function detailMatchesTypes(detail: unknown, wanted: readonly string[]): boolean {
  if (!detail || typeof detail !== 'object') return false;
  const types = (detail as { types?: unknown }).types;
  if (!Array.isArray(types)) return false;
  return types.some((t) => typeof t === 'string' && wanted.includes(t));
}

export function announceNotificationsArrived(
  detail: NotificationArrivedDetail,
  target: EventTarget = window,
): void {
  target.dispatchEvent(new CustomEvent(NOTIFICATION_ARRIVED_EVENT, { detail }));
}

/**
 * Calls `onArrived` whenever the chime announces a notification of one of
 * `types`. Returns the unsubscribe, so it drops straight into an effect cleanup.
 */
export function subscribeNotificationTypes(
  types: readonly string[],
  onArrived: () => void,
  target: EventTarget = window,
): () => void {
  const listener = (e: Event) => {
    if (detailMatchesTypes((e as CustomEvent<unknown>).detail, types)) onArrived();
  };
  target.addEventListener(NOTIFICATION_ARRIVED_EVENT, listener);
  return () => target.removeEventListener(NOTIFICATION_ARRIVED_EVENT, listener);
}
