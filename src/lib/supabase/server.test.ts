import { test } from "node:test";
import assert from "node:assert/strict";
import { makeResilientFetch, type ResilientFetchOptions } from "./server";

// A deterministic clock shared by now() + sleepFn so tests run instantly:
// baseFetch is synchronous, and each backoff "sleep" simply advances the clock.
function harness(opts: ResilientFetchOptions = {}) {
  let clock = 0;
  const now = () => clock;
  const sleepFn = async (ms: number) => {
    clock += ms;
  };
  const make = (baseFetch: typeof fetch) => makeResilientFetch(baseFetch, { now, sleepFn, ...opts });
  return { make };
}

const resp = (status: number) => new Response(`body-${status}`, { status });

test("retries a transient 522 (Cloudflare origin timeout) then returns the eventual 200", async () => {
  let n = 0;
  const f = harness().make(async () => {
    n += 1;
    return resp(n < 2 ? 522 : 200);
  });
  const r = await f("https://x");
  assert.equal(r.status, 200);
  assert.equal(n, 2);
});

test("does NOT retry a 4xx application error", async () => {
  let n = 0;
  const f = harness().make(async () => {
    n += 1;
    return resp(400);
  });
  const r = await f("https://x");
  assert.equal(r.status, 400);
  assert.equal(n, 1);
});

test("does NOT retry a PostgREST 500 (real query error / statement timeout)", async () => {
  let n = 0;
  const f = harness().make(async () => {
    n += 1;
    return resp(500);
  });
  const r = await f("https://x");
  assert.equal(r.status, 500);
  assert.equal(n, 1);
});

test("retries a network rejection ('fetch failed') then succeeds", async () => {
  let n = 0;
  const f = harness().make(async () => {
    n += 1;
    if (n < 3) throw new TypeError("fetch failed");
    return resp(200);
  });
  const r = await f("https://x");
  assert.equal(r.status, 200);
  assert.equal(n, 3); // 1 initial + 2 retries
});

test("returns the LAST response (does not throw) after exhausting retries on persistent 503", async () => {
  let n = 0;
  const f = harness().make(async () => {
    n += 1;
    return resp(503);
  });
  const r = await f("https://x");
  assert.equal(r.status, 503);
  assert.equal(n, 3); // maxRetries default = 2 → 3 attempts
});

test("throws after exhausting retries on a persistent network error", async () => {
  let n = 0;
  const f = harness().make(async () => {
    n += 1;
    throw new TypeError("fetch failed");
  });
  await assert.rejects(() => f("https://x"), /fetch failed/);
  assert.equal(n, 3);
});

test("propagates a caller-initiated abort WITHOUT retrying", async () => {
  let n = 0;
  const f = harness().make(async () => {
    n += 1;
    throw new DOMException("Aborted", "AbortError");
  });
  await assert.rejects(() => f("https://x", { signal: AbortSignal.abort() }));
  assert.equal(n, 1);
});

test("stops retrying once the total deadline is exhausted", async () => {
  let n = 0;
  const f = harness({ totalDeadlineMs: 400 }).make(async () => {
    n += 1;
    return resp(503);
  });
  const r = await f("https://x");
  assert.equal(r.status, 503);
  // 400ms budget is consumed by backoff before all retries run → fewer than 3 attempts.
  assert.ok(n < 3, `expected fewer than 3 attempts under a 400ms deadline, got ${n}`);
});
