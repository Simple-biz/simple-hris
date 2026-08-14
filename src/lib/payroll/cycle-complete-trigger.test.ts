import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  asCycleCompleteTrigger,
  cycleStartedCount,
  isCycleFullyPaid,
  isReportableCycleComplete,
  payableUnpaidCount,
  type CycleSettlement,
} from './cycle-complete-trigger';

/**
 * `isCycleFullyPaid` — what the STRIP trigger means by 100%: nobody pending, on
 * Problem or at Threshold, and somebody actually paid. Since 2026-08-14 it gates
 * that trigger only; the CLOSE trigger fires on the close itself and reports its
 * shortfall (see `describe('report arms')` at the bottom).
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

test('a fully-paid body always satisfies the strict arm: paid_count === total_count > 0', () => {
  // The server 400s a `fully_paid` report in any other shape, so this
  // equivalence is the contract for the STRIP trigger.
  for (const pendingCount of [0, 1, 5]) {
    for (const blockedCount of [0, 1]) {
      for (const heldCount of [0, 2]) {
        for (const paidCount of [0, 1, 27]) {
          const s = { pendingCount, blockedCount, heldCount, paidCount };
          const serverWouldAccept = isReportableCycleComplete({
            trigger: 'fully_paid',
            paidCount: s.paidCount,
            totalCount: cycleStartedCount(s),
          });
          assert.equal(isCycleFullyPaid(s), serverWouldAccept, `mismatch at ${JSON.stringify(s)}`);
        }
      }
    }
  }
});

/**
 * The two arms (2026-08-14). Kane: "if it's closed it's closed" — a close reports
 * a real shortfall instead of pretending everyone was paid. The strip's arm did
 * NOT weaken to allow it; that is the whole reason there are two.
 */
describe('report arms', () => {
  const paid = (paidCount: number, totalCount: number) => ({ paidCount, totalCount });

  test('a close reports its shortfall and is still sendable', () => {
    // Carla's real week: 1051 paid, 17 payable-unpaid.
    assert.equal(
      isReportableCycleComplete({ trigger: 'cycle_closed', ...paid(1051, 1068) }),
      true,
    );
    // The same numbers on the strip's arm stay refused — it means "100%".
    assert.equal(
      isReportableCycleComplete({ trigger: 'fully_paid', ...paid(1051, 1068) }),
      false,
    );
  });

  test('nothing paid is never sendable, on EITHER arm', () => {
    assert.equal(isReportableCycleComplete({ trigger: 'cycle_closed', ...paid(0, 40) }), false);
    assert.equal(isReportableCycleComplete({ trigger: 'fully_paid', ...paid(0, 0) }), false);
  });

  test('more paid than the cycle held is a broken report, on EITHER arm', () => {
    assert.equal(isReportableCycleComplete({ trigger: 'cycle_closed', ...paid(50, 40) }), false);
    assert.equal(isReportableCycleComplete({ trigger: 'fully_paid', ...paid(50, 40) }), false);
  });

  test('non-finite counts are refused rather than coerced', () => {
    assert.equal(
      isReportableCycleComplete({ trigger: 'cycle_closed', ...paid(NaN, 10) }),
      false,
    );
    assert.equal(
      isReportableCycleComplete({ trigger: 'cycle_closed', ...paid(5, Infinity) }),
      false,
    );
  });

  test('an unlabelled trigger falls back to the STRICTER arm', () => {
    assert.equal(asCycleCompleteTrigger(undefined), 'fully_paid');
    assert.equal(asCycleCompleteTrigger('nonsense'), 'fully_paid');
    assert.equal(asCycleCompleteTrigger('cycle_closed'), 'cycle_closed');
    // …so a body that forgot the field cannot inherit the close's permission.
    assert.equal(
      isReportableCycleComplete({
        trigger: asCycleCompleteTrigger(undefined),
        ...paid(1051, 1068),
      }),
      false,
    );
  });
});
