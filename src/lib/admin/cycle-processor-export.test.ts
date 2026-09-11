/**
 * buildProcessorCsv — the month/week breakdown download.
 *
 * What these pin:
 *  - the file foots to the SAME totals the modal shows, at the same scope
 *  - there is NO rate column, and the notes say why in the file itself
 *  - formula injection is neutralised on text, never on numbers
 *  - no PII can appear, because none is in the input shape
 *
 * Run:  npx tsx --test src/lib/admin/cycle-processor-export.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCyclePerformance,
  resolveMonthScope,
  summariseProcessorRows,
  type ProcessorBreakdownRow,
} from '@/lib/admin/cycle-performance';
import type { CycleCloseoutSummary } from '@/lib/payroll/cycle-closeout-store';
import {
  buildProcessorCsv,
  exportTimestamp,
  processorExportFilename,
} from '@/lib/admin/cycle-processor-export';

function rec(over: {
  file: string;
  label: string;
  periodEnd: string;
  paid: number;
  dispatchCount: number;
  unpaid: number;
  byProcessor: Record<string, { count: number; usd: number; php: number }>;
  unpaidByProcessor?: Record<
    string,
    { pending: number; problem: number; threshold: number; owedUSD: number; owedPHP: number }
  >;
}): CycleCloseoutSummary {
  return {
    version: 1,
    closed_at: '2026-08-14T04:00:00.000Z',
    closed_by: 'Clerk',
    closed_by_email: 'clerk@simple.biz',
    source_file: over.file,
    cycle_id: null,
    label: over.label,
    period_start: null,
    period_end: over.periodEnd,
    paid: {
      payeeCount: over.paid,
      employeeCount: over.paid,
      contractorCount: 0,
      dispatchCount: over.dispatchCount,
      paidUSD: 0,
      paidPHP: 0,
    },
    byProcessor: over.byProcessor,
    unpaid: {
      source: 'dispatch_screen',
      count: over.unpaid,
      employeeCount: over.unpaid,
      contractorCount: 0,
      totalUSD: 0,
      totalPHP: 0,
      truncated: 0,
      dropped: 0,
      reconciledPaid: 0,
      byProcessor: over.unpaidByProcessor ?? {},
    },
    records_outstanding: null,
  };
}

const MONTH = buildCyclePerformance([
  rec({
    file: 'w1', label: 'Aug 2 – 8, 2026', periodEnd: '2026-08-08',
    paid: 10, dispatchCount: 12, unpaid: 3,
    byProcessor: { wise: { count: 12, usd: 100.5, php: 5000.25 } },
    unpaidByProcessor: { wise: { pending: 1, problem: 2, threshold: 0, owedUSD: 30, owedPHP: 1500 } },
  }),
  rec({
    file: 'w2', label: 'Aug 9 – 15, 2026', periodEnd: '2026-08-15',
    paid: 20, dispatchCount: 20, unpaid: 1,
    byProcessor: { wires: { count: 20, usd: 400, php: 20000 } },
    unpaidByProcessor: { wires: { pending: 0, problem: 0, threshold: 1, owedUSD: 9, owedPHP: 500 } },
  }),
], [], (id) => (id === 'wires' ? 'x1153' : id === 'wise' ? 'Wise' : id)).months[0]!;

function csvFor(weekKey: string | null): string {
  const s = resolveMonthScope(MONTH, weekKey);
  return buildProcessorCsv({
    month: MONTH, week: s.week, rows: s.rows, paid: s.paid, paidPayments: s.paidPayments,
  });
}

const lines = (csv: string) => csv.split('\r\n');
const bodyOf = (csv: string) => lines(csv).filter((l) => /^(Wise|x1153|wise|wires|'|MONTH|WEEK)/.test(l));

test('the month file foots to the month totals the modal shows', () => {
  const csv = csvFor(null);
  const t = summariseProcessorRows(MONTH.processors);
  const footer = lines(csv).find((l) => l.startsWith('MONTH TOTAL'))!;
  assert.ok(footer.includes(t.paidPHP.toFixed(2)), footer);
  assert.ok(footer.includes(String(t.paidPayments)), footer);
  assert.ok(csv.includes(`People paid in scope,${MONTH.paid}`));
  assert.ok(csv.includes(`Payments in scope,${MONTH.paidPayments}`));
});

test('a week file foots to THAT week and never leaks the month total', () => {
  const csv = csvFor('w2');
  assert.ok(csv.includes('WEEK TOTAL'), 'the footer must say WEEK');
  assert.ok(!csv.includes('MONTH TOTAL'));
  assert.ok(csv.includes('20000.00'), 'week 2 money');
  assert.ok(!csv.includes('25000.00'), 'the month total must not appear');
  assert.ok(csv.includes('People paid in scope,20'));
});

test('the two scopes produce different files — the download follows the filter', () => {
  assert.notEqual(csvFor(null), csvFor('w1'));
});

test('there is NO rate column anywhere, and the file says why', () => {
  const csv = csvFor(null);
  assert.ok(!/\brate\b/i.test(lines(csv).find((l) => l.startsWith('Processor ID'))!));
  assert.ok(!csv.includes('%'), 'a percentage in this file would be the fabricated one');
  assert.ok(csv.includes('DIFFERENT UNITS'), 'the reason must travel with the file');
  assert.ok(csv.includes('no success rate per processor'));
});

test('the caveats ship in the file, not just on the screen', () => {
  const csv = csvFor(null);
  for (const phrase of [
    'dispatch ROWS, not people',
    'DELIBERATE hold',
    'WHOSE FAULT',
    'evidence, not a verdict',
    'Closed cycles only',
  ]) {
    assert.ok(csv.includes(phrase), `missing: ${phrase}`);
  }
});

test('the double-payment gap is stated, per scope', () => {
  // Week 1 has 12 payments to 10 people; week 2 has 20 to 20.
  assert.ok(csvFor('w1').includes('2 payment(s) went to someone already paid'));
  assert.ok(csvFor('w2').includes('nobody was paid twice'));
});

test('a processor label starting with = is neutralised — numbers are NOT', () => {
  const rows: ProcessorBreakdownRow[] = [
    {
      id: 'evil', label: '=cmd|calc', paidPayments: 1,
      paidUSD: -5, paidPHP: -250, pending: 0, problem: 0, threshold: 0,
      unpaidPeople: 0, owedUSD: 0, owedPHP: 0,
    },
  ];
  const csv = buildProcessorCsv({ month: MONTH, week: null, rows, paid: 1, paidPayments: 1 });
  assert.ok(csv.includes("'=cmd|calc"), 'text formula must be inert');
  assert.ok(csv.includes('-250.00'), 'a negative amount legitimately starts with -');
  assert.ok(!csv.includes("'-250.00"), 'numbers must NOT be neutralised');
});

test('a label containing a comma or quote is RFC 4180 quoted', () => {
  const rows: ProcessorBreakdownRow[] = [
    {
      id: 'x', label: 'Bank "A", Ltd', paidPayments: 0,
      paidUSD: 0, paidPHP: 0, pending: 0, problem: 0, threshold: 0,
      unpaidPeople: 0, owedUSD: 0, owedPHP: 0,
    },
  ];
  const csv = buildProcessorCsv({ month: MONTH, week: null, rows, paid: 0, paidPayments: 0 });
  assert.ok(csv.includes('"Bank ""A"", Ltd"'), csv);
});

test('every body row has exactly as many cells as the header', () => {
  const csv = csvFor(null);
  const header = lines(csv).find((l) => l.startsWith('Processor ID'))!;
  const want = header.split(',').length;
  for (const l of bodyOf(csv)) {
    // Naive split is safe here: no fixture label contains a comma.
    assert.equal(l.split(',').length, want, `ragged row: ${l}`);
  }
});

test('the filename names the scope, so two downloads are never confusable', () => {
  const now = new Date(2026, 8, 11, 14, 32, 5);
  const monthName = processorExportFilename(MONTH, null, now);
  const weekName = processorExportFilename(MONTH, MONTH.cycleBreakdowns[0]!, now);
  assert.ok(monthName.includes('2026-08'));
  assert.ok(monthName.includes('all-weeks'));
  assert.ok(weekName.includes('Aug-9-15') || weekName.includes('Aug-2-8'), weekName);
  assert.notEqual(monthName, weekName);
  assert.ok(monthName.endsWith('.csv'));
});

test('the timestamp is filename-safe and sorts', () => {
  assert.equal(exportTimestamp(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02T03-04-05');
});

test('an empty scope still produces a valid file with a zero footer', () => {
  const csv = buildProcessorCsv({ month: MONTH, week: null, rows: [], paid: 0, paidPayments: 0 });
  assert.ok(csv.includes('MONTH TOTAL'));
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(!csv.includes('NaN'));
});

test('no email or name can appear — the input shape carries none', () => {
  const csv = csvFor(null);
  assert.ok(!csv.includes('@'), 'no email-shaped text anywhere');
  assert.ok(!csv.includes('clerk'), 'the closer is not in the aggregate view');
});
