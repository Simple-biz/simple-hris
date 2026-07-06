import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initResourceState, resourceReducer, type ResourceState } from './useResilientResource';

// The hook itself needs a React renderer to test; the VALUE lives in the pure
// reducer + init, which we exercise directly here.

test('cold init (no seed) → loading, no data, no timestamp', () => {
  const s = initResourceState<number>(undefined, 1000);
  assert.deepEqual(s, { data: undefined, status: 'loading', error: null, lastUpdatedAt: null });
});

test('seeded init → ready, data present, timestamp stamped', () => {
  const s = initResourceState<number>(42, 1000);
  assert.deepEqual(s, { data: 42, status: 'ready', error: null, lastUpdatedAt: 1000 });
});

test("'start' on a cold state shows the skeleton", () => {
  const cold: ResourceState<number> = { data: undefined, status: 'error', error: 'x', lastUpdatedAt: null };
  assert.equal(resourceReducer(cold, { type: 'start' }).status, 'loading');
});

test("'start' with existing data does NOT flash back to skeleton", () => {
  const warm: ResourceState<number> = { data: 7, status: 'ready', error: null, lastUpdatedAt: 1000 };
  const next = resourceReducer(warm, { type: 'start' });
  assert.equal(next.status, 'ready'); // unchanged — background refresh
  assert.equal(next.data, 7);
});

test("'success' sets data, ready, clears error, stamps time", () => {
  const prev: ResourceState<number> = { data: undefined, status: 'loading', error: 'boom', lastUpdatedAt: null };
  const next = resourceReducer(prev, { type: 'success', data: 99, at: 5000 });
  assert.deepEqual(next, { data: 99, status: 'ready', error: null, lastUpdatedAt: 5000 });
});

test("'failure' on a COLD state → error, data stays undefined", () => {
  const cold: ResourceState<number> = { data: undefined, status: 'loading', error: null, lastUpdatedAt: null };
  const next = resourceReducer(cold, { type: 'failure', error: 'supabase down' });
  assert.equal(next.status, 'error');
  assert.equal(next.data, undefined);
  assert.equal(next.error, 'supabase down');
});

test("'failure' WITH prior data → stale, data + timestamp preserved (UI stays usable)", () => {
  const warm: ResourceState<number> = { data: 123, status: 'ready', error: null, lastUpdatedAt: 5000 };
  const next = resourceReducer(warm, { type: 'failure', error: 'supabase down' });
  assert.equal(next.status, 'stale');
  assert.equal(next.data, 123); // kept — NOT wiped
  assert.equal(next.lastUpdatedAt, 5000); // last good time preserved
  assert.equal(next.error, 'supabase down');
});

test('retry after a cold failure shows the skeleton again', () => {
  let s = initResourceState<number>(undefined, 0);
  s = resourceReducer(s, { type: 'start' }); // loading
  s = resourceReducer(s, { type: 'failure', error: 'down' }); // error (no data)
  s = resourceReducer(s, { type: 'start' }); // retry
  assert.equal(s.status, 'loading');
});

test('recovery: stale → success clears the stale flag and refreshes data', () => {
  let s: ResourceState<number> = { data: 1, status: 'stale', error: 'down', lastUpdatedAt: 100 };
  s = resourceReducer(s, { type: 'start' }); // has data → stays stale, no skeleton
  assert.equal(s.status, 'stale');
  s = resourceReducer(s, { type: 'success', data: 2, at: 200 });
  assert.deepEqual(s, { data: 2, status: 'ready', error: null, lastUpdatedAt: 200 });
});
