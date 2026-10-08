'use client';

/**
 * Accounting Scoreboard browser cache. Kane, 2026-10-06: *"all the tabs should be stored in browser
 * cache i dont wanna see loading every switch of tab"*.
 * Governing doc: docs/features/accounting-scoreboard.md § Browser cache.
 *
 * Built on the shared envelope (`src/lib/dashboard-cache/create-tab-cache.ts`): `sessionStorage`,
 * never `localStorage`; identity-stamped and inert until bound; 12 h ceiling; a different viewer
 * binding purges first; and **no skip-fetch flag is reachable**. A cached board PAINTS the instant the
 * page or a week opens. It never DECIDES: the board is fetched again every time, and the fetched
 * copy replaces it. The board is a sheet other people type into all day, so a skipped fetch would
 * leave you typing over numbers that already moved.
 *
 * What is cached:
 * - `board:<Sunday>`: the board for one week, exactly as GET /api/accounting-scoreboard returned it,
 *   **minus `viewer`**. `viewer.role` is a PERMISSION (it shows Setup and the delete buttons),
 *   and a cached permission is a cached value deciding (qc-contractor-tickets-cache.md, the Tickets
 *   `access` rule). The viewer comes from the server-rendered page on every load instead.
 * - `board:weeks`: the weeks held, newest-written first. Only MAX_CACHED_WEEKS boards are kept (one
 *   board measured ~150k characters on 2026-10-06, and on the HRIS domain this origin's
 *   sessionStorage is shared with People and NPD).
 * - `roster`: Setup's people picker (name, department, work email; nothing else is selected).
 *
 * Nothing here holds a bank field, a token, a signed URL or presence.
 */

import { createTabCache } from '@/lib/dashboard-cache/create-tab-cache';
import type { BoardPayload, RosterPerson } from './types';

export const scoreboardTabCache = createTabCache('acct-sb:');

/** The board as cached: everything the GET returned except the viewer (a permission, never cached). */
export type CachedBoard = Omit<BoardPayload, 'viewer'>;

/** Boards kept at once (newest-written first). Older weeks are dropped, never painted from. */
export const MAX_CACHED_WEEKS = 4;

/** Stable keys. **Every key here is wired to a live call site.** */
export const SCOREBOARD_CACHE_KEYS = {
  board: (weekStart: string) => `board:${weekStart}`,
  weeks: 'board:weeks',
  roster: 'roster',
} as const;

/** Bind to the signed-in viewer before anything reads. A different viewer purges first. */
export function bindScoreboardCache(email: string | null): void {
  scoreboardTabCache.bindIdentity(email);
}

export function clearAllScoreboardCache(): void {
  scoreboardTabCache.clearAll();
}

/** The cached board for the week starting `weekStart` (a Sunday), or undefined. Never carries a viewer. */
export function readCachedBoard(weekStart: string): CachedBoard | undefined {
  const cached = scoreboardTabCache.get<CachedBoard>(SCOREBOARD_CACHE_KEYS.board(weekStart));
  // Fail closed on a blob whose week does not match its key: it would paint one week as another.
  if (!cached || typeof cached !== 'object' || cached.weekStart !== weekStart) return undefined;
  return cached;
}

/** Store a board under its own week, without the viewer, and keep only the newest MAX_CACHED_WEEKS. */
export function writeCachedBoard(board: BoardPayload): void {
  if (scoreboardTabCache.boundIdentity() === null) return;
  const { viewer, ...cached } = board;
  void viewer; // a permission: dropped here, supplied fresh by the page on every load
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.board(board.weekStart), cached);
  const held = scoreboardTabCache.get<string[]>(SCOREBOARD_CACHE_KEYS.weeks) ?? [];
  const weeks = [board.weekStart, ...held.filter((w) => w !== board.weekStart)];
  for (const dropped of weeks.slice(MAX_CACHED_WEEKS)) scoreboardTabCache.clear(SCOREBOARD_CACHE_KEYS.board(dropped));
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.weeks, weeks.slice(0, MAX_CACHED_WEEKS));
}

export function readCachedRoster(): RosterPerson[] | undefined {
  const cached = scoreboardTabCache.get<RosterPerson[]>(SCOREBOARD_CACHE_KEYS.roster);
  return Array.isArray(cached) ? cached : undefined;
}

export function writeCachedRoster(people: RosterPerson[]): void {
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.roster, people);
}
