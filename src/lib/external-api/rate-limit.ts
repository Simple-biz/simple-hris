/**
 * Per-client sliding-window rate limit for /api/external/v1/*.
 *
 * 60 requests per minute per client (Kane, 2026-09-16: "an optimal rate limit").
 * A full active-roster pull is 8 calls at the 500-row cap, so a well-behaved
 * mirror never comes near it; a runaway loop in the caller's system does, and
 * gets a `429` with `Retry-After` instead of hammering Supabase.
 *
 * In-memory, per server instance — the same shape as the onboarding / bank /
 * gift limiters in `proxy.ts`. On a multi-instance deploy each instance counts
 * separately, so the effective ceiling is N × 60. That is documented as
 * best-effort abuse prevention, not a billing meter.
 */

export const RATE_LIMIT_MAX = 60;
export const RATE_LIMIT_WINDOW_MS = 60_000;

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
