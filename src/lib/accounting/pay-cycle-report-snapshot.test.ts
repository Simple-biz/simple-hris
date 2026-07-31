import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAY_CYCLE_REPORT_VERSION,
  buildPayCycleReportSnapshot,
  cycleCompleteness,
  isPublishableCycle,
  toPayCycleReportSummary,
} from './pay-cycle-report-snapshot';
import type { DisbursementReportSummary, DisbursementReportTotals } from '@/lib/payroll/disbursement-reports';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

function totals(over: Partial<DisbursementReportTotals> = {}): DisbursementReportTotals {
  return {
    paidCount: 10, paidUSD: 1000, paidPHP: 56000,
    notPaidCount: 0, thresholdCount: 0, problemCount: 0,
    pendingDispatchedUSD: 0, sentCount: 10, totalDispatchedUSD: 1000,
    outstandingCount: 0, outstandingUSD: 0,
    totalRecipients: 10, totalOwedUSD: 1000,
    ...over,
  };
}

function summary(over: Partial<DisbursementReportSummary> = {}): DisbursementReportSummary {
  return {
    cycleId: 'upload-1',
    periodStart: '2026-07-26',
    periodEnd: '2026-08-01',
    sourceFile: 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv',
    uploadedAt: '2026-08-01T02:00:00.000Z',
    uploadedBy: 'carla@simple.biz',
    rowCount: 10,
    isCurrent: true,
    reportName: 'Jul 26 - Aug 1, 2026',
    totals: totals(),
    byProcessor: {},
    paidRecipients: [],
    ...over,
  };
}

function dispatch(over: Partial<PaymentDispatchRow> = {}): PaymentDispatchRow {
  return {
    id: 'd1',
    recipient_email: 'juan@simple.biz',
    recipient_name: 'Juan Santos',
    processor: 'hurupay',
    amount_usd: 100,
    amount_php: 5600,
    transaction_id: 'TXN-1',
    bank_used: 'Hurupay',
    sent_date: '2026-08-01',
    arrival_date: '2026-08-02',
    status: 'paid',
    payee_type: 'employee',
    cycle_source_file: 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv',
    ...over,
  } as PaymentDispatchRow;
}

describe('cycleCompleteness', () => {
  test('a fully paid cycle is complete', () => {
    const c = cycleCompleteness(totals());
    assert.equal(c.complete, true);
    assert.equal(c.paidCount, 10);
    assert.equal(c.pendingCount, 0);
    assert.equal(c.blockedCount, 0);
  });

  test('each blocking bucket alone keeps it incomplete', () => {
    for (const key of ['notPaidCount', 'thresholdCount', 'outstandingCount'] as const) {
      const c = cycleCompleteness(totals({ [key]: 3 }));
      assert.equal(c.complete, false, `${key} should block completion`);
      assert.equal(c.pendingCount, 3, `${key} counts as pending`);
    }
  });

  test('problem rows count as blocked, not pending', () => {
    const c = cycleCompleteness(totals({ problemCount: 2 }));
    assert.equal(c.complete, false);
    assert.equal(c.blockedCount, 2);
    assert.equal(c.pendingCount, 0);
  });

  test('a cycle with nothing paid is never complete', () => {
    assert.equal(cycleCompleteness(totals({ paidCount: 0, sentCount: 0 })).complete, false);
  });
});

describe('isPublishableCycle', () => {
  test('a complete regular cycle is publishable', () => {
    assert.equal(isPublishableCycle(summary()), true);
  });

  test('urgent cycles are never publishable', () => {
    assert.equal(isPublishableCycle(summary({ sourceFile: 'urgent_2026-07-26' })), false);
  });

  test('a cycle with no source file is never publishable', () => {
    assert.equal(isPublishableCycle(summary({ sourceFile: null })), false);
  });
});

describe('buildPayCycleReportSnapshot', () => {
  const base = {
    publishedBy: 'Carla Dela Cruz',
    publishedByEmail: 'carla@simple.biz',
    publishedAt: '2026-08-02T01:00:00.000Z',
  };

  test('freezes identity, version and publisher', () => {
    const snap = buildPayCycleReportSnapshot({ summary: summary(), dispatches: [dispatch()], ...base });
    assert.equal(snap.version, PAY_CYCLE_REPORT_VERSION);
    assert.equal(snap.published_by, 'Carla Dela Cruz');
    assert.equal(snap.published_by_email, 'carla@simple.biz');
    assert.equal(snap.published_at, '2026-08-02T01:00:00.000Z');
    assert.equal(snap.source_file, 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv');
    assert.equal(snap.cycle_id, 'upload-1');
    assert.equal(snap.label, 'Jul 26 - Aug 1, 2026');
    assert.equal(snap.period_start, '2026-07-26');
    assert.equal(snap.period_end, '2026-08-01');
  });

  test('keeps only paid dispatches, one payee row each', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [
        dispatch({ id: 'a', transaction_id: 'TXN-A' }),
        dispatch({ id: 'b', status: 'not_paid', transaction_id: 'TXN-B' }),
        dispatch({ id: 'c', status: 'problem', transaction_id: 'TXN-C' }),
      ],
      ...base,
    });
    assert.equal(snap.payees.length, 1);
    assert.equal(snap.payees[0].transactionId, 'TXN-A');
    assert.equal(snap.totals.dispatchCount, 1);
  });

  test('payeeCount is distinct employees plus one per contractor invoice', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [
        dispatch({ id: 'a', recipient_email: 'Juan@simple.biz', amount_usd: 60 }),
        dispatch({ id: 'b', recipient_email: 'juan@simple.biz ', amount_usd: 40 }),
        dispatch({ id: 'c', recipient_email: 'claire@agency.com', payee_type: 'contractor', amount_usd: 500 }),
        dispatch({ id: 'd', recipient_email: 'claire@agency.com', payee_type: 'contractor', amount_usd: 700 }),
      ],
      ...base,
    });
    // Juan collapses to 1; Claire's two invoices stay 2.
    assert.equal(snap.totals.payeeCount, 3);
    assert.equal(snap.totals.employeeCount, 1);
    assert.equal(snap.totals.contractorCount, 2);
    // Every dispatch is still its own traceable row.
    assert.equal(snap.payees.length, 4);
    assert.equal(snap.totals.dispatchCount, 4);
    assert.equal(snap.totals.paidUSD, 1300);
  });

  test('tallies per processor and sums both currencies', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [
        dispatch({ id: 'a', processor: 'hurupay', amount_usd: 100, amount_php: 5600 }),
        dispatch({ id: 'b', processor: 'hurupay', amount_usd: 50, amount_php: 2800, recipient_email: 'b@simple.biz' }),
        dispatch({ id: 'c', processor: 'wise', amount_usd: 25, amount_php: 1400, recipient_email: 'c@simple.biz' }),
      ],
      ...base,
    });
    assert.deepEqual(snap.byProcessor.hurupay, { count: 2, usd: 150, php: 8400 });
    assert.deepEqual(snap.byProcessor.wise, { count: 1, usd: 25, php: 1400 });
    assert.equal(snap.totals.paidUSD, 175);
    assert.equal(snap.totals.paidPHP, 9800);
  });

  test('null money and blank txn ids normalize instead of producing NaN', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [dispatch({ amount_usd: null, amount_php: null, transaction_id: '  ', bank_used: '' })],
      ...base,
    });
    assert.equal(snap.totals.paidUSD, 0);
    assert.equal(snap.totals.paidPHP, 0);
    assert.equal(snap.payees[0].transactionId, null);
    assert.equal(snap.payees[0].bankUsed, null);
  });

  test('payees sort by name, unnamed last', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [
        dispatch({ id: 'a', recipient_name: 'Zoe', recipient_email: 'z@simple.biz' }),
        dispatch({ id: 'b', recipient_name: null, recipient_email: 'anon@simple.biz' }),
        dispatch({ id: 'c', recipient_name: 'Abel', recipient_email: 'a@simple.biz' }),
      ],
      ...base,
    });
    assert.deepEqual(snap.payees.map((p) => p.email), ['a@simple.biz', 'z@simple.biz', 'anon@simple.biz']);
  });
});

describe('toPayCycleReportSummary', () => {
  test('drops the payees array and keeps everything else', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [dispatch()],
      publishedBy: 'Carla',
      publishedByEmail: 'carla@simple.biz',
      publishedAt: '2026-08-02T01:00:00.000Z',
    });
    const sum = toPayCycleReportSummary(snap);
    assert.equal('payees' in sum, false);
    assert.equal(sum.totals.payeeCount, snap.totals.payeeCount);
    assert.equal(sum.source_file, snap.source_file);
  });
});
