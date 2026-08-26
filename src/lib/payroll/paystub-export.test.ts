/**
 * Pay Stubs export — the department the document header names.
 *
 * RULE (Kane, 2026-08-26): *"when someone exports their PDF Paystubs whether
 * approved by accounting or not it should have the latest Department"*. A pay
 * record is frozen in its MONEY; the person's department is a fact about them,
 * not about the week, and a transfer moves the label the moment it is released
 * (`department-transfers.md` §2). So the header names TODAY's department on
 * every exported week — paid, staged, or reconstructed — while the per-week
 * "Department Change" column keeps explaining the in-week moves.
 *
 * These tests pin the resolution and the rendered header string. The PDF is
 * drawn glyph-by-glyph (no extractable text layer), so the PDF side is covered
 * through the shared `resolveExportDepartment` + a smoke build; the XLSX banner
 * cell is asserted verbatim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  resolveExportDepartment,
  buildPayStubsWorkbook,
  generatePayStubsPdf,
  type PayStubWeek,
} from './paystub-export';
import type { PayStubView } from './paystub-view';

const AT = new Date('2026-08-26T04:00:00Z');

function view(over: Partial<PayStubView> = {}): PayStubView {
  return {
    name: 'Jean Auditor',
    department: 'Client - VA',
    departmentTransfer: null,
    weekStart: '2026-08-16',
    weekEnd: '2026-08-22',
    weekHuman: 'Aug 16 - 22, 2026',
    salaryDate: null,
    mfHours: 40,
    mfOtHours: 0,
    mfRate: 175,
    otRate: 0,
    mfPay: 7000,
    otPay: 0,
    hasWeekend: false,
    weekendHours: 0,
    weekendOtHours: 0,
    weekendPay: 0,
    weekendOtPay: 0,
    weekendBasis: [],
    techBonus: 0,
    attendanceBonus: 0,
    performanceBonus: 0,
    adjustment: 0,
    adjustmentNote: null,
    orphanagePay: 0,
    mesaDeduction: 0,
    mesaDisbursement: 0,
    totalPayPhp: 7000,
    fxRate: 58,
    totalPayUsd: 120.69,
    ...over,
  } as PayStubView;
}

function week(over: Partial<PayStubWeek> = {}, viewOver: Partial<PayStubView> = {}): PayStubWeek {
  return {
    sourceFile: 'simple-biz_daily_report_2026-08-16_to_2026-08-22.csv',
    paidAt: '2026-08-25',
    status: 'paid',
    view: view(viewOver),
    ...over,
  };
}

// ── resolveExportDepartment ────────────────────────────────────────────────

test('the CURRENT department wins over the week\'s frozen one — on a PAID week', () => {
  const d = resolveExportDepartment('hsl:filing_specialist', [week()]);
  assert.deepEqual(d, { raw: 'hsl:filing_specialist', current: true });
});

test('the current department wins on an UNPAID staged week too', () => {
  const d = resolveExportDepartment('Lead Gen', [week({ paidAt: null, status: 'issued' })]);
  assert.deepEqual(d, { raw: 'Lead Gen', current: true });
});

test('no current department (off-boarded: no active master row) falls back to the NEWEST week, unmarked', () => {
  const weeks = [
    week({ sourceFile: 'older.csv' }, { department: 'Lead Gen', weekStart: '2026-07-05', weekEnd: '2026-07-11' }),
    week({ sourceFile: 'newer.csv' }, { department: 'Client - VA', weekStart: '2026-08-16', weekEnd: '2026-08-22' }),
  ];
  assert.deepEqual(resolveExportDepartment(null, weeks), { raw: 'Client - VA', current: false });
  // Order of the input array must not decide it — the newest WEEK does.
  assert.deepEqual(resolveExportDepartment(null, [...weeks].reverse()), {
    raw: 'Client - VA',
    current: false,
  });
});

test('a blank or placeholder department is not a department', () => {
  assert.equal(resolveExportDepartment('   ', [week({}, { department: '—' })]), null);
  assert.equal(resolveExportDepartment('—', [week({}, { department: '' })]), null);
  assert.deepEqual(resolveExportDepartment('—', [week({}, { department: 'Lead Gen' })]), {
    raw: 'Lead Gen',
    current: false,
  });
});

// ── The rendered header ────────────────────────────────────────────────────

function bannerCell(weeks: PayStubWeek[], department: string | null): string {
  const wb = buildPayStubsWorkbook(weeks, { employeeName: 'Jean Auditor', department }, AT);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }) as unknown[][];
  const line = rows.find((r) => typeof r[0] === 'string' && r[0].startsWith('Employee:'));
  assert.ok(line, 'banner row missing');
  return String(line[0]);
}

test('XLSX header prints the current department through formatDeptLabel, marked "(current)"', () => {
  assert.equal(
    bannerCell([week()], 'hsl:filing_specialist'),
    'Employee: Jean Auditor · HSL — Filing Specialist (current)',
  );
});

test('a raw hsl:* key can never reach the header', () => {
  assert.ok(!bannerCell([week()], 'hsl:intake_specialist').includes('hsl:'));
});

test('the fallback department is NOT labelled current', () => {
  const cell = bannerCell([week()], null);
  assert.equal(cell, 'Employee: Jean Auditor · Client - VA');
  assert.ok(!cell.includes('(current)'));
});

test('no department anywhere → the header is just the name', () => {
  assert.equal(bannerCell([week({}, { department: '—' })], null), 'Employee: Jean Auditor');
});

// ── Regression pins for what must NOT change ───────────────────────────────

test('the Department Change column still carries the in-week transfer', () => {
  const weeks = [
    week({}, {
      departmentTransfer: {
        label: 'Client VA to Lead Gen',
        legs: [{ from: 'Client VA', to: 'Lead Gen', effective_date: '2026-08-19' }],
      },
    } as Partial<PayStubView>),
  ];
  const wb = buildPayStubsWorkbook(weeks, { employeeName: 'Jean Auditor', department: 'Lead Gen' }, AT);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }) as unknown[][];
  const header = rows.find((r) => r.includes('Department Change'));
  assert.ok(header, 'Department Change column missing');
  const idx = header.indexOf('Department Change');
  assert.equal(rows[rows.indexOf(header) + 1]?.[idx], 'Client VA to Lead Gen');
});

test('the PDF builds with a current department and with none', async () => {
  const withDept = await generatePayStubsPdf([week()], { employeeName: 'Jean Auditor', department: 'hsl:filing_specialist' }, AT);
  const without = await generatePayStubsPdf([week()], { employeeName: 'Jean Auditor', department: null }, AT);
  assert.ok(withDept.byteLength > 0 && without.byteLength > 0);
});
