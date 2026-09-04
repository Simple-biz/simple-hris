import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CYCLE_COMPLETE_NOTIFIED_PREFIX,
  CYCLE_COMPLETE_TRIGGER,
  CYCLE_REPORT_SENT_PREFIX,
  asCycleCompleteTrigger,
  cycleCompleteNotifiedKey,
  cycleCompleteStatsFromRecord,
  cycleReportSentKey,
  cycleStartedCount,
  isCycleFullyPaid,
  isReportableCycleComplete,
  payableUnpaidCount,
  type CycleSettlement,
} from './cycle-complete-trigger';
import { CYCLE_CLOSEOUT_PREFIX, CYCLE_REOPENED_PREFIX, type CycleCloseoutRecord } from './cycle-closeout';

/**
 * Since 2026-09-04 there is ONE trigger. These tests pin the failure classes
 * that produced the two false celebrations (2026-08-18, 2026-09-02): a client
 * naming its own denominator, an unlabelled or foreign trigger being coerced
 * into a sendable one, and figures that do not come from the filed record.
 */

const settled = (over: Partial<CycleSettlement> = {}): CycleSettlement => ({
  pendingCount: 0,
  blockedCount: 0,
  heldCount: 0,
  paidCount: 27,
  ...over,
});

describe('strip state helpers (display only — they send nothing)', () => {
  test('nothing owed and somebody paid reads as fully paid', () => {
    assert.equal(isCycleFullyPaid(settled()), true);
    assert.equal(payableUnpaidCount(settled()), 0);
  });

  test('each way of being owed money clears it; an empty cycle is never 100%', () => {
    assert.equal(isCycleFullyPaid(settled({ pendingCount: 1 })), false);
    assert.equal(isCycleFullyPaid(settled({ blockedCount: 1 })), false);
    assert.equal(isCycleFullyPaid(settled({ heldCount: 1 })), false);
    assert.equal(isCycleFullyPaid(settled({ paidCount: 0 })), false);
  });

  test('payable-unpaid sums all three reasons; started = paid + owed', () => {
    const s = settled({ pendingCount: 3, blockedCount: 2, heldCount: 1, paidCount: 20 });
    assert.equal(payableUnpaidCount(s), 6);
    assert.equal(cycleStartedCount(s), 26);
  });
});

describe('one trigger', () => {
  test('cycle_closed is the only label; everything else is REFUSED, never coerced', () => {
    assert.equal(CYCLE_COMPLETE_TRIGGER, 'cycle_closed');
    assert.equal(asCycleCompleteTrigger('cycle_closed'), 'cycle_closed');
    // The retired strip arm must not survive as a label a caller can send.
    assert.equal(asCycleCompleteTrigger('fully_paid'), null);
    assert.equal(asCycleCompleteTrigger(undefined), null);
    assert.equal(asCycleCompleteTrigger(''), null);
    assert.equal(asCycleCompleteTrigger('nonsense'), null);
  });
});

describe('figures come from the filed record', () => {
  const record = (over: Partial<CycleCloseoutRecord['unpaid']> = {}): CycleCloseoutRecord => ({
    version: 1,
    closed_at: '2026-08-28T19:52:47.000Z',
    closed_by: 'Carla Thomas',
    closed_by_email: 'carla@simple.biz',
    source_file: 'simple-biz_daily_report_2026-08-16_to_2026-08-22.csv',
    cycle_id: 'c1',
    label: 'Aug 16 – 22, 2026',
    period_start: '2026-08-16',
    period_end: '2026-08-22',
    paid: { payeeCount: 1023, employeeCount: 1000, contractorCount: 23, dispatchCount: 1030, paidUSD: 204319.84, paidPHP: 12610617.2 },
    byProcessor: {},
    unpaid: {
      source: 'dispatch_screen',
      count: 19,
      employeeCount: 19,
      contractorCount: 0,
      totalUSD: 400,
      totalPHP: 24759.85,
      payees: [],
      truncated: 0,
      dropped: 0,
      reconciledPaid: 0,
      ...over,
    },
    records_outstanding: null,
  });

  test("Carla's real week: 1023 paid, 19 owed → total 1042, honest unpaid_count", () => {
    const s = cycleCompleteStatsFromRecord(record());
    assert.deepEqual(s, {
      paid_count: 1023,
      total_count: 1042,
      unpaid_count: 19,
      total_paid_usd: 204319.84,
      total_paid_php: 12610617.2,
    });
    assert.equal(isReportableCycleComplete({ paidCount: s.paid_count, totalCount: s.total_count }), true);
  });

  test('the storage cap never hides people: truncated rows count in unpaid', () => {
    const s = cycleCompleteStatsFromRecord(record({ count: 1000, truncated: 26 }));
    assert.equal(s.unpaid_count, 1026);
    assert.equal(s.total_count, 1023 + 1026);
  });

  test('the two false weeks could not be built from a record: the record IS the denominator', () => {
    // 2026-09-02: the browser said 20 of 20. A record for that week names every
    // payable person, so total_count cannot collapse to the paid count unless the
    // clerk's declared unpaid list is genuinely empty.
    const s = cycleCompleteStatsFromRecord(record({ count: 1033 }));
    assert.equal(s.total_count, 2056);
    assert.notEqual(s.paid_count, s.total_count);
  });
});

describe('boundary check', () => {
  test('a close with a shortfall is sendable; nobody paid is not; more paid than held is not', () => {
    assert.equal(isReportableCycleComplete({ paidCount: 1051, totalCount: 1068 }), true);
    assert.equal(isReportableCycleComplete({ paidCount: 0, totalCount: 40 }), false);
    assert.equal(isReportableCycleComplete({ paidCount: 0, totalCount: 0 }), false);
    assert.equal(isReportableCycleComplete({ paidCount: 50, totalCount: 40 }), false);
  });

  test('non-finite counts are refused rather than coerced', () => {
    assert.equal(isReportableCycleComplete({ paidCount: NaN, totalCount: 10 }), false);
    assert.equal(isReportableCycleComplete({ paidCount: 5, totalCount: Infinity }), false);
  });
});

describe('claim keys', () => {
  test('celebration and report keys are spelled once and carry the file verbatim', () => {
    const f = 'simple-biz_daily_report_2026-08-23_to_2026-08-29 (1).csv';
    assert.equal(cycleCompleteNotifiedKey(f), `dispatch.cycle_complete_notified.${f}`);
    assert.equal(cycleReportSentKey(f), `dispatch.cycle_report_sent.${f}`);
  });

  test('every dispatch. prefix is disjoint — no LIKE scan can catch a neighbour', () => {
    const prefixes = [
      CYCLE_COMPLETE_NOTIFIED_PREFIX,
      CYCLE_REPORT_SENT_PREFIX,
      CYCLE_CLOSEOUT_PREFIX,
      CYCLE_REOPENED_PREFIX,
    ];
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        assert.ok(!a.startsWith(b), `${a} is caught by a scan for ${b}`);
      }
    }
  });
});
