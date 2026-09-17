import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPIRY_OPTIONS, describeExpiry, expiresAtFor, isExpired, parseExpiryOption } from './expiry';

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

test('the four ruled options and nothing else', () => {
  assert.deepEqual([...EXPIRY_OPTIONS], ['1d', '15d', '30d', 'never']);
  assert.equal(parseExpiryOption('15d'), '15d');
  assert.equal(parseExpiryOption('90d'), null);
  assert.equal(parseExpiryOption(15), null);
  assert.equal(parseExpiryOption(undefined), null);
});

test('expiresAtFor counts whole days from now; never is null', () => {
  assert.equal(expiresAtFor('never', NOW), null);
  assert.equal(expiresAtFor('1d', NOW), new Date(NOW + 86_400_000).toISOString());
  assert.equal(expiresAtFor('15d', NOW), new Date(NOW + 15 * 86_400_000).toISOString());
  assert.equal(expiresAtFor('30d', NOW), new Date(NOW + 30 * 86_400_000).toISOString());
});

test('isExpired: null never expires, past expires, the exact instant expires, garbage FAILS CLOSED', () => {
  assert.equal(isExpired(null, NOW), false);
  assert.equal(isExpired(undefined, NOW), false);
  assert.equal(isExpired(new Date(NOW + 1).toISOString(), NOW), false);
  assert.equal(isExpired(new Date(NOW).toISOString(), NOW), true);
  assert.equal(isExpired(new Date(NOW - 1).toISOString(), NOW), true);
  assert.equal(isExpired('not a date', NOW), true);
});

test('describeExpiry', () => {
  assert.equal(describeExpiry(null, NOW), 'never');
  assert.equal(describeExpiry(new Date(NOW - 5).toISOString(), NOW), 'expired');
  assert.equal(describeExpiry(new Date(NOW + 10 * 60_000).toISOString(), NOW), 'in 10m');
  assert.equal(describeExpiry(new Date(NOW + 5 * 3_600_000).toISOString(), NOW), 'in 5h');
  assert.equal(describeExpiry(new Date(NOW + 3 * 86_400_000).toISOString(), NOW), 'in 3d');
  assert.equal(describeExpiry('garbage', NOW), 'expired');
});
