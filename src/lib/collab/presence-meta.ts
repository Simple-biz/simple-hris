/**
 * Which of a person's presence entries the collab rail believes.
 *
 * Supabase presence keeps one entry ("meta") per open tab under a person's
 * key, and it delivers each change ONCE, as a diff. Reading `state[key][0]`
 * made the rail name a section the person was not on (Kane 2026-10-08:
 * Lenny's mirror showed Payment Dispatch while his rail label still said
 * Payroll Wizard; the server had him on `payment-dispatch` the whole time):
 *
 *  1. realtime-js 2.101.1 never removed a re-tracked entry from a viewer's
 *     state, so every section a person visited stacked up behind the first
 *     and `[0]` kept naming the first. Fixed at the source by
 *     patches/@supabase+realtime-js+2.101.1.patch (pinned by
 *     realtime-presence-patch.test.ts).
 *  2. `[0]` is the OLDEST entry. With two tabs open, it is whichever tab was
 *     opened first, not the one the person is looking at.
 *  3. A diff that is genuinely dropped (a reconnect, a rate limit) is never
 *     re-sent, so the old entry would stay until the next change.
 *
 * The publisher therefore re-announces itself every {@link COLLAB_RETRACK_MS}
 * while its tab is visible, and on every visibility or focus change. The
 * reader picks with {@link pickLiveMeta}: a live entry beats a stale one, the
 * most recently focused tab beats an older one, and the newest announcement
 * breaks a tie.
 */

/** How often a visible tab re-announces its section, so a missed diff heals. */
export const COLLAB_RETRACK_MS = 30_000;

/** A visible tab re-announces every {@link COLLAB_RETRACK_MS}. An entry that
 *  claims to be visible but has not spoken for three beats is a leftover. */
export const COLLAB_STALE_MS = COLLAB_RETRACK_MS * 3;

/** The fields {@link pickLiveMeta} ranks on. Every field is optional because
 *  a tab still running an older bundle sends none of the newer ones. */
export interface RankableMeta {
  /** `document.visibilityState === 'visible'` when the entry was sent. */
  active?: boolean;
  /** ISO time this tab was last shown or focused. Null until it has been. */
  focused_at?: string | null;
  /** ISO time the entry was sent. */
  online_at?: string;
}

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Live = the tab said it was visible and has spoken within the stale window.
 *  An older bundle sends no `active` flag; it is read as visible, as
 *  PresenceProvider reads it, and the stale window still applies. */
function isLive(meta: RankableMeta, now: number): boolean {
  return meta.active !== false && now - ms(meta.online_at) <= COLLAB_STALE_MS;
}

/**
 * The entry the rail should show for one person, or null for none.
 *
 * Order: live beats not live, then the latest `focused_at`, then the latest
 * `online_at`. Never the array position, which only says who joined first.
 */
export function pickLiveMeta<T extends RankableMeta>(
  metas: readonly T[] | null | undefined,
  now: number = Date.now(),
): T | null {
  if (!metas || metas.length === 0) return null;
  let best: T | null = null;
  let bestKey: [number, number, number] = [-1, -1, -1];
  for (const meta of metas) {
    if (!meta) continue;
    const key: [number, number, number] = [
      isLive(meta, now) ? 1 : 0,
      ms(meta.focused_at),
      ms(meta.online_at),
    ];
    if (
      key[0] > bestKey[0] ||
      (key[0] === bestKey[0] && key[1] > bestKey[1]) ||
      (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] > bestKey[2])
    ) {
      best = meta;
      bestKey = key;
    }
  }
  return best;
}
