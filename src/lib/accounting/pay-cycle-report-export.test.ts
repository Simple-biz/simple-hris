import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  buildPayCycleReportExport,
  buildPayCycleReportWorkbook,
  generatePayCycleReportPdf,
  payCycleReportToCsv,
} from './pay-cycle-report-export';
import type { PayCycleReportPayee, PayCycleReportSnapshot } from './pay-cycle-report-snapshot';

function payee(over: Partial<PayCycleReportPayee> = {}): PayCycleReportPayee {
  return {
    name: 'Juan Santos',
    email: 'juan@simple.biz',
    payeeType: 'employee',
    processor: 'hurupay',
    amountUSD: 100,
    amountPHP: 5600,
    transactionId: 'TXN-1',
    bankUsed: 'Hurupay',
    dateSent: '2026-08-01',
    arrivalDate: '2026-08-02',
    ...over,
  };
}

function snapshot(payees: PayCycleReportPayee[]): PayCycleReportSnapshot {
  return {
    version: 1,
    published_at: '2026-08-02T01:00:00.000Z',
    published_by: 'carla',
    published_by_email: 'carla@simple.biz',
    source_file: 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv',
    cycle_id: 'upload-1',
    label: 'Jul 26 - Aug 1, 2026',
    period_start: '2026-07-26',
    period_end: '2026-08-01',
    totals: {
      payeeCount: payees.length,
      employeeCount: payees.filter((p) => p.payeeType === 'employee').length,
      contractorCount: payees.filter((p) => p.payeeType === 'contractor').length,
      dispatchCount: payees.length,
      paidUSD: payees.reduce((s, p) => s + p.amountUSD, 0),
      paidPHP: payees.reduce((s, p) => s + p.amountPHP, 0),
    },
    byProcessor: { hurupay: { count: payees.length, usd: 0, php: 0 } },
    payees,
  };
}

describe('payCycleReportToCsv', () => {
  test('starts with a UTF-8 BOM and a provenance preamble', () => {
    const csv = payCycleReportToCsv(buildPayCycleReportExport(snapshot([payee()])));
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.match(csv, /Pay Cycle Report/);
    assert.match(csv, /Jul 26 - Aug 1, 2026/);
    assert.match(csv, /Pulled from Simple-HRIS System/);
    assert.match(csv, /carla@simple\.biz/);
  });

  test('emits a numbered row per payee with the expected header', () => {
    const csv = payCycleReportToCsv(
      buildPayCycleReportExport(snapshot([payee(), payee({ name: 'Ana', email: 'ana@simple.biz' })])),
    );
    const lines = csv.split('\r\n');
    const headerIdx = lines.findIndex((l) => l.startsWith('#,'));
    assert.ok(headerIdx > 0, 'header row present after the preamble');
    assert.equal(
      lines[headerIdx],
      '#,Name,Email,Type,Processor,Amount (USD),Amount (PHP),Transaction ID,Bank Used,Date Sent',
    );
    assert.ok(lines[headerIdx + 1].startsWith('1,'));
    assert.ok(lines[headerIdx + 2].startsWith('2,'));
  });

  test('escapes commas and quotes per RFC 4180', () => {
    const csv = payCycleReportToCsv(
      buildPayCycleReportExport(snapshot([payee({ name: 'Santos, Juan "JD"' })])),
    );
    assert.match(csv, /"Santos, Juan ""JD"""/);
  });
});

describe('buildPayCycleReportWorkbook', () => {
  test('puts the header on row 5 with an autofilter over the data', () => {
    const model = buildPayCycleReportExport(snapshot([payee(), payee({ email: 'b@simple.biz' })]));
    const wb = buildPayCycleReportWorkbook(model);
    assert.deepEqual(wb.SheetNames, ['Pay Cycle Report']);
    const ws = wb.Sheets['Pay Cycle Report'];
    assert.equal(ws.A5?.v, '#');
    assert.equal(ws.B5?.v, 'Name');
    // 10 columns => last col index 9 ("J"); 2 data rows => through row 7.
    assert.equal(ws['!autofilter']?.ref, 'A5:J7');
    assert.equal(ws.A6?.v, 1);
    assert.equal(ws.A7?.v, 2);
  });
});

describe('generatePayCycleReportPdf', () => {
  test('produces a loadable PDF for an empty report', async () => {
    const bytes = await generatePayCycleReportPdf(buildPayCycleReportExport(snapshot([])));
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString('utf8'), '%PDF-');
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 1);
  });

  test('paginates a long payee list', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      payee({ name: `Person ${i}`, email: `p${i}@simple.biz` }),
    );
    const bytes = await generatePayCycleReportPdf(buildPayCycleReportExport(snapshot(many)));
    const doc = await PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() > 1, 'expected more than one page');
  });

  test('survives characters Helvetica cannot encode', async () => {
    const bytes = await generatePayCycleReportPdf(
      buildPayCycleReportExport(
        snapshot([payee({ name: 'Iñigo — “Ñoño” … ₱ → 中文', bankUsed: '₱ wallet' })]),
      ),
    );
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString('utf8'), '%PDF-');
  });
});
