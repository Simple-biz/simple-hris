import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchCyclePaidDispatches } from './paid-dispatch-read';

/**
 * Pins the queue's "who is already paid" read (2026-10-08). The failure it
 * closes: a timed-out read answered `{ rows: [], error }` (or a cycle lookup
 * answered `cycleId: null`), the queue took that as "nobody paid", and paid
 * people were painted back into Pending, where they could be paid twice.
 */

type Reply = { status: number; body: unknown };

function fakeFetch(replies: Record<string, Reply>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(replies).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    const { status, body } = replies[key];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const PAID = [{ id: 'd1', recipient_email: 'emmanuelm@simple.biz', status: 'paid' }];

test('a clean read returns the paid rows for the cycle', async () => {
  const { fetchImpl, calls } = fakeFetch({
    '/api/current-cycle': { status: 200, body: { cycleId: 'c-1', error: null } },
    '/api/payment-dispatches': { status: 200, body: { rows: PAID, error: null } },
  });
  const rows = await fetchCyclePaidDispatches(fetchImpl, '');
  assert.deepEqual(rows, PAID);
  assert.equal(calls[1], '/api/payment-dispatches?cycle_id=c-1');
});

test('a successful "no cycle yet" is the only answer that means nobody is paid', async () => {
  const { fetchImpl, calls } = fakeFetch({
    '/api/current-cycle': { status: 200, body: { cycleId: null, error: null } },
  });
  assert.deepEqual(await fetchCyclePaidDispatches(fetchImpl, ''), []);
  assert.equal(calls.length, 1);
});

test('the dispatch list read failing throws instead of returning nobody paid', async () => {
  // The exact 2026-10-08 shape: a 500 carrying an AbortError from the DB timeout.
  const { fetchImpl } = fakeFetch({
    '/api/current-cycle': { status: 200, body: { cycleId: 'c-1', error: null } },
    '/api/payment-dispatches': {
      status: 500,
      body: { rows: [], error: 'AbortError: This operation was aborted' },
    },
  });
  await assert.rejects(fetchCyclePaidDispatches(fetchImpl, ''), /already paid.*AbortError/);
});

test('an error in the body throws even on HTTP 200 (the route before 2026-10-08)', async () => {
  const { fetchImpl } = fakeFetch({
    '/api/current-cycle': { status: 200, body: { cycleId: 'c-1', error: null } },
    '/api/payment-dispatches': { status: 200, body: { rows: [], error: 'timeout' } },
  });
  await assert.rejects(fetchCyclePaidDispatches(fetchImpl, ''), /timeout/);
});

test('a body with no rows array throws', async () => {
  const { fetchImpl } = fakeFetch({
    '/api/current-cycle': { status: 200, body: { cycleId: 'c-1', error: null } },
    '/api/payment-dispatches': { status: 200, body: { error: null } },
  });
  await assert.rejects(fetchCyclePaidDispatches(fetchImpl, ''));
});

test('a failed cycle lookup throws and never reads dispatches', async () => {
  const { fetchImpl, calls } = fakeFetch({
    '/api/current-cycle': { status: 500, body: { cycleId: null, error: 'Could not read the current cycle' } },
  });
  await assert.rejects(fetchCyclePaidDispatches(fetchImpl, ''), /cycle/);
  assert.equal(calls.length, 1);
});

test('a non-JSON gateway page (Vercel 504) throws', async () => {
  const { fetchImpl } = fakeFetch({
    '/api/current-cycle': { status: 504, body: '<html>An error occurred</html>' },
  });
  await assert.rejects(fetchCyclePaidDispatches(fetchImpl, ''), /HTTP 504/);
});

test('a picked past week passes its source_file to the cycle lookup', async () => {
  const { fetchImpl, calls } = fakeFetch({
    '/api/current-cycle': { status: 200, body: { cycleId: 'c-past', error: null } },
    '/api/payment-dispatches': { status: 200, body: { rows: [], error: null } },
  });
  await fetchCyclePaidDispatches(fetchImpl, '?source_file=week.csv');
  assert.equal(calls[0], '/api/current-cycle?source_file=week.csv');
});
