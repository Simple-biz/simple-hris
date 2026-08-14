import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cycleStartedCount,
  isCycleFullyPaid,
  payableUnpaidCount,
  type CycleSettlement,
} from './cycle-complete-trigger';

/**
 * The celebration gate, shared by both trigger points (the strip hitting 100%
 * and closing the pay cycle). These tests lock the promises that keep the email
 * honest:
 *   1. Nobody payable unpaid AND somebody paid = the only way to celebrate.
 *   2. Problem and Threshold are money still owed — each one alone silences it.
 *      (This is the whole reason a CLOSE may fire it: cycle-closeout.md exists
 *      for weeks that end with people unpaid, and those must stay silent.)
 *   3. An empty week is not a victory.
 *   4. Any body built from these functions passes the server's
 *      `paid_count === total_count > 0` check — structurally, not by luck.
 */

const settled = (over: Partial<CycleSettlement> = {}): CycleSettlement => ({
  pendingCount: 0,
  blockedCount: 0,
  heldCount: 0,
  paidCount: 27,
  ...over,
});

test('nothing owed and somebody paid = the celebration moment', () => {
  assert.equal(isCycleFullyPaid(settled()), true);
  assert.equal(payableUnpaidCount(settled()), 0);
});

test('each way of being owed money silences it, one person is enough', () => {
  assert.equal(isCycleFullyPaid(settled({ pendingCount: 1 })), false);
  assert.equal(isCycleFullyPaid(settled({ blockedCount: 1 })), false); // Problem
  assert.equal(isCycleFullyPaid(settled({ heldCount: 1 })), false); // Threshold
});

test('an empty cycle never celebrates, however clean it looks', () => {
  assert.equal(isCycleFullyPaid(settled({ paidCount: 0 })), false);
  // ...and not even when the queue is empty in every direction.
  assert.equal(
    isCycleFullyPaid({ pendingCount: 0, blockedCount: 0, heldCount: 0, paidCount: 0 }),
    false,
  );
});

test('payable-unpaid sums all three reasons; started = paid + owed', () => {
  const s = settled({ pendingCount: 3, blockedCount: 2, heldCount: 1, paidCount: 20 });
  assert.equal(payableUnpaidCount(s), 6);
  assert.equal(cycleStartedCount(s), 26);
});

test('a celebrating body always satisfies the route: paid_count === total_count > 0', () => {
  // The server 400s on any other shape, so this equivalence is the contract.
  for (const pendingCount of [0, 1, 5]) {
    for (const blockedCount of [0, 1]) {
      for (const heldCount of [0, 2]) {
        for (const paidCount of [0, 1, 27]) {
          const s = { pendingCount, blockedCount, heldCount, paidCount };
          const serverWouldAccept = cycleStartedCount(s) === s.paidCount && s.paidCount > 0;
          assert.equal(
            isCycleFullyPaid(s),
            serverWouldAccept,
            `mismatch at ${JSON.stringify(s)}`,
          );
        }
      }
    }
  }
});
