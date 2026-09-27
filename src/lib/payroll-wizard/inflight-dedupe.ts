/**
 * Share ONE in-flight request between callers asking for the same key at the
 * same time — and nothing more.
 *
 * The Payroll Wizard reads the week in view from up to three places on the same
 * render wave (Step 1's preview, Step 2's calc load, Step 1's file table), each
 * a separate `GET /api/hubstaff-hours?source_file=` of the same ~800 KB. This
 * lets them share the network.
 *
 * It is deliberately NOT a cache. A key leaves the map the moment its request
 * settles, success or failure, so a caller arriving after that always starts a
 * fresh request: nothing here can hand out data older than a request that was
 * already running when the caller asked. Callers that need "fresh after a
 * write" fold a generation number into the key (the wizard bumps one every time
 * it reloads its upload list), so a request that started BEFORE a write is never
 * shared with a caller that asked after it.
 *
 * A shared request's value is handed to every caller as-is, so share immutable
 * values (the wizard shares response TEXT and each caller parses its own copy).
 */
export type InflightDedupe<T> = {
  run: (key: string, start: () => Promise<T>) => Promise<T>;
  /** Requests currently in flight — for tests and diagnostics. */
  size: () => number;
};

export function createInflightDedupe<T>(): InflightDedupe<T> {
  const inflight = new Map<string, Promise<T>>();
  return {
    run(key, start) {
      const running = inflight.get(key);
      if (running) return running;
      let started: Promise<T>;
      try {
        started = Promise.resolve(start());
      } catch (e) {
        started = Promise.reject(e);
      }
      const p: Promise<T> = started.finally(() => {
        if (inflight.get(key) === p) inflight.delete(key);
      });
      inflight.set(key, p);
      return p;
    },
    size: () => inflight.size,
  };
}
