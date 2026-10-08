/**
 * A `fetch` that retries a READ when the request never got an answer — the
 * connection was reset, timed out or dropped (`TypeError: fetch failed`, cause
 * ECONNRESET). Doc: docs/features/new-hire-source-sync.md § Reading the source.
 *
 * Measured 2026-10-08: the HRIS's dev machine saw intermittent ECONNRESET against
 * BOTH Supabase projects (ours and the hiring database) while 10/10 calls a minute
 * later succeeded; one reset failed a whole sync pass and turned the strip red.
 *
 * What it will NOT retry, on purpose, so a real failure still fails loud:
 *   • any HTTP response at all — a 404 "no such table", a 401, a 500 is an ANSWER
 *     (orphanage-oms-pull.md: a missing table must never read as "nothing there");
 *   • any method but GET / HEAD — a write that may have landed is never replayed;
 *   • an abort — the caller cancelled.
 * After the last attempt the original error is re-thrown unchanged.
 */

export const NETWORK_RETRY_DELAYS_MS = [400, 1200] as const;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const m = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : undefined) ?? 'GET';
  return m.toUpperCase();
}

/** A network-level failure: fetch threw before any response arrived. */
export function isNetworkFailure(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'AbortError') return false;
  if (e instanceof TypeError) return true; // undici: "fetch failed", cause ECONNRESET / ETIMEDOUT / …
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|UND_ERR_)/.test(code);
}

export function fetchWithNetworkRetry(
  base: FetchLike = fetch,
  delays: readonly number[] = NETWORK_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): FetchLike {
  return async (input, init) => {
    const method = methodOf(input, init);
    const retryable = method === 'GET' || method === 'HEAD';
    for (let attempt = 0; ; attempt++) {
      try {
        return await base(input, init);
      } catch (e) {
        if (!retryable || attempt >= delays.length || !isNetworkFailure(e) || init?.signal?.aborted) throw e;
        await sleep(delays[attempt]!);
      }
    }
  };
}
