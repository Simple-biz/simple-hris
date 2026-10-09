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
 * - `tasks:<view>`: one Tasks view (`me`, `all`, or a person's work email), exactly as GET /tasks returned it, **minus
 *   `viewer`**, the same rule as the board. Tasks have their own keys and are never inside a board blob
 *   (accounting-scoreboard-tasks.md § Loading and the browser cache). Two more guards, because a task view is
 *   both a permission and a period:
 *   - a view of someone else's board, or Everyone, is painted only for a role that may see it NOW (`view_all_tasks`,
 *     the role the server page just resolved), never because it happens to be cached;
 *   - a view is painted only on the Eastern day it was read: a tick counts for its period, so yesterday's
 *     daily ticks would paint as done today.
 * - `tasks:views`: the views held, newest-written first; only MAX_CACHED_TASK_VIEWS are kept.
 * - `keys`: Setup → Keys, exactly as GET /keys returned it, **minus `viewer`** (2026-10-09, Kane: *"make sure have
 *   stored data in cache as well"*). Painted only for a role that may see Keys NOW (`manage_keys`, Admin only); a
 *   401 / 403 forgets it. Platforms and who holds a seat on them: no bank field, no account number.
 * - `roles`: Setup → Access's live grants (email, role, who granted, when). Painted only for `manage_roles` NOW. A
 *   painted grant decides nothing: the server refuses a stale revoke (409, and the table's trigger).
 *
 * Nothing here holds a bank field, a token, a signed URL or presence.
 */

import { createTabCache } from '@/lib/dashboard-cache/create-tab-cache';
import { can, type BoardRole } from './roles';
import { payloadShowsView as showsView } from './task-load-progress';
import type { BoardPayload, KeysPayload, RoleGrant, RosterPerson, TasksPayload } from './types';
import type { HistoryWeek } from './history';

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
  tasks: (view: string) => `tasks:${view}`,
  taskViews: 'tasks:views',
  keys: 'keys',
  roles: 'roles',
  history: 'history',
} as const;

/** A Tasks view as cached: everything GET /tasks returned except the viewer (a permission, never cached). */
export type CachedTasks = Omit<TasksPayload, 'viewer'>;

/** Tasks views kept at once (newest-written first). A person's board is small; Everyone holds every live task. */
export const MAX_CACHED_TASK_VIEWS = 8;

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

/**
 * The cached Tasks view to PAINT, or undefined. `role` is the viewer's role as the server page resolved it on this
 * load, never a cached one: a view of anyone else's board is a miss for a role that may not see it. `today` is the
 * Eastern day: a view read on another day is a miss, because its ticks belong to other periods.
 */
export function readCachedTasks(view: string, today: string, role: BoardRole): CachedTasks | undefined {
  if (view !== 'me' && !can(role, 'view_all_tasks')) return undefined;
  const cached = scoreboardTabCache.get<CachedTasks>(SCOREBOARD_CACHE_KEYS.tasks(view));
  if (!cached || typeof cached !== 'object' || cached.today !== today) return undefined;
  if (!Array.isArray(cached.tasks) || !Array.isArray(cached.checks) || !showsView(view, cached.view)) return undefined;
  return cached;
}

/** Store the server's answer for one view, without the viewer, and keep only the newest MAX_CACHED_TASK_VIEWS. */
export function writeCachedTasks(view: string, payload: TasksPayload): void {
  if (scoreboardTabCache.boundIdentity() === null || !showsView(view, payload.view)) return;
  const { viewer, ...cached } = payload;
  void viewer; // a permission: dropped here, supplied fresh by the page on every load
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.tasks(view), cached);
  const held = scoreboardTabCache.get<string[]>(SCOREBOARD_CACHE_KEYS.taskViews) ?? [];
  const views = [view, ...held.filter((v) => v !== view)];
  for (const dropped of views.slice(MAX_CACHED_TASK_VIEWS)) scoreboardTabCache.clear(SCOREBOARD_CACHE_KEYS.tasks(dropped));
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.taskViews, views.slice(0, MAX_CACHED_TASK_VIEWS));
}

/** Forget one view: the server refused it (401 / 403), so it must never paint again. */
export function clearCachedTasks(view: string): void {
  scoreboardTabCache.clear(SCOREBOARD_CACHE_KEYS.tasks(view));
  const held = scoreboardTabCache.get<string[]>(SCOREBOARD_CACHE_KEYS.taskViews);
  if (held) scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.taskViews, held.filter((v) => v !== view));
}

/** Setup → Keys as cached: everything GET /keys returned except the viewer (a permission, never cached). */
export type CachedKeys = Omit<KeysPayload, 'viewer'>;

/** The cached Keys to PAINT, or undefined. `role` is the role the server page resolved on THIS load, never a cached one. */
export function readCachedKeys(role: BoardRole): CachedKeys | undefined {
  if (!can(role, 'manage_keys')) return undefined;
  const cached = scoreboardTabCache.get<CachedKeys>(SCOREBOARD_CACHE_KEYS.keys);
  if (!cached || typeof cached !== 'object') return undefined;
  if (!Array.isArray(cached.keys) || !Array.isArray(cached.seats) || !Array.isArray(cached.people)) return undefined;
  return cached;
}

/** Store the server's answer, without the viewer. */
export function writeCachedKeys(payload: KeysPayload): void {
  if (scoreboardTabCache.boundIdentity() === null) return;
  const { viewer, ...cached } = payload;
  void viewer; // a permission: dropped here, supplied fresh by the page on every load
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.keys, cached);
}

/** Forget Keys: the server refused them (401 / 403), so they must never paint again. */
export function clearCachedKeys(): void {
  scoreboardTabCache.clear(SCOREBOARD_CACHE_KEYS.keys);
}

/** The cached Access grants to PAINT, or undefined: only for a role that may manage roles NOW. */
export function readCachedRoleGrants(role: BoardRole): RoleGrant[] | undefined {
  if (!can(role, 'manage_roles')) return undefined;
  const cached = scoreboardTabCache.get<RoleGrant[]>(SCOREBOARD_CACHE_KEYS.roles);
  return Array.isArray(cached) ? cached : undefined;
}

export function writeCachedRoleGrants(grants: RoleGrant[]): void {
  if (scoreboardTabCache.boundIdentity() === null) return;
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.roles, grants);
}

/** Forget the grants: the server refused them (401 / 403). */
export function clearCachedRoleGrants(): void {
  scoreboardTabCache.clear(SCOREBOARD_CACHE_KEYS.roles);
}

/**
 * The History tab as cached: every week loaded so far, merged across its windows. Numbers anyone on the board may see
 * (the Overview's), so no role check; the cache is still bound to the viewer like every key here. Painted, then every
 * window is read again (accounting-scoreboard-history.md § Freshness).
 */
export interface CachedHistory {
  thisWeek: string;
  firstWeek: string | null;
  sectionIds: string[];
  weeks: HistoryWeek[];
}

export function readCachedHistory(): CachedHistory | undefined {
  const cached = scoreboardTabCache.get<CachedHistory>(SCOREBOARD_CACHE_KEYS.history);
  if (!cached || typeof cached !== 'object') return undefined;
  if (typeof cached.thisWeek !== 'string' || !Array.isArray(cached.sectionIds) || !Array.isArray(cached.weeks)) return undefined;
  return cached;
}

export function writeCachedHistory(history: CachedHistory): void {
  if (scoreboardTabCache.boundIdentity() === null) return;
  scoreboardTabCache.set(SCOREBOARD_CACHE_KEYS.history, history);
}
