import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowLimiter } from './rate-limit';

test('allows up to max in a window, then refuses with a Retry-After that counts down', () => {
  let t = 1_000_000;
  const lim = new SlidingWindowLimiter(3, 60_000, () => t);
  assert.equal(lim.hit('a').allowed, true);
  assert.equal(lim.hit('a').allowed, true);
  const third = lim.hit('a');
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  const fourth = lim.hit('a');
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.retryAfterSeconds, 60);
  t += 30_000;
  assert.equal(lim.hit('a').retryAfterSeconds, 30);
  t += 30_001;
  assert.equal(lim.hit('a').allowed, true);
});

test('keys are independent', () => {
  const lim = new SlidingWindowLimiter(1, 60_000, () => 5);
  assert.equal(lim.hit('a').allowed, true);
  assert.equal(lim.hit('b').allowed, true);
  assert.equal(lim.hit('a').allowed, false);
});

test('a refused hit does not extend the window', () => {
  let t = 0;
  const lim = new SlidingWindowLimiter(1, 1_000, () => t);
  lim.hit('a');
  t = 500;
  assert.equal(lim.hit('a').allowed, false);
  t = 1_001;
  assert.equal(lim.hit('a').allowed, true, 'the refused hit at t=500 must not count');
});

test('sweep forgets idle keys', () => {
  let t = 0;
  const lim = new SlidingWindowLimiter(1, 1_000, () => t);
  lim.hit('a');
  t = 2_000;
  lim.sweep();
  assert.equal(lim.hit('a').remaining, 0);
  assert.equal(lim.hit('a').allowed, false);
});
