/**
 * The Overview's database signal (Kane, 2026-10-09: *"a 3 bar signal and an MS on our DATABASE connection 3rd bar in
 * green should be blinking"*, then *"1 bar being red and 2 bar being orange"*). Pure, so the route and the bars read
 * one table.
 *
 * The ms is the SERVER's round trip to the database for one tiny read (`pingDatabase` in server.ts), never the
 * browser's: Vercel and someone's internet are not the database. The lines are Admin → Diagnostics' own for the same
 * kind of read (system-diagnostics.md, `supabase-client`: under 500 ms healthy, 500–2000 ms warning, error / timeout
 * critical; `supabase-postgres` calls reads over 2 s overloaded), so the two screens never disagree about the same
 * database.
 *
 * Governing doc: docs/features/accounting-scoreboard.md § Database signal.
 */

/** Under this, 3 green bars (the 3rd blinks). */
export const DB_SIGNAL_GOOD_MS = 500;
/** Up to this, 2 orange bars; over it, 1 red bar. */
export const DB_SIGNAL_SLOW_MS = 2000;
/** The server stops waiting for the database here and says so (Diagnostics' 3 s per reading). */
export const DB_PING_TIMEOUT_MS = 3000;
/** How often an open Overview pings, while the browser tab is visible (Diagnostics' live feed is 30 s). */
export const DB_PING_EVERY_MS = 30_000;

/** What GET /api/accounting-scoreboard/ping answers. */
export type DbPing =
  | { ok: true; ms: number; checkedAt: string }
  | { ok: false; timedOut: boolean; ms: number; checkedAt: string };

export type DbTone = 'green' | 'orange' | 'red';

export interface DbSignal {
  bars: 1 | 2 | 3;
  tone: DbTone;
  /** The short word beside the bars. */
  word: string;
  /** The ms to print, or null when there is no reading worth printing. */
  ms: number | null;
  /** The full sentence, for the tooltip and screen readers. */
  sentence: string;
}

export function judgeDbPing(ping: DbPing): DbSignal {
  if (!ping.ok) {
    return ping.timedOut
      ? {
          bars: 1,
          tone: 'red',
          word: 'Not answering',
          ms: null,
          sentence: `The database did not answer within ${DB_PING_TIMEOUT_MS / 1000} seconds.`,
        }
      : { bars: 1, tone: 'red', word: 'Unreachable', ms: null, sentence: 'The database could not be reached.' };
  }
  const ms = Math.max(0, Math.round(ping.ms));
  if (ms < DB_SIGNAL_GOOD_MS) {
    return { bars: 3, tone: 'green', word: 'Good', ms, sentence: `The database answered in ${ms} ms. Connection is good.` };
  }
  if (ms <= DB_SIGNAL_SLOW_MS) {
    return { bars: 2, tone: 'orange', word: 'Slow', ms, sentence: `The database answered in ${ms} ms. It is slower than usual.` };
  }
  return { bars: 1, tone: 'red', word: 'Very slow', ms, sentence: `The database took ${ms} ms to answer. It may be overloaded.` };
}

/** The route answered with something other than a ping (signed out, refused, a crash): one red bar, said plainly. */
export function signalForFailedRoute(status: number): DbSignal {
  return {
    bars: 1,
    tone: 'red',
    word: 'Unreachable',
    ms: null,
    sentence:
      status === 0
        ? 'Could not reach the server to check the database.'
        : `The server could not check the database (HTTP ${status}).`,
  };
}
