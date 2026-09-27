import test from 'node:test';
import assert from 'node:assert/strict';
import { createInflightDedupe } from './inflight-dedupe';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('concurrent callers for the same key share one request', async () => {
  const d = createInflightDedupe<string>();
  let started = 0;
  const gate = deferred<string>();
  const start = () => { started++; return gate.promise; };
  const a = d.run('k', start);
  const b = d.run('k', start);
  assert.equal(started, 1);
  gate.resolve('body');
  assert.deepEqual(await Promise.all([a, b]), ['body', 'body']);
});

test('it is NOT a cache: a caller after the request settled starts a fresh one', async () => {
  const d = createInflightDedupe<number>();
  let n = 0;
  assert.equal(await d.run('k', async () => ++n), 1);
  assert.equal(await d.run('k', async () => ++n), 2);
  assert.equal(d.size(), 0);
});

test('a failure is shared by the callers already waiting, then forgotten', async () => {
  const d = createInflightDedupe<string>();
  const gate = deferred<string>();
  const a = d.run('k', () => gate.promise);
  const b = d.run('k', () => gate.promise);
  gate.reject(new Error('network'));
  await assert.rejects(a, /network/);
  await assert.rejects(b, /network/);
  assert.equal(d.size(), 0);
  assert.equal(await d.run('k', async () => 'retry'), 'retry');
});

test('different keys never share — the wizard folds a generation into the key after every write', async () => {
  const d = createInflightDedupe<string>();
  const before = deferred<string>();
  const beforeWrite = d.run('0\u0000week.csv', () => before.promise);
  const afterWrite = d.run('1\u0000week.csv', async () => 'fresh');
  assert.equal(await afterWrite, 'fresh');
  before.resolve('stale');
  assert.equal(await beforeWrite, 'stale');
});

test('a start() that throws synchronously rejects instead of escaping, and is not retained', async () => {
  const d = createInflightDedupe<string>();
  await assert.rejects(d.run('k', () => { throw new Error('sync'); }), /sync/);
  assert.equal(d.size(), 0);
});
