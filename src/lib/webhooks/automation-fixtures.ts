/**
 * Fictional data for the Admin → Webhooks "Send test run" button. A test run
 * mails the signed-in admin ONLY, and it must not carry a real week's payees, so
 * the record and paid rows here are invented — same shape production sends,
 * plainly labelled TEST RUN. Values are placeholders, never real people.
 */

import type { CycleCloseoutRecord } from '@/lib/payroll/cycle-closeout';
import type { PaidDetailRow } from '@/lib/payroll/cycle-close-report-export';

export const TEST_RUN_LABEL = 'TEST RUN · Jul 19 – 25, 2026';

export function sampleCycleCloseoutRecord(now: Date = new Date()): CycleCloseoutRecord {
  return {
    version: 1,
    closed_at: now.toISOString(),
    closed_by: 'Test Run (Admin → Webhooks)',
    closed_by_email: 'admin@example.invalid',
    source_file: 'TEST-RUN_simple-biz_daily_report_2026-07-19_to_2026-07-25.csv',
    cycle_id: 'test-run',
    label: TEST_RUN_LABEL,
    period_start: '2026-07-19',
    period_end: '2026-07-25',
    paid: {
      payeeCount: 84,
      employeeCount: 80,
      contractorCount: 4,
      dispatchCount: 86,
      paidUSD: 1200.5,
      paidPHP: 412000,
    },
    byProcessor: {
      hurupay: { count: 50, usd: 700, php: 240000 },
      wise: { count: 20, usd: 300, php: 100000 },
      wires: { count: 16, usd: 200.5, php: 72000 },
    },
    unpaid: {
      source: 'dispatch_screen',
      count: 2,
      employeeCount: 2,
      contractorCount: 0,
      totalUSD: 150,
      totalPHP: 8400,
      payees: [
        { name: 'Sample Payee One', email: 'sample.one@example.invalid', payeeType: 'employee', reason: 'pending', amountUSD: 150, amountPHP: 8400, processor: 'wires' },
        { name: 'Sample Payee Two', email: 'sample.two@example.invalid', payeeType: 'employee', reason: 'threshold', amountUSD: null, amountPHP: null, processor: 'hurupay' },
      ],
      truncated: 0,
      dropped: 0,
      reconciledPaid: 0,
    },
    records_outstanding: { notPaid: 0, threshold: 1, problem: 0, neverDispatched: 1, total: 2 },
  };
}

export function samplePaidDetailRows(): PaidDetailRow[] {
  return Array.from({ length: 12 }, (_, i) => ({
    name: `Sample Payee ${i + 3}`,
    email: `sample.${i + 3}@example.invalid`,
    payeeType: i % 5 === 4 ? 'contractor' : 'employee',
    processor: i % 3 === 0 ? 'hurupay' : i % 3 === 1 ? 'wise' : 'wires',
    amountUSD: 10 + i,
    amountPHP: (10 + i) * 56,
    transactionId: `TEST-TXN-${1000 + i}`,
    bankUsed: 'Sample Bank',
    accountLast4: '···0000',
    dateSent: '2026-07-25',
  }));
}
