/**
 * The three calls a SHARED panel needs to paint from whichever dashboard's tab
 * cache its host hands it.
 *
 * `LeaveRequestsPanel`, `AnnouncementWall`, `SWall` and `NotificationsPanel` are
 * mounted by several dashboards, each with its own store (or none). The panel
 * takes an optional `paintCache` prop instead of importing a store, so a host
 * that passes nothing keeps the panel's uncached behaviour exactly.
 *
 * Deliberately NO skip predicate. A shared panel seeds its first paint from the
 * cache and then runs its fetch anyway, silently — the same shape `HrScreening`
 * has always had and the only shape the factory in `create-tab-cache.ts` can
 * express. The reason is per panel, not general: Announcements and S-Wall rely
 * on Realtime to show a new post, and browser `postgres_changes` is documented
 * dead here, so a skipped fetch would hide a post you just made; Notifications
 * must agree with the chime and the sidebar badge, which are live. A panel that
 * may skip would also carry one host's freshness policy into every other host.
 *
 * Satisfied structurally by every `TabCache` from `create-tab-cache.ts` and by
 * the HR adapter `hrPaintCache` (`src/lib/hr/tab-cache.ts`).
 */
export interface PaintCache {
  /** The cached value, or `undefined` when there is none. `null` and `[]` are real values. */
  get<T>(key: string): T | undefined;
  /** Is there something to PAINT under `key`? Never "may the fetch be skipped". */
  has(key: string): boolean;
  set<T>(key: string, value: T): void;
}

/** What a host passes: the store, and the key prefix this mount owns in it. */
export interface PaintCacheProp {
  store: PaintCache;
  /**
   * The host's base key. The panel appends whatever makes its payload differ
   * between mounts (scope, viewer, view), so two mounts can never share a row
   * list they would disagree about.
   */
  key: string;
}
