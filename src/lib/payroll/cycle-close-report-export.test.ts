import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

import {
  buildFinalCloseoutCsv,
  buildPrematureSnapshotWorkbook,
  closeReportFilename,
  fileTimestamp,
  maskAccountLast4,
  projectPaidDetailRows,
  type PrematureSnapshotModel,
} from './cycle-close-report-export';
import type { CycleCloseoutRecord } from './cycle-closeout';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

/**
 * These tests pin the failure classes enumerated in
 * docs/features/cycle-closeout.md § Downloadable report:
 * premature-mistaken-for-final, client-recomputed headlines, superseded
 * markers double-counted, PII leakage, silent truncation, Excluded leaking
 * into unpaid, null-as-zero, processor money dropped, formula injection,
 * encoding, and timestamp/filename drift.
 */

const NOW = new Date(2026, 7, 12, 23, 59, 58); // Aug 12 2026 23:59:58 LOCAL

function record(over: Partial<CycleCloseoutRecord> = {}): CycleCloseoutRecord {
  return {
    version: 1,
    closed_at: '2026-08-12T15:04:05.000Z',
    closed_by: 'Lenny Reyes',
    closed_by_email: 'lenny@simple.biz',
    source_file: 'simple-biz_daily_report_2026-08-03_to_2026-08-09.csv',
    cycle_id: 'upload-1',
    label: 'August 3-9, 2026',
    period_start: '2026-08-03',
    period_end: '2026-08-09',
    paid: {
      payeeCount: 3,
      employeeCount: 2,
      contractorCount: 1,
      dispatchCount: 4,
      paidUSD: 1300,
      paidPHP: 72800,
    },
    byProcessor: {
      hurupay: { count: 2, usd: 800, php: 44800 },
      wise: { count: 2, usd: 500, php: 28000 },
    },
    unpaid: {
      source: 'dispatch_screen',
      count: 2,
      employeeCount: 2,
      contractorCount: 0,
      totalUSD: 250,
      totalPHP: 14000,
      payees: [
        {
          name: 'Maria Santos',
          email: 'maria@simple.biz',
          payeeType: 'employee',
          reason: 'pending',
          amountUSD: 150,
          amountPHP: 8400,
          processor: 'wires',
        },
        {
          name: 'Jose Cruz',
          email: 'jose@simple.biz',
          payeeType: 'employee',
          reason: 'threshold',
          amountUSD: null,
          amountPHP: null,
          processor: 'hurupay',
        },
      ],
      truncated: 0,
      dropped: 0,
    },
    records_outstanding: { notPaid: 1, threshold: 1, problem: 0, neverDispatched: 3, total: 5 },
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
    bank_used: 'BDO',
    recipient_account_number: '001234567890',
    recipient_swift_code: 'BNORPHMM',
    sent_date: '2026-08-08',
    status: 'paid',
    payee_type: 'employee',
    cycle_source_file: 'simple-biz_daily_report_2026-08-03_to_2026-08-09.csv',
    ...over,
  } as PaymentDispatchRow;
}

function prematureModel(over: Partial<PrematureSnapshotModel> = {}): PrematureSnapshotModel {
  return {
    kind: 'premature',
    label: 'August 3-9, 2026',
    sourceFile: 'simple-biz_daily_report_2026-08-03_to_2026-08-09.csv',
    periodStart: '2026-08-03',
    periodEnd: '2026-08-09',
    generatedAt: NOW,
    paidRows: projectPaidDetailRows([dispatch()]),
    distinctPaidCount: 1,
    unpaid: [
      {
        name: 'Maria Santos',
        email: 'maria@simple.biz',
        payeeType: 'employee',
        reason: 'pending',
        amountUSD: 150,
        amountPHP: 8400,
        processor: 'wires',
        amountSource: 'recomputed',
      },
    ],
    ...over,
  };
}

function sheetAoa(wb: XLSX.WorkBook, name: string): unknown[][] {
  const ws = wb.Sheets[name];
  assert.ok(ws, `sheet ${name} exists`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as unknown[][];
}

// ── Filenames & timestamps ────────────────────────────────────────────────────

describe('filenames and timestamps', () => {
  test('local-time, second resolution, no colons, filesystem-safe', () => {
    assert.equal(fileTimestamp(NOW), '2026-08-12 23-59-58');
    const f = closeReportFilename('final', 'August 3-9, 2026', NOW);
    const p = closeReportFilename('premature', 'August 3-9, 2026', NOW);
    for (const name of [f, p]) {
      assert.match(name, /^[a-zA-Z0-9_. -]+$/, 'no colons or exotic characters');
    }
    assert.ok(f.includes('-FINAL-') && f.endsWith('.csv'), f);
    assert.ok(p.includes('-PREMATURE-') && p.endsWith('.xlsx'), p);
  });

  test('the artifact never calls itself a report (that was the retired surface)', () => {
    const f = closeReportFilename('final', 'August 3-9, 2026', NOW);
    const p = closeReportFilename('premature', 'August 3-9, 2026', NOW);
    assert.ok(!f.toLowerCase().includes('report'));
    assert.ok(!p.toLowerCase().includes('report'));
    const csv = buildFinalCloseoutCsv({ kind: 'final', record: record(), generatedAt: NOW });
    assert.ok(!csv.toLowerCase().includes('pay cycle report'));
    assert.ok(csv.includes('Cycle Close-Out'));
  });
});

// ── FINAL: rendered verbatim from the stored record ──────────────────────────

describe('final close-out CSV', () => {
  test('headline figures come from the record verbatim, status names the closer', () => {
    const csv = buildFinalCloseoutCsv({ kind: 'final', record: record(), generatedAt: NOW });
    assert.ok(csv.includes('STATUS: FINAL — closed 2026-08-12T15:04:05.000Z by Lenny Reyes'));
    assert.ok(csv.includes('Payees paid,3'));
    assert.ok(csv.includes('Employees paid,2'));
    assert.ok(csv.includes('Contractor invoices paid,1'));
    assert.ok(csv.includes('Paid dispatch rows,4'));
    assert.ok(csv.includes('Paid USD,1300.00'));
    assert.ok(csv.includes('Paid PHP,72800.00'));
    assert.ok(!csv.includes('NOT YET CLOSED'), 'a final file never wears the premature stamp');
  });

  test('already-closed re-download (record-only) has no live section', () => {
    const csv = buildFinalCloseoutCsv({
      kind: 'final',
      record: record(),
      livePaidRows: null,
      generatedAt: NOW,
    });
    assert.ok(!csv.includes('PAID DETAIL — LIVE'));
  });

  test('the live paid section always carries its disclosure, separate from the frozen block', () => {
    const csv = buildFinalCloseoutCsv({
      kind: 'final',
      record: record(),
      livePaidRows: projectPaidDetailRows([dispatch()]),
      generatedAt: NOW,
    });
    assert.ok(csv.includes('PAID DETAIL — LIVE, NOT PART OF THE FROZEN RECORD'));
    assert.ok(csv.includes('may differ from the headline in either direction'));
    assert.ok(csv.indexOf('FROZEN AT CLOSE') < csv.indexOf('PAID DETAIL — LIVE'));
  });

  test('silent truncation is impossible: headline adds truncated, notice renders both', () => {
    const r = record();
    r.unpaid.truncated = 300;
    r.unpaid.dropped = 2;
    const csv = buildFinalCloseoutCsv({ kind: 'final', record: r, generatedAt: NOW });
    assert.ok(csv.includes('Payable not paid,302'), 'count(2) + truncated(300)');
    assert.ok(csv.includes('NOTICE: 300 unpaid people are counted above but not listed'));
    assert.ok(csv.includes('2 entries were dropped as unidentifiable'));

    const clean = buildFinalCloseoutCsv({ kind: 'final', record: record(), generatedAt: NOW });
    assert.ok(!clean.includes('NOTICE:'), 'no notice when nothing was cut');
  });

  test('records_outstanding is a labeled cross-check, never the headline; null is never zero', () => {
    const csv = buildFinalCloseoutCsv({ kind: 'final', record: record(), generatedAt: NOW });
    assert.ok(csv.includes('Audit cross-check (includes Excluded — not the headline)'));
    assert.ok(csv.includes('total 5'));
    assert.ok(csv.includes('Payable not paid,2'), 'headline stays the stored unpaid count');

    const noRo = buildFinalCloseoutCsv({
      kind: 'final',
      record: record({ records_outstanding: null }),
      generatedAt: NOW,
    });
    assert.ok(noRo.includes('disbursement_records cross-check: unavailable'));
    assert.ok(!/cross-check.*\b0\b/.test(noRo.split('\r\n').find((l) => l.includes('cross-check')) ?? ''));
  });

  test('unpaid section is the stored payees exactly — nothing added, nothing dropped', () => {
    const csv = buildFinalCloseoutCsv({ kind: 'final', record: record(), generatedAt: NOW });
    const start = csv.indexOf('PAYABLE, NOT PAID');
    const end = csv.indexOf('Audit cross-check');
    const section = csv.slice(start, end);
    const dataLines = section
      .split('\r\n')
      .filter((l) => l.includes('@simple.biz'));
    assert.equal(dataLines.length, record().unpaid.payees.length);
    assert.ok(section.includes('maria@simple.biz'));
    assert.ok(section.includes('Held · threshold'));
  });

  test('null marker amounts render blank, never 0.00', () => {
    const csv = buildFinalCloseoutCsv({ kind: 'final', record: record(), generatedAt: NOW });
    const jose = csv.split('\r\n').find((l) => l.includes('jose@simple.biz'));
    assert.ok(jose, 'jose row exists');
    assert.ok(jose!.endsWith(',,'), `null amounts stay blank: ${jose}`);
    assert.ok(!jose!.includes('0.00'));
  });

  test('processor section is sum-preserving: every known rail plus stray keys', () => {
    const r = record({
      byProcessor: {
        hurupay: { count: 1, usd: 700, php: 39200 },
        unknown: { count: 1, usd: 400, php: 22400 },
        paymaya: { count: 2, usd: 200, php: 11200 },
      },
      paid: {
        payeeCount: 4, employeeCount: 4, contractorCount: 0,
        dispatchCount: 4, paidUSD: 1300, paidPHP: 72800,
      },
    });
    const csv = buildFinalCloseoutCsv({ kind: 'final', record: r, generatedAt: NOW });
    const start = csv.indexOf('PAID BY PROCESSOR');
    const end = csv.indexOf('PAYABLE, NOT PAID');
    const section = csv.slice(start, end);
    for (const rail of ['hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires', 'unknown', 'paymaya']) {
      assert.ok(section.includes(rail), `${rail} row present`);
    }
    // The section's USD cells sum to the frozen paid headline.
    const usdSum = section
      .split('\r\n')
      .slice(2) // skip section title + column header
      .filter((l) => l.trim().length > 0)
      .reduce((sum, l) => sum + (parseFloat(l.split(',')[2] ?? '0') || 0), 0);
    assert.equal(usdSum, r.paid.paidUSD);
  });

  test('CSV formula injection is neutralized on text cells, not on negative money', () => {
    const r = record();
    r.unpaid.payees[0]!.name = '=HYPERLINK("http://evil","click")';
    r.unpaid.payees[1]!.amountUSD = -25;
    r.unpaid.payees[1]!.amountPHP = -1400;
    const csv = buildFinalCloseoutCsv({ kind: 'final', record: r, generatedAt: NOW });
    assert.ok(!/,=HYPERLINK/.test(csv), 'no cell begins with a live formula');
    assert.ok(csv.includes(`"'=HYPERLINK`), 'the name is prefixed inert (and RFC-quoted)');
    const jose = csv.split('\r\n').find((l) => l.includes('jose@simple.biz'));
    assert.ok(jose!.includes('-25.00'), 'negative amounts are not mangled by neutralization');
  });

  test('encoding: BOM + CRLF + RFC 4180 quoting + ungrouped money', () => {
    const r = record();
    r.unpaid.payees[0]!.name = 'O\'Brien, "Max"';
    r.unpaid.payees[0]!.amountPHP = 6999.99;
    const csv = buildFinalCloseoutCsv({ kind: 'final', record: r, generatedAt: NOW });
    assert.equal(csv.charCodeAt(0), 0xfeff, 'starts with the BOM');
    assert.ok(csv.includes('\r\n'));
    assert.ok(csv.includes('"O\'Brien, ""Max"""'), 'comma/quote name is RFC-4180 escaped');
    assert.ok(csv.includes('6999.99'));
    assert.ok(!csv.includes('6,999.99'), 'money is never digit-grouped in the body');
  });
});

// ── PII: bank details are last-4 only, SWIFT never enters ────────────────────

describe('PII projection', () => {
  test('maskAccountLast4', () => {
    assert.equal(maskAccountLast4('001234567890'), '···7890');
    assert.equal(maskAccountLast4('12-34'), '···1234');
    assert.equal(maskAccountLast4(''), null);
    assert.equal(maskAccountLast4(null), null);
    assert.equal(maskAccountLast4('no digits'), null);
  });

  test('neither artifact ever contains a full account number or SWIFT code', () => {
    const rows = [dispatch()];
    const csv = buildFinalCloseoutCsv({
      kind: 'final',
      record: record(),
      livePaidRows: projectPaidDetailRows(rows),
      generatedAt: NOW,
    });
    assert.ok(!csv.includes('001234567890'));
    assert.ok(!csv.includes('BNORPHMM'));
    assert.ok(csv.includes('···7890'));

    const wb = buildPrematureSnapshotWorkbook(prematureModel());
    const flat = JSON.stringify(sheetAoa(wb, 'Paid — live'));
    assert.ok(!flat.includes('001234567890'));
    assert.ok(!flat.includes('BNORPHMM'));
    assert.ok(flat.includes('···7890'));
  });
});

// ── Paid projection: superseded markers can never double-count ───────────────

describe('projectPaidDetailRows', () => {
  test('filters to status===paid — marker rows contribute nothing', () => {
    const rows = projectPaidDetailRows([
      dispatch({ id: 'marker', status: 'not_paid', amount_usd: 999 }),
      dispatch({ id: 'real', amount_usd: 100 }),
      dispatch({ id: 'held', status: 'threshold', recipient_email: 'x@simple.biz', amount_usd: 500 }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.amountUSD, 100);
    const sum = rows.reduce((t, r) => t + (r.amountUSD ?? 0), 0);
    assert.equal(sum, 100, 'a sheet built from this cannot exceed the paid-only sum');
  });
});

// ── PREMATURE: stamped on every sheet, live grouping is lossless ─────────────

describe('premature snapshot workbook', () => {
  test('every sheet leads with the NOT YET CLOSED banner; summary carries STATUS', () => {
    const wb = buildPrematureSnapshotWorkbook(prematureModel());
    assert.deepEqual(wb.SheetNames, ['Summary', 'Unpaid (payable)', 'Paid — live']);
    for (const name of wb.SheetNames) {
      const aoa = sheetAoa(wb, name);
      assert.ok(
        String(aoa[0]?.[0] ?? '').includes('NOT YET CLOSED — PREMATURE SNAPSHOT'),
        `${name} banner row`,
      );
    }
    const summary = JSON.stringify(sheetAoa(wb, 'Summary'));
    assert.ok(summary.includes('STATUS: NOT YET CLOSED'));
    assert.ok(!summary.includes('FINAL'), 'a premature file never claims finality');
  });

  test('processor grouping uses the raw rail string — null lands in unknown, sums hold', () => {
    const model = prematureModel({
      paidRows: projectPaidDetailRows([
        dispatch({ id: 'a', amount_usd: 100, amount_php: 5600 }),
        dispatch({ id: 'b', processor: null as unknown as string, recipient_email: 'b@simple.biz', amount_usd: 50, amount_php: 2800 }),
        dispatch({ id: 'c', processor: 'paymaya', recipient_email: 'c@simple.biz', amount_usd: 25, amount_php: 1400 }),
      ]),
      distinctPaidCount: 3,
    });
    const aoa = sheetAoa(buildPrematureSnapshotWorkbook(model), 'Summary');
    const flat = aoa.map((r) => r.map((c) => String(c ?? '')).join('|')).join('\n');
    assert.ok(flat.includes('unknown'), 'null processor is not dropped');
    assert.ok(flat.includes('paymaya'), 'stray rails are not dropped');
    // Sum of the processor rows equals the live paid headline.
    const headerIdx = aoa.findIndex((r) => r[0] === 'Processor');
    const usdSum = aoa
      .slice(headerIdx + 1)
      .reduce((sum, r) => sum + (typeof r[2] === 'number' ? r[2] : 0), 0);
    const headline = aoa.find((r) => r[0] === 'Paid USD (live)');
    assert.equal(usdSum, headline?.[1]);
  });

  test('amount provenance survives: a recomputed figure is labeled, never laundered', () => {
    const aoa = sheetAoa(buildPrematureSnapshotWorkbook(prematureModel()), 'Unpaid (payable)');
    const header = aoa[1] as string[];
    assert.equal(header[header.length - 1], 'Amount Source');
    const maria = aoa.find((r) => r[1] === 'maria@simple.biz');
    assert.equal(maria?.[header.length - 1], 'RECOMPUTED — not the wizard');
  });

  test('money cells are raw numbers (Excel can sum); names stay strings', () => {
    const wb = buildPrematureSnapshotWorkbook(prematureModel());
    const ws = wb.Sheets['Paid — live']!;
    const aoa = sheetAoa(wb, 'Paid — live');
    const row = aoa.findIndex((r) => r[1] === 'juan@simple.biz');
    assert.ok(row > 1);
    const usdCell = ws[XLSX.utils.encode_cell({ r: row, c: 4 })];
    const nameCell = ws[XLSX.utils.encode_cell({ r: row, c: 0 })];
    assert.equal(usdCell?.t, 'n', 'amount is a numeric cell');
    assert.equal(nameCell?.t, 's', 'name is a string cell, never a formula');
  });

  test('null amounts stay blank cells, never 0', () => {
    const model = prematureModel({
      unpaid: [
        {
          name: 'Jose Cruz', email: 'jose@simple.biz', payeeType: 'employee',
          reason: 'threshold', amountUSD: null, amountPHP: null, processor: null,
          amountSource: null,
        },
      ],
    });
    const aoa = sheetAoa(buildPrematureSnapshotWorkbook(model), 'Unpaid (payable)');
    const jose = aoa.find((r) => r[1] === 'jose@simple.biz');
    assert.equal(jose?.[5], null);
    assert.equal(jose?.[6], null);
  });
});

// ── Module purity: no IO can smuggle a 1000-row truncation or a write in ─────

describe('module boundary', () => {
  test('the builder module performs no fetch and imports no supabase client', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./cycle-close-report-export.ts', import.meta.url)),
      'utf-8',
    );
    // Type-only imports are fine; a CLIENT would let a fresh (and silently
    // 1000-row-capped) read sneak into the builder.
    assert.ok(!src.includes('@/lib/supabase/server'), 'no supabase server client');
    assert.ok(!src.includes('createSupabase'), 'no supabase client constructor');
    assert.ok(!src.includes("from '@supabase"), 'no raw supabase-js import');
    assert.ok(!/\bfetch\s*\(/.test(src), 'no fetch call');
  });
});
