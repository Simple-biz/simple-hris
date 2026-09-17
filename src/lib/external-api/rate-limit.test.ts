import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATE_LIMIT_CEILING,
  RATE_LIMIT_DEFAULT,
  RATE_LIMIT_FLOOR,
  SlidingWindowLimiter,
  clampRateLimit,
  decideFromWindow,
  parseRateLimit,
} from './rate-limit';

test('parseRateLimit: integers 1..600 only; strings of digits accepted; nothing is clamped', () => {
  assert.equal(parseRateLimit(60), 60);
  assert.equal(parseRateLimit('120'), 120);
  assert.equal(parseRateLimit(RATE_LIMIT_FLOOR), 1);
  assert.equal(parseRateLimit(RATE_LIMIT_CEILING), 600);
  assert.equal(parseRateLimit(0), null);
  assert.equal(parseRateLimit(601), null);
  assert.equal(parseRateLimit(59.5), null);
  assert.equal(parseRateLimit('60 per minute'), null);
  assert.equal(parseRateLimit(undefined), null);
  assert.equal(parseRateLimit(null), null);
});

test('clampRateLimit: a stored value outside the range is pulled back in; garbage becomes the default', () => {
  assert.equal(clampRateLimit(60), 60);
  assert.equal(clampRateLimit(0), 1);
  assert.equal(clampRateLimit(10_000), 600);
  assert.equal(clampRateLimit(NaN), RATE_LIMIT_DEFAULT);
  assert.equal(clampRateLimit('60'), RATE_LIMIT_DEFAULT);
});

test('decideFromWindow: allows below the limit, refuses at it, Retry-After counts down to the oldest call ageing out', () => {
  const now = 1_000_000;
  const ok = decideFromWindow({ limit: 3, countInWindow: 2, oldestInWindowMs: now - 50_000, nowMs: now });
  assert.deepEqual(ok, { allowed: true, remaining: 0, retryAfterSeconds: 0, limit: 3 });
  const no = decideFromWindow({ limit: 3, countInWindow: 3, oldestInWindowMs: now - 50_000, nowMs: now });
  assert.equal(no.allowed, false);
  assert.equal(no.remaining, 0);
  assert.equal(no.retryAfterSeconds, 10);
  const noOldest = decideFromWindow({ limit: 3, countInWindow: 3, oldestInWindowMs: null, nowMs: now });
  assert.equal(noOldest.retryAfterSeconds, 60, 'no oldest stamp ⇒ a full window, never 0');
  const stale = decideFromWindow({ limit: 1, countInWindow: 1, oldestInWindowMs: now - 61_000, nowMs: now });
  assert.equal(stale.retryAfterSeconds, 1, 'never below 1s');
});

test('decideFromWindow enforces the CLAMPED limit, so a corrupt row cannot open the door', () => {
  const d = decideFromWindow({ limit: 99_999, countInWindow: 600, oldestInWindowMs: null, nowMs: 0 });
  assert.equal(d.allowed, false);
  assert.equal(d.limit, RATE_LIMIT_CEILING);
});

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
