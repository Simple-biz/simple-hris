import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bearerToken,
  constantTimeEqualHex,
  generateApiKey,
  hashApiKey,
  keyPrefix,
  KEY_PREFIX_LENGTH,
  looksLikeApiKey,
  readPepper,
} from './keys';

test('generateApiKey issues the documented shape and never repeats', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const k = generateApiKey();
    assert.ok(looksLikeApiKey(k), `shape: ${k}`);
    assert.ok(k.startsWith('hris_live_'));
    assert.equal(k.length, 'hris_live_'.length + 43);
    assert.ok(!seen.has(k));
    seen.add(k);
  }
});

test('looksLikeApiKey rejects everything that is not exactly our shape', () => {
  for (const bad of [
    '',
    'hris_live_',
    'hris_live_short',
    'sk-ant-' + 'a'.repeat(43),
    'hris_prod_' + 'a'.repeat(43),
    'hris_live_' + 'a'.repeat(42),
    'hris_live_' + 'a'.repeat(44),
    'hris_live_' + 'a'.repeat(42) + '!',
    ' ' + generateApiKey(),
  ]) {
    assert.equal(looksLikeApiKey(bad), false, bad);
  }
});

test('keyPrefix is 16 chars and is NOT enough to rebuild the key', () => {
  const k = generateApiKey();
  const p = keyPrefix(k);
  assert.equal(p.length, KEY_PREFIX_LENGTH);
  assert.equal(p, k.slice(0, 16));
  assert.equal(looksLikeApiKey(p), false);
});

test('hashApiKey is 64 hex, deterministic, and pepper-dependent', () => {
  const k = generateApiKey();
  const h1 = hashApiKey(k, 'pepper-a');
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(hashApiKey(k, 'pepper-a'), h1);
  assert.notEqual(hashApiKey(k, 'pepper-b'), h1);
  assert.notEqual(hashApiKey(generateApiKey(), 'pepper-a'), h1);
});

test('constantTimeEqualHex compares equal hashes and refuses unequal or malformed ones', () => {
  const h = hashApiKey('x', 'p');
  assert.equal(constantTimeEqualHex(h, h), true);
  assert.equal(constantTimeEqualHex(h, hashApiKey('y', 'p')), false);
  assert.equal(constantTimeEqualHex(h, h.slice(0, 62)), false);
  assert.equal(constantTimeEqualHex('', ''), false);
});

test('readPepper prefers the dedicated variable, falls back to NEXTAUTH_SECRET, and FAILS CLOSED', () => {
  assert.deepEqual(readPepper({ EXTERNAL_API_KEY_PEPPER: ' ded ', NEXTAUTH_SECRET: 'na' }), { ok: true, pepper: 'ded' });
  assert.deepEqual(readPepper({ NEXTAUTH_SECRET: 'na' }), { ok: true, pepper: 'na' });
  assert.deepEqual(readPepper({ EXTERNAL_API_KEY_PEPPER: '   ', NEXTAUTH_SECRET: '' }), { ok: false, reason: 'unconfigured' });
  assert.deepEqual(readPepper({}), { ok: false, reason: 'unconfigured' });
});

test('bearerToken parses only a well-formed Bearer header', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('bearer abc'), 'abc');
  assert.equal(bearerToken('Bearer   abc  '), 'abc');
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(bearerToken('Bearer'), null);
  assert.equal(bearerToken('Bearer a b'), null);
  assert.equal(bearerToken(''), null);
  assert.equal(bearerToken(null), null);
  assert.equal(bearerToken(undefined), null);
});
