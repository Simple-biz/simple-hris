import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fetchWithNetworkRetry, isNetworkFailure, NETWORK_RETRY_DELAYS_MS } from './fetch-network-retry';

const reset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
const noSleep = async () => {};

function scripted(steps: Array<'reset' | number>) {
  const calls: string[] = [];
  const base = async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init?.method ?? 'GET');
    const step = steps.shift();
    if (step === 'reset' || step === undefined) throw reset();
    return new Response('[]', { status: step });
  };
  return { base, calls };
}

test('a read that hits a connection reset is retried and then succeeds', async () => {
  const { base, calls } = scripted(['reset', 'reset', 200]);
  const res = await fetchWithNetworkRetry(base, NETWORK_RETRY_DELAYS_MS, noSleep)('https://x/rest/v1/hires');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
});

test('after the last retry the ORIGINAL error is thrown — a dead network still fails loud', async () => {
  const { base, calls } = scripted(['reset', 'reset', 'reset', 200]);
  await assert.rejects(
    fetchWithNetworkRetry(base, NETWORK_RETRY_DELAYS_MS, noSleep)('https://x/rest/v1/hires'),
    (e: unknown) => e instanceof TypeError && e.message === 'fetch failed',
  );
  assert.equal(calls.length, 1 + NETWORK_RETRY_DELAYS_MS.length);
});

test('an HTTP answer is NEVER retried — a 404 "no such table" or a 500 surfaces at once', async () => {
  for (const status of [404, 401, 500]) {
    const { base, calls } = scripted([status, 200]);
    const res = await fetchWithNetworkRetry(base, NETWORK_RETRY_DELAYS_MS, noSleep)('https://x/rest/v1/nope');
    assert.equal(res.status, status);
    assert.equal(calls.length, 1);
  }
});

test('a write is never replayed, even on a reset (it may have landed)', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const { base, calls } = scripted(['reset', 200]);
    await assert.rejects(fetchWithNetworkRetry(base, NETWORK_RETRY_DELAYS_MS, noSleep)('https://x', { method }));
    assert.equal(calls.length, 1);
  }
});

test('an aborted request is not retried', async () => {
  const ctl = new AbortController();
  ctl.abort();
  const { base, calls } = scripted(['reset', 200]);
  await assert.rejects(fetchWithNetworkRetry(base, NETWORK_RETRY_DELAYS_MS, noSleep)('https://x', { signal: ctl.signal }));
  assert.equal(calls.length, 1);
  assert.equal(isNetworkFailure(Object.assign(new Error('x'), { name: 'AbortError' })), false);
});

test('the pauses between tries are the documented ones', async () => {
  const waited: number[] = [];
  const { base } = scripted(['reset', 'reset', 200]);
  await fetchWithNetworkRetry(base, NETWORK_RETRY_DELAYS_MS, async (ms) => void waited.push(ms))('https://x');
  assert.deepEqual(waited, [...NETWORK_RETRY_DELAYS_MS]);
});
