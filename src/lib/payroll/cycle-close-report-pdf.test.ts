import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

import { buildFinalCloseoutPdf } from './cycle-close-report-pdf';
import type { FinalCloseReportModel, PaidDetailRow } from './cycle-close-report-export';
import type { CycleCloseoutRecord } from './cycle-closeout';

const NOW = new Date(2026, 8, 4, 10, 0, 0);

function record(over: Partial<CycleCloseoutRecord> = {}): CycleCloseoutRecord {
  return {
    version: 1,
    closed_at: '2026-08-28T19:52:47.000Z',
    closed_by: 'Carla Thomas',
    closed_by_email: 'carla@simple.biz',
    source_file: 'simple-biz_daily_report_2026-08-16_to_2026-08-22.csv',
    cycle_id: 'c1',
    label: 'Aug 16 – 22, 2026',
    period_start: '2026-08-16',
    period_end: '2026-08-22',
    paid: { payeeCount: 3, employeeCount: 2, contractorCount: 1, dispatchCount: 4, paidUSD: 1300, paidPHP: 72800 },
    byProcessor: { hurupay: { count: 2, usd: 800, php: 44800 }, legacy_rail: { count: 2, usd: 500, php: 28000 } },
    unpaid: {
      source: 'dispatch_screen',
      count: 2,
      employeeCount: 2,
      contractorCount: 0,
      totalUSD: 250,
      totalPHP: 14000,
      payees: [
        { name: 'María José Ñuñez', email: 'maria@simple.biz', payeeType: 'employee', reason: 'pending', amountUSD: 150, amountPHP: 8400, processor: 'wires' },
        { name: 'Jose Cruz', email: 'jose@simple.biz', payeeType: 'employee', reason: 'threshold', amountUSD: null, amountPHP: null, processor: 'hurupay' },
      ],
      truncated: 0,
      dropped: 0,
      reconciledPaid: 0,
    },
    records_outstanding: { notPaid: 1, threshold: 1, problem: 0, neverDispatched: 3, total: 5 },
    ...over,
  };
}

const paidRow = (i: number): PaidDetailRow => ({
  name: `Payee ${i} ₱`,
  email: `payee${i}@simple.biz`,
  payeeType: i % 7 === 0 ? 'contractor' : 'employee',
  processor: 'wise',
  amountUSD: 100 + i,
  amountPHP: (100 + i) * 56,
  transactionId: `TXN-${i}`,
  bankUsed: 'BDO',
  accountLast4: '···1234',
  dateSent: '2026-08-22',
});

const model = (over: Partial<FinalCloseReportModel> = {}): FinalCloseReportModel => ({
  kind: 'final',
  record: record(),
  livePaidRows: null,
  generatedAt: NOW,
  ...over,
});

describe('final close-out PDF', () => {
  test('produces a real PDF, titled Cycle Close-Out, one page for a record-only build', async () => {
    const bytes = await buildFinalCloseoutPdf(model(), { logo: false });
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString('latin1'), '%PDF-');
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 1);
    assert.match(doc.getTitle() ?? '', /^Cycle Close-Out/);
    assert.ok(!/Pay Cycle Report/i.test(doc.getTitle() ?? ''));
  });

  test('unicode names and the peso sign never throw (WinAnsi sanitize)', async () => {
    const bytes = await buildFinalCloseoutPdf(
      model({ record: record({ label: 'Aug 16 – 22, 2026 · ₱ week — “final”' }) }),
      { logo: false },
    );
    assert.ok(bytes.length > 1000);
  });

  test('live paid rows paginate: 1,000 rows → many pages, every one produced', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => paidRow(i + 1));
    const bytes = await buildFinalCloseoutPdf(model({ livePaidRows: rows }), { logo: false });
    const doc = await PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() >= 20, `expected ≥20 pages, got ${doc.getPageCount()}`);
    // Size cap sanity for the email attachment path (raw bytes, before base64).
    assert.ok(bytes.length < 2 * 1024 * 1024, `1,000-row PDF is ${bytes.length} bytes`);
  });

  test('a record with nobody unpaid still renders (empty list is a sentence, not a crash)', async () => {
    const r = record();
    r.unpaid = { ...r.unpaid, count: 0, employeeCount: 0, totalUSD: 0, totalPHP: 0, payees: [] };
    const bytes = await buildFinalCloseoutPdf(model({ record: r }), { logo: false });
    assert.ok(bytes.length > 1000);
  });
});

describe('module boundary', () => {
  test('the PDF builder performs no fetch and imports no supabase client', () => {
    const src = readFileSync(fileURLToPath(new URL('./cycle-close-report-pdf.ts', import.meta.url)), 'utf-8');
    assert.ok(!src.includes('@/lib/supabase/server'));
    assert.ok(!src.includes('createSupabase'));
    assert.ok(!/\bfetch\s*\(/.test(src));
    // The retired artifact's name must not appear anywhere in the file.
    assert.ok(!/Pay Cycle Report/.test(src));
  });
});
