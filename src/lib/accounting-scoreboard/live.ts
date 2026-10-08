/**
 * The scoreboard's live channel (Kane, 2026-10-08: "Should use realtime feature of supabase", "onsnapshot
 * listener"). Browser-safe: the routes that change the board announce on it from the server
 * (`live-server.ts`), and every open board listens through `onScoreboardSnapshot` (`live-client.ts`).
 *
 * Supabase Realtime BROADCAST, never `postgres_changes`. Every scoreboard table is service-role only (RLS on,
 * no policies, anon refused 42501) and kept out of the `supabase_realtime` publication, so a row event can never
 * reach the browser's anon client (memory supabase-realtime-anon-rls-dead). The route that just wrote the row
 * announces it instead.
 *
 * The message is a RE-READ signal, never the values (the `kpi-live.ts` rule). The anon key ships in every page,
 * so anyone holding it can join this topic or post to it. Carla's numbers, business names and amounts would be
 * published past the member list, and a forged message could paint a number. So a listener always pulls the
 * snapshot from the member-gated GET: a forged or flooded message costs at most one re-read per
 * `LIVE_MIN_GAP_MS`, and can never paint anything.
 *
 * OWN topic: realtime-js keeps one channel per topic per client, so sharing one with another feature lets
 * either side's teardown kill the other's (`live.test.ts` pins it against every topic in the app).
 */

export const SCOREBOARD_LIVE_TOPIC = 'accounting-scoreboard-sync';
export const SCOREBOARD_LIVE_EVENT = 'changed';

/** The request header that names the browser tab a write came from, so that tab skips its own echo. */
export const SCOREBOARD_TAB_HEADER = 'x-acct-sb-tab';

/** What changed. Informational: every kind re-reads the whole board, because all-time numbers (the record,
 *  All Time, the No Meeting Streak) move with a change to any week. */
export const LIVE_KINDS = ['cells', 'collections', 'verified', 'problems', 'setup', 'members', 'roles'] as const;
export type ScoreboardLiveKind = (typeof LIVE_KINDS)[number];

export interface ScoreboardLivePayload {
  kind: ScoreboardLiveKind;
  /** The writer's tab id (`SCOREBOARD_TAB_HEADER`), or null when the write named none. */
  origin: string | null;
  ts: number;
}

const TAB_ID = /^[A-Za-z0-9-]{8,64}$/;

/** A tab id from a request header: anything that is not a plain id is dropped, never echoed. */
export function parseTabId(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && TAB_ID.test(raw) ? raw : null;
}

/**
 * Parse a received payload. Anything malformed becomes `null`: still a "something changed, re-read" signal,
 * never a reason to drop the refresh (a lost refresh is the staleness this channel exists to remove).
 */
export function parseScoreboardLivePayload(raw: unknown): ScoreboardLivePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const kind = (LIVE_KINDS as readonly unknown[]).includes(p.kind) ? (p.kind as ScoreboardLiveKind) : null;
  if (!kind) return null;
  const origin = parseTabId(typeof p.origin === 'string' ? p.origin : null);
  const ts = typeof p.ts === 'number' && Number.isFinite(p.ts) ? p.ts : Date.now();
  return { kind, origin, ts };
}

/** A message this tab sent itself: its own write already painted locally (or re-read on its own). A message
 *  with no readable origin is never treated as ours. */
export function isOwnEcho(payload: ScoreboardLivePayload | null, tabId: string): boolean {
  return payload !== null && payload.origin !== null && payload.origin === tabId;
}

/** Coalesce a burst (someone tabbing through a row of cells) into one re-read. */
export const LIVE_DEBOUNCE_MS = 500;
/** At most one live re-read per tab per this long, however many messages arrive: the flood bound. A board read
 *  took ~1.4 s on production (2026-10-06), so this also keeps one read from stacking on the next. */
export const LIVE_MIN_GAP_MS = 3_000;
/** Each tab waits a random 0..N ms more, so one save does not hit the server with every open board at once. */
export const LIVE_SPREAD_MS = 1_000;
/** While a re-read must wait (a cell is being edited, a foreground load is running, the tab is hidden), look
 *  again this often. No network: it only checks local state. */
export const LIVE_BLOCKED_RETRY_MS = 1_000;

export interface LiveSchedulerDeps {
  /** The background re-read. */
  run: () => void;
  /** True while a re-read must wait. */
  blocked: () => boolean;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** 0..1, for the spread. */
  random: () => number;
}

export interface LiveScheduler {
  /** A change landed somewhere (or the channel came back and may have missed one). */
  signal: () => void;
  dispose: () => void;
}

/**
 * Turns messages into background re-reads:
 * - a burst becomes ONE re-read (the timer is armed once and never pushed back, so a steady flood cannot
 *   starve it either);
 * - re-reads are at least `LIVE_MIN_GAP_MS` apart;
 * - a re-read never runs while `blocked()`: it stays pending and runs once the block clears, so a change that
 *   arrived mid-edit is applied after the edit instead of waiting for the 45 s tick.
 */
export function createLiveScheduler(deps: LiveSchedulerDeps): LiveScheduler {
  let pending = false;
  let timer: unknown = null;
  let lastRun = -Infinity;
  let disposed = false;

  const arm = (ms: number) => {
    timer = deps.setTimer(fire, Math.max(0, ms));
  };

  function fire() {
    timer = null;
    if (disposed || !pending) return;
    const wait = lastRun + LIVE_MIN_GAP_MS - deps.now();
    if (wait > 0) {
      arm(wait);
      return;
    }
    if (deps.blocked()) {
      arm(LIVE_BLOCKED_RETRY_MS);
      return;
    }
    pending = false;
    lastRun = deps.now();
    deps.run();
  }

  return {
    signal() {
      if (disposed) return;
      pending = true;
      if (timer !== null) return;
      const gap = lastRun + LIVE_MIN_GAP_MS - deps.now();
      arm(Math.max(LIVE_DEBOUNCE_MS, gap) + Math.floor(deps.random() * LIVE_SPREAD_MS));
    },
    dispose() {
      disposed = true;
      pending = false;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    },
  };
}
