/**
 * Per-client rate limit for /api/external/v1/* and /api/external/mcp.
 *
 * 2026-09-17 (Kane: "we should have rate limiting practices on this"): the limit is
 * PER CLIENT, set by the admin (default 60/min, 1..600), and ONE budget covers REST
 * and MCP together. The route counts the client's rows in `external_api_requests`
 * over the last 60 s (rows with status ≠ 429 — a refused call does not extend the
 * window, same as the in-memory limiter below) and decides with `decideFromWindow`,
 * so the number on the admin's screen IS the number enforced, on every server
 * instance. If that count cannot be read the call is REFUSED (503), never allowed.
 *
 * `SlidingWindowLimiter` (in-memory, per instance) is kept as the shape the
 * `proxy.ts` limiters share and for tests; the external routes no longer use it.
 *
 * A full active-roster pull is 8 calls at the 500-row cap, so a well-behaved mirror
 * never comes near 60; a runaway loop in the caller's system does, and gets a `429`
 * with `Retry-After` instead of hammering Supabase.
 */

export const RATE_LIMIT_DEFAULT = 60;
export const RATE_LIMIT_FLOOR = 1;
export const RATE_LIMIT_CEILING = 600;
/** @deprecated the default; the enforced value is the client row's `rate_limit_per_minute`. */
export const RATE_LIMIT_MAX = RATE_LIMIT_DEFAULT;
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** A limit an admin typed: an integer within 1..600, else null (the route answers 400, it does not clamp). */
export function parseRateLimit(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  if (n < RATE_LIMIT_FLOOR || n > RATE_LIMIT_CEILING) return null;
  return n;
}

/** A limit read back from a row: never trust it to be in range (the CHECK could be dropped). */
export function clampRateLimit(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return RATE_LIMIT_DEFAULT;
  return Math.min(RATE_LIMIT_CEILING, Math.max(RATE_LIMIT_FLOOR, Math.floor(n)));
}

/**
 * The DB-counted decision. `countInWindow` = this client's accepted calls in the
 * last `windowMs` BEFORE this one; `oldestInWindowMs` = when the oldest of them
 * happened (null when there are none). Retry-After counts down to the moment
 * that oldest call ages out — the earliest the next call could be accepted.
 */
export function decideFromWindow(args: {
  limit: number;
  countInWindow: number;
  oldestInWindowMs: number | null;
  nowMs: number;
  windowMs?: number;
}): RateDecision {
  const windowMs = args.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const limit = clampRateLimit(args.limit);
  if (args.countInWindow >= limit) {
    const until = args.oldestInWindowMs == null ? windowMs : args.oldestInWindowMs + windowMs - args.nowMs;
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(until / 1000)), limit };
  }
  return { allowed: true, remaining: limit - args.countInWindow - 1, retryAfterSeconds: 0, limit };
}

export type RateDecision = {
  allowed: boolean;
  /** Requests left in the current window after this one. */
  remaining: number;
  /** Seconds until the oldest request in the window ages out. 0 when allowed. */
  retryAfterSeconds: number;
  limit: number;
};

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max = RATE_LIMIT_MAX,
    private readonly windowMs = RATE_LIMIT_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  hit(key: string): RateDecision {
    const t = this.now();
    const floor = t - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((ts) => ts > floor);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      const oldest = list[0];
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - t) / 1000)),
        limit: this.max,
      };
    }
    list.push(t);
    this.hits.set(key, list);
    return { allowed: true, remaining: this.max - list.length, retryAfterSeconds: 0, limit: this.max };
  }

  /** Drop keys with no hits in the window — called opportunistically so the map cannot grow without bound. */
  sweep(): void {
    const floor = this.now() - this.windowMs;
    for (const [k, list] of this.hits) {
      if (!list.some((ts) => ts > floor)) this.hits.delete(k);
    }
  }
}
