/**
 * Short-lived, per-process memo for whole-company engine runs
 * (`computeCurrentPay({ sourceFile })`) on the employee paystub route.
 *
 * The engine prices EVERY employee for a week (~6.6 s, ~740 people); the result
 * is identical for every viewer. Without this, each employee who opens Pay Stubs
 * while a week has no snapshot pays the full run themselves.
 *
 * Bounds, on purpose:
 * - **Keyed by (source file, Hubstaff upload batch id).** A re-upload mints a
 *   new batch id, so a stale batch can never be served. Unknown batch ⇒ no key
 *   ⇒ no memo (caller computes directly).
 * - **Five-minute TTL.** A week with no snapshot is one the wizard has not yet
 *   published; once it does, the route prefers the snapshot and this memo is
 *   never consulted for that week again. Five minutes bounds how long a
 *   rates/hours edit can lag for a viewer of an UNpublished week.
 * - **Failures are not memoized.** A rejected run is evicted so the next caller
 *   retries instead of inheriting the error.
 * - **Only engine-derived weeks.** Staged payloads and wizard snapshots are never
 *   memoized here — they carry money that a re-lock can change.
 */

export const ENGINE_WEEK_MEMO_TTL_MS = 5 * 60 * 1000;

export interface EngineWeekMemo<T> {
  /** Return the memoized value for `key`, or run `compute` and memoize it. */
  get(key: string, compute: () => Promise<T>): Promise<T>;
  /** Live (unexpired) entry count — for tests and diagnostics. */
  size(): number;
  clear(): void;
}

export function engineWeekMemoKey(sourceFile: string, uploadId: string | null): string | null {
  const f = sourceFile.trim();
  const u = (uploadId ?? "").trim();
  if (!f || !u) return null;
  return `${f}::${u}`;
}

export function createEngineWeekMemo<T>(opts?: {
  ttlMs?: number;
  now?: () => number;
}): EngineWeekMemo<T> {
  const ttl = opts?.ttlMs ?? ENGINE_WEEK_MEMO_TTL_MS;
  const now = opts?.now ?? (() => Date.now());
  const entries = new Map<string, { at: number; promise: Promise<T> }>();

  const isLive = (e: { at: number }) => now() - e.at < ttl;

  return {
    get(key, compute) {
      const existing = entries.get(key);
      if (existing && isLive(existing)) return existing.promise;
      const promise = compute();
      const entry = { at: now(), promise };
      entries.set(key, entry);
      promise.catch(() => {
        // Only evict OUR entry — a newer one may have replaced it meanwhile.
        if (entries.get(key) === entry) entries.delete(key);
      });
      return promise;
    },
    size() {
      let n = 0;
      for (const e of entries.values()) if (isLive(e)) n += 1;
      return n;
    },
    clear() {
      entries.clear();
    },
  };
}
