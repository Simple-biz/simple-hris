/**
 * People roster export — the two banking columns added 2026-08-24.
 *
 * The point of these tests is not that the strings render; it is that the three
 * artifacts CANNOT drift from each other or leak a full account number:
 *
 *   - every FLAT_COLUMN carries its own Excel width (no parallel array to skew)
 *   - CSV and XLSX are generated from the SAME column list, so a column added to
 *     one is in the other by construction
 *   - the PDF has its own narrower column set, so its header row is pinned here
 *   - nothing in any artifact is a full account number
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import * as XLSX from 'xlsx';
import {
  buildRosterExport,
  rosterToCsv,
  buildRosterWorkbook,
  generateRosterPdf,
  type RosterExportInput,
} from './people-roster-export';
import { maskAccountLast4 } from '@/lib/payroll/mask-account';
import { resolvePreferredAccountNumber } from '@/lib/employee/payout-completeness';

const FULL_ACCOUNT = '001234567890';

function person(over: Partial<RosterExportInput> = {}): RosterExportInput {
  return {
    employee_id: 'EMP-001',
    name: 'Ada Lovelace',
    department: 'Engineering',
    work_email: 'ada@simple.biz',
    personal_email: 'ada@gmail.com',
    location: 'Cebu',
    start_date: '2025-03-04',
    rate: { regular: 175, ot: 262.5, currency: 'PHP' },
    hours: { thisWeek: 45, ot: 5 },
    processor: 'wires',
    hasBanking: true,
    accountLast4: maskAccountLast4(FULL_ACCOUNT),
    bankUpdatedAt: '2026-08-21T09:30:00.000Z',
    ...over,
  };
}

const model = (rows: RosterExportInput[]) =>
  buildRosterExport({ rows, periodTotal: rows.length, periodLabel: 'Aug 17 - Aug 23, 2026' });

function sheetAoa(wb: XLSX.WorkBook): string[][] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: false }) as string[][];
}

describe('banking columns reach all three formats', () => {
  test('CSV carries the header and the value', () => {
    const csv = rosterToCsv(model([person()]));
    assert.ok(csv.includes('Account No. (last 4)'), 'CSV header');
    assert.ok(csv.includes('Bank Info Updated'), 'CSV header');
    assert.ok(csv.includes('···7890'), 'CSV masked account');
    assert.ok(csv.includes('Aug 21, 2026'), 'CSV formatted change date');
  });

  test('XLSX carries the header and the value', () => {
    const aoa = sheetAoa(buildRosterWorkbook(model([person()])));
    const header = aoa[4];
    assert.ok(header.includes('Account No. (last 4)'), 'XLSX header');
    assert.ok(header.includes('Bank Info Updated'), 'XLSX header');
    const body = aoa[5];
    assert.equal(body[header.indexOf('Account No. (last 4)')], '···7890');
    assert.equal(body[header.indexOf('Bank Info Updated')], 'Aug 21, 2026');
  });

  test('PDF carries both columns and the masked account', async () => {
    const text = await pdfText(model([person()]));
    assert.ok(text.includes('Last 4'), 'PDF account header');
    assert.ok(text.includes('Bank') && text.includes('Updated'), 'PDF change-date header (wraps to two lines)');
    assert.ok(text.includes('7890'), 'PDF masked account digits');
    assert.ok(text.includes('Aug 21, 2026'), 'PDF change date');
  });
});

describe('column list drift', () => {
  test('every PDF column header renders in full, none truncated by its width', async () => {
    // The PDF table has its own narrower column set and its own header renderer.
    // Before 2026-08-24 that renderer drew only the FIRST wrapped line, so a
    // header wider than its column lost the rest with nothing on the page to say
    // so. Pin the whole header row.
    const text = await pdfText(model([person()]));
    // 'Bank Updated' is DELIBERATELY wider than its column and renders as two
    // lines in the header band (11pt once per page, rather than a point off
    // Name on every row) — so assert on the wrapped pieces. Before the fix,
    // 'Updated' was the half that silently disappeared.
    for (const header of ['#', 'ID', 'Name', 'Department', 'Hours', 'OT', 'Rate', 'Payout', 'Last 4', 'Bank', 'Updated']) {
      assert.ok(text.includes(header), 'PDF header "' + header + '"');
    }
  });


  test('CSV and XLSX headers are the same list, in the same order', () => {
    const m = model([person()]);
    const csvHeader = rosterToCsv(m).split('\r\n').find((l) => l.startsWith('#,'));
    assert.ok(csvHeader, 'CSV header row found');
    const xlsxHeader = sheetAoa(buildRosterWorkbook(m))[4];
    // CSV quotes any cell containing a comma; unquote before comparing.
    const csvCells = splitCsvLine(csvHeader);
    assert.deepEqual(csvCells, xlsxHeader);
  });

  test('every column supplies its own Excel width', () => {
    const wb = buildRosterWorkbook(model([person()]));
    const cols = wb.Sheets[wb.SheetNames[0]]['!cols'];
    const header = sheetAoa(wb)[4];
    assert.equal(cols?.length, header.length, 'one width per column incl. the # gutter');
    assert.ok(cols?.every((c) => typeof c.wch === 'number' && (c.wch ?? 0) > 0), 'no undefined widths');
  });
});

describe('PII - last 4 only, never the full number', () => {
  test('no artifact contains the full account number', async () => {
    const m = model([person()]);
    const csv = rosterToCsv(m);
    assert.ok(!csv.includes(FULL_ACCOUNT), 'CSV');
    assert.ok(!JSON.stringify(sheetAoa(buildRosterWorkbook(m))).includes(FULL_ACCOUNT), 'XLSX');
    assert.ok(!(await pdfText(m)).includes(FULL_ACCOUNT), 'PDF');
  });

  test('the mask prefix is WinAnsi-safe, so the PDF renders it verbatim', () => {
    // pdf-lib's Helvetica is WinAnsi; a codepoint outside 32-126 / 160-255 is
    // replaced with '?' by sanitize(). U+00B7 is inside it - keep it that way.
    const mask = maskAccountLast4(FULL_ACCOUNT);
    assert.ok(mask);
    for (const ch of mask.replace(/[0-9]/g, '')) {
      const cp = ch.codePointAt(0) ?? 0;
      assert.ok(
        (cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255),
        'U+' + cp.toString(16) + ' is WinAnsi-safe',
      );
    }
  });

  test('no bank account on file exports as a dash, not an empty mask', () => {
    const csv = rosterToCsv(
      model([person({ accountLast4: null, bankUpdatedAt: null, processor: 'hurupay' })]),
    );
    const row = csv.split('\r\n').find((l) => l.startsWith('1,'));
    assert.ok(row?.includes('-'), 'dash placeholder');
    assert.ok(!row?.includes('·'), 'no empty mask');
  });
});

describe('the exported account is the one Payment Dispatch would pay', () => {
  const ids = (over: Record<string, unknown>) => ({
    account_number: FULL_ACCOUNT,
    alt_account_number: '999888777666',
    ...over,
  });

  test('primary slot (the default) takes the primary account', () => {
    assert.equal(maskAccountLast4(resolvePreferredAccountNumber(ids({}))), '···7890');
    assert.equal(
      maskAccountLast4(resolvePreferredAccountNumber(ids({ preferred_bank_slot: 'primary' }))),
      '···7890',
    );
  });

  test('alternative slot takes the ALT account - 8 such people in production', () => {
    assert.equal(
      maskAccountLast4(resolvePreferredAccountNumber(ids({ preferred_bank_slot: 'alternative' }))),
      '···7666',
    );
  });

  test('the other slot backfills when the preferred one is empty', () => {
    assert.equal(
      maskAccountLast4(
        resolvePreferredAccountNumber(ids({ preferred_bank_slot: 'alternative', alt_account_number: '' })),
      ),
      '···7890',
    );
    assert.equal(
      maskAccountLast4(resolvePreferredAccountNumber(ids({ account_number: null }))),
      '···7666',
    );
  });

  test('a wallet-rail payee with no bank account resolves to nothing, not to a guess', () => {
    assert.equal(resolvePreferredAccountNumber({ hurupay_email: 'ada@kolan.xyz' }), '');
    assert.equal(maskAccountLast4(resolvePreferredAccountNumber(null)), null);
  });
});

/**
 * The drawn text of a generated PDF.
 *
 * Two traps make a naive `bytes.toString().includes(...)` a test that passes no
 * matter what the PDF says — which would quietly neuter the "never leaks a full
 * account number" assertion below:
 *   1. pdf-lib flate-compresses its content streams on save, so inflate first.
 *   2. it writes every drawn string as a HEX literal (`<53696D706C65>`), never
 *      as readable text, so decode those too.
 */
async function pdfText(m: Parameters<typeof generateRosterPdf>[0]): Promise<string> {
  const buf = Buffer.from(await generateRosterPdf(m));
  let raw = '';
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s < 0) break;
    const e = buf.indexOf('endstream', s);
    if (e < 0) break;
    let start = s + 'stream'.length;
    while (buf[start] === 0x0d || buf[start] === 0x0a) start++;
    const chunk = buf.subarray(start, e);
    try {
      raw += zlib.inflateSync(chunk).toString('latin1');
    } catch {
      raw += chunk.toString('latin1'); // an uncompressed stream
    }
    i = e + 'endstream'.length;
  }
  return raw.replace(/<([0-9A-Fa-f]+)>/g, (whole, hex: string) =>
    hex.length % 2 === 0 ? Buffer.from(hex, 'hex').toString('latin1') : whole,
  );
}

/** Minimal RFC-4180 line splitter for the header-parity check. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
