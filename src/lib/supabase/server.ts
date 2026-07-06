import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Transient-failure hardening for ALL server-side Supabase calls.
//
// supabase-js talks to PostgREST / GoTrue / Storage over HTTPS. During a
// Supabase platform blip (Cloudflare 522 "connection timed out", gateway 5xx,
// dropped connections — e.g. the 2026-07-06 compute-capacity incident) a bare
// fetch either hangs until the serverless function is killed or surfaces a hard
// 500 to the UI. We inject a fetch wrapper that:
//   (1) bounds each request with an AbortController timeout, so a hung origin
//       fails fast instead of hanging the function; and
//   (2) retries a couple of times on transient network / gateway failures,
//       within a hard total deadline.
// It deliberately does NOT retry 4xx or a PostgREST 500 — those signal a real
// query error / statement timeout, and retrying would only pile load onto an
// already-struggling database. Tune via env without a code change.
// ---------------------------------------------------------------------------

const num = (v: string | undefined, dflt: number): number => {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// Defaults keep the worst case under ~9s so we stay within typical Vercel
// function limits. Lower SUPABASE_FETCH_TIMEOUT_MS / _DEADLINE_MS on Hobby (10s).
const PER_ATTEMPT_TIMEOUT_MS = num(process.env.SUPABASE_FETCH_TIMEOUT_MS, 7000);
const MAX_RETRIES = num(process.env.SUPABASE_FETCH_RETRIES, 2);
const TOTAL_DEADLINE_MS = num(process.env.SUPABASE_FETCH_DEADLINE_MS, 9000);

// Transient availability signals worth a quick retry: rate limiting + gateway /
// origin errors, including Cloudflare's 52x family (522 = "connection timed out",
// the exact signature of the 2026-07-06 incident). NOT 500/4xx — see note above.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Exponential backoff with jitter, capped at 1s: ~150ms, ~300ms, ~600ms, ...
const backoffMs = (attempt: number): number =>
  Math.min(1000, 150 * 2 ** attempt) + Math.floor(Math.random() * 100);

export interface ResilientFetchOptions {
  perAttemptTimeoutMs?: number;
  maxRetries?: number;
  totalDeadlineMs?: number;
  retryableStatus?: Set<number>;
  /** Injectable clock (ms since epoch). Defaults to Date.now — override in tests. */
  now?: () => number;
  /** Injectable delay. Defaults to a real setTimeout sleep — override in tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Wrap a fetch implementation with per-attempt abort timeouts + bounded retries
 * on transient network / gateway failures, within a hard total deadline. See the
 * file header for the policy. Returns the last response (or rethrows the last
 * error) once retries or the deadline are exhausted. Exported for unit testing;
 * production uses the `resilientFetch` instance below.
 */
export function makeResilientFetch(
  baseFetch: typeof fetch,
  opts: ResilientFetchOptions = {},
): typeof fetch {
  const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? PER_ATTEMPT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const totalDeadlineMs = opts.totalDeadlineMs ?? TOTAL_DEADLINE_MS;
  const retryableStatus = opts.retryableStatus ?? RETRYABLE_STATUS;
  const now = opts.now ?? Date.now;
  const sleepFn = opts.sleepFn ?? defaultSleep;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const start = now();
    const timeLeft = () => totalDeadlineMs - (now() - start);
    let lastErr: unknown;
    let lastRes: Response | undefined;

    for (let attempt = 0; ; attempt++) {
      const remaining = timeLeft();
      if (remaining <= 0) break;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(perAttemptTimeoutMs, remaining));
      // Compose with any signal supabase-js passed so a genuine caller-cancel still aborts.
      const incoming = init?.signal ?? undefined;
      const onIncomingAbort = () => controller.abort();
      if (incoming) {
        if (incoming.aborted) controller.abort();
        else incoming.addEventListener("abort", onIncomingAbort, { once: true });
      }

      try {
        const res = await baseFetch(input, { ...init, signal: controller.signal });
        const canRetry = attempt < maxRetries && retryableStatus.has(res.status);
        if (canRetry && timeLeft() > 250) {
          lastRes = res; // left unconsumed so it stays readable if it becomes the fallback
          await sleepFn(backoffMs(attempt));
          continue;
        }
        return res;
      } catch (err) {
        // A caller-initiated cancel (not our timeout) must propagate, never retry.
        if (incoming?.aborted) throw err;
        lastErr = err;
        if (attempt < maxRetries && timeLeft() > 250) {
          await sleepFn(backoffMs(attempt));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        if (incoming) incoming.removeEventListener("abort", onIncomingAbort);
      }
    }

    if (lastRes) return lastRes;
    throw lastErr ?? new Error("Supabase request failed (deadline exceeded)");
  };
}

// fetch wrapper injected into every server-side Supabase client.
const resilientFetch: typeof fetch = makeResilientFetch(fetch);

export function createSupabaseServerClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { global: { fetch: resilientFetch } });
}

/** Service role — bypasses RLS. Server-only; never expose the key to the client. */
export function createSupabaseServiceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: resilientFetch },
  });
}
