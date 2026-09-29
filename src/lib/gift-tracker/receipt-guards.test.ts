/**
 * Who may change a tenure-gift record, and which way it may move.
 *
 * Carla, 2026-09-29: "if 'received' 'Not yet' should disappear. 'clear' can
 * stay" and "you can just undo yourself every month and get a new shirt". Each
 * block below pins one of the failure classes that closed.
 *
 * Run:  npx tsx --test src/lib/gift-tracker/receipt-guards.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideReceiptWrite,
  isOwnGiftRecord,
  MIN_WITHDRAW_REASON,
  readWithdrawReason,
  receiptActionsFor,
} from './receipt-guards';

// --- Class 1: received is not flipped to owed in one click ------------------

test('a received gift offers ONLY Clear — Not yet is gone, and so is Received', () => {
  assert.deepEqual(receiptActionsFor('received'), { received: false, notYet: false, clear: true });
});

test('an owed gift offers Received (the fulfilment path) and Clear, never Not yet again', () => {
  assert.deepEqual(receiptActionsFor('owed'), { received: true, notYet: false, clear: true });
});

test('an unrecorded gift offers both statements and nothing to clear', () => {
  assert.deepEqual(receiptActionsFor('unknown'), { received: true, notYet: true, clear: false });
});

test('a milestone not yet due cannot be marked owed — only an early receipt', () => {
  assert.deepEqual(receiptActionsFor('not_due'), { received: true, notYet: false, clear: false });
});

test('no state offers the button for the state it is already in', () => {
  assert.equal(receiptActionsFor('received').received, false);
  assert.equal(receiptActionsFor('owed').notYet, false);
});

test('the server refuses received → owed and says to Clear first', () => {
  const d = decideReceiptWrite(true, false);
  assert.equal(d.kind, 'refuse');
  assert.equal(d.kind === 'refuse' && d.reason, 'withdraw_first');
});

test('owed → received and unknown → either are ordinary writes', () => {
  assert.deepEqual(decideReceiptWrite(false, true), { kind: 'write' });
  assert.deepEqual(decideReceiptWrite(undefined, true), { kind: 'write' });
  assert.deepEqual(decideReceiptWrite(undefined, false), { kind: 'write' });
});

// --- Class 4: re-stating the current state writes nothing --------------------

test('re-stating the current state is unchanged, so a sheet row keeps its provenance', () => {
  assert.deepEqual(decideReceiptWrite(true, true), { kind: 'unchanged' });
  assert.deepEqual(decideReceiptWrite(false, false), { kind: 'unchanged' });
});

// --- Class 2: nobody records or clears their own gift ------------------------

test('your own work, personal or alternate address is your own record', () => {
  const own = ['carla@simple.biz', 'carla.t@gmail.com', 'carlat@simple.biz'];
  assert.equal(isOwnGiftRecord('carla@simple.biz', own), true);
  assert.equal(isOwnGiftRecord('carlat@simple.biz', own), true);
});

test('matching is case- and whitespace-insensitive', () => {
  assert.equal(isOwnGiftRecord('  Carla@Simple.biz ', ['carla@simple.biz']), true);
  assert.equal(isOwnGiftRecord('carla@simple.biz', ['  CARLA@simple.biz']), true);
});

test('a colleague is not your own record — exact match only, no prefix or fuzzy', () => {
  const own = ['lenny@simple.biz'];
  assert.equal(isOwnGiftRecord('lennyt@simple.biz', own), false);
  assert.equal(isOwnGiftRecord('april@simple.biz', own), false);
});

test('a blank target is never "own" (and never matches a blank own entry)', () => {
  assert.equal(isOwnGiftRecord('', ['']), false);
  assert.equal(isOwnGiftRecord('   ', ['carla@simple.biz']), false);
});

// --- Class 3: Clear needs a written reason -----------------------------------

test('Clear with no reason, a blank one, or a non-string is refused', () => {
  for (const raw of [undefined, null, '', '   ', 42, { reason: 'x' }]) {
    assert.ok('error' in readWithdrawReason(raw), `accepted ${JSON.stringify(raw)}`);
  }
});

test('a token reason ("undo", "oops") is refused — it must say something', () => {
  assert.ok('error' in readWithdrawReason('undo'));
  assert.ok('error' in readWithdrawReason('oops'));
  assert.ok('error' in readWithdrawReason('x'.repeat(MIN_WITHDRAW_REASON - 1)));
});

test('padding does not count toward the minimum; the kept reason is collapsed', () => {
  assert.ok('error' in readWithdrawReason(`   a      b   `));
  assert.deepEqual(readWithdrawReason('  recorded on   the wrong person  '), {
    reason: 'recorded on the wrong person',
  });
});

test('an over-long reason is refused rather than truncated', () => {
  assert.ok('error' in readWithdrawReason('y'.repeat(501)));
});
