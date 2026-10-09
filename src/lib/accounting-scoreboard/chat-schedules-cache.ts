'use client';

/**
 * Setup → Scheduled Posts in the browser cache: `acct-sb:chat-schedules`, on the board's own envelope
 * (`scoreboardTabCache`, tab-cache.ts: sessionStorage, bound to the viewer, 12 h ceiling, a different viewer purges
 * first). Its own module so the key and its guard sit beside the area that uses them.
 *
 * The board's rules, unchanged: the cached copy PAINTS, it never decides. Every visit fetches again and the server's
 * answer replaces it; only the server's answer is written. The viewer is never cached. Painted only for a role that may
 * see Setup NOW (`view_setup`, the role the server page resolved on this load); a 401 / 403 forgets it. It holds the
 * posts, their words, the recent posts and the team's counts: no webhook, no bank field, no token.
 *
 * Governing doc: docs/features/accounting-scoreboard-scheduled-posts.md § The area.
 */

import { scoreboardTabCache } from './tab-cache';
import { can, type BoardRole } from './roles';
import type { ChatSchedulesPayload } from './chat-schedule';

export const CHAT_SCHEDULES_CACHE_KEY = 'chat-schedules';

export type CachedChatSchedules = Omit<ChatSchedulesPayload, 'viewer'>;

export function readCachedChatSchedules(role: BoardRole): CachedChatSchedules | undefined {
  if (!can(role, 'view_setup')) return undefined;
  const cached = scoreboardTabCache.get<CachedChatSchedules>(CHAT_SCHEDULES_CACHE_KEY);
  if (!cached || typeof cached !== 'object') return undefined;
  if (!Array.isArray(cached.schedules) || !Array.isArray(cached.posts)) return undefined;
  return cached;
}

export function writeCachedChatSchedules(payload: ChatSchedulesPayload): void {
  if (scoreboardTabCache.boundIdentity() === null) return;
  const { viewer, ...cached } = payload;
  void viewer; // a permission: dropped here, supplied fresh by the page on every load
  scoreboardTabCache.set(CHAT_SCHEDULES_CACHE_KEY, cached);
}

export function clearCachedChatSchedules(): void {
  scoreboardTabCache.clear(CHAT_SCHEDULES_CACHE_KEY);
}
