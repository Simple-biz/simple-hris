import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideSync, signatureOf, signatureOfRows } from './dispatch-sync-decision';

/**
 * Pins when an open Payment Dispatch screen re-runs its full queue load
 * (2026-10-08). Before that day every screen ran it twice per payment and hidden
 * tabs ran it too, and the database reached load average 43 with three to five
 * clerks paying.
 */

const A = signatureOf(900, '2026-10-08T17:07:50.635372+00:00');
const B = signatureOf(901, '2026-10-08T17:07:57.538387+00:00');

test('the signature of loaded rows equals the live signature for the same rows', () => {
  const rows = [
    { created_at: '2026-10-08T16:47:52.798905+00:00' },
    { created_at: '2026-10-08T17:07:57.538387+00:00' },
    { created_at: '2026-10-08T17:07:50.635372+00:00' },
  ];
  assert.equal(signatureOfRows(rows), signatureOf(3, '2026-10-08T17:07:57.538387+00:00'));
});

test('Postgres trimming trailing zeros does not make two equal timestamps differ', () => {
  assert.equal(signatureOf(1, '2026-10-08T17:07:57.5+00:00'), signatureOf(1, '2026-10-08T17:07:57.500000+00:00'));
});

test('an empty cycle has a stable signature', () => {
  assert.equal(signatureOfRows([]), signatureOf(0, null));
});

test('a delete moves the count, an insert moves the newest timestamp', () => {
  assert.notEqual(signatureOf(900, '2026-10-08T17:07:50Z'), signatureOf(899, '2026-10-08T17:07:50Z'));
  assert.notEqual(signatureOf(900, '2026-10-08T17:07:50Z'), signatureOf(900, '2026-10-08T17:07:51Z'));
});

// ── broadcast ────────────────────────────────────────────────────────────────

test('broadcast: the payer hearing the echo of a write its screen already loaded does not reload', () => {
  assert.equal(decideSync({ trigger: 'broadcast', live: B, loaded: B, tried: null }), 'skip');
});

test('broadcast: a remote payment this screen has not loaded reloads', () => {
  assert.equal(decideSync({ trigger: 'broadcast', live: B, loaded: A, tried: null }), 'reload');
});

test('broadcast: an unreadable signature still reloads (as every broadcast did before)', () => {
  assert.equal(decideSync({ trigger: 'broadcast', live: null, loaded: A, tried: null }), 'reload');
});

test('broadcast: nothing loaded yet still reloads', () => {
  assert.equal(decideSync({ trigger: 'broadcast', live: B, loaded: null, tried: null }), 'reload');
});

test('broadcast: a change already tried and not applied is retried', () => {
  assert.equal(decideSync({ trigger: 'broadcast', live: B, loaded: A, tried: B }), 'reload');
});

// ── poll ─────────────────────────────────────────────────────────────────────

test('poll: after a broadcast reload applied, the poll does not reload the same change again', () => {
  // The 2026-10-08 double: the old poll compared against its own last reading.
  assert.equal(decideSync({ trigger: 'poll', live: B, loaded: B, tried: null }), 'skip');
});

test('poll: a change no broadcast delivered reloads', () => {
  assert.equal(decideSync({ trigger: 'poll', live: B, loaded: A, tried: null }), 'reload');
});

test('poll: a change whose reload failed is not retried every 15 s', () => {
  assert.equal(decideSync({ trigger: 'poll', live: B, loaded: A, tried: B }), 'skip');
});

test('poll: an unreadable signature is skipped', () => {
  assert.equal(decideSync({ trigger: 'poll', live: null, loaded: A, tried: null }), 'skip');
});

test('poll: nothing loaded and nothing tried takes a baseline, then reloads on the next change', () => {
  assert.equal(decideSync({ trigger: 'poll', live: A, loaded: null, tried: null }), 'baseline');
  assert.equal(decideSync({ trigger: 'poll', live: A, loaded: null, tried: A }), 'skip');
  assert.equal(decideSync({ trigger: 'poll', live: B, loaded: null, tried: A }), 'reload');
});
