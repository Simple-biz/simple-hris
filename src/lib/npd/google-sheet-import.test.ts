import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { NPD_COLUMNS, type NpdSheetKind } from './columns';
import { formatSheetNumber, recomputeSheet } from './formulas';
import { validateSaveBody } from './sheet';
import {
  GOOGLE_SHEET_TABS,
  SHEET_FORMULA_PATTERNS,
  buildNpdImport,
  genericFormula,
  parseSheetWeekLabel,
  sheetCellText,
  type GoogleSheetGrids,
} from './google-sheet-import';

// The two tabs' header rows at their REAL positions (read 2026-10-02; header text
// only). The formula patterns name the sheet's own letters, so positions matter.
const ALL_DEPT_HEADER: Record<number, string> = {
  0: 'Phone Number', 1: 'Work Email', 2: 'Personal Email', 21: '  Name', 23: 'Department',
  24: 'Bank Needs Update', 25: 'MESA\nParticipant', 26: 'Position', 27: 'Week',
  28: 'Regular \nTotal\nHours', 29: 'Regular \nRate', 30: 'OT \nTotal\nHours', 31: 'OT \nRate',
  32: 'Hours Until OT', 33: 'Orphan Total Hours', 34: 'Orphan Hours Total Pay',
  35: 'Mid-week\nNew \nRate\nTotal\nHours', 36: 'Mid-week\nNew \nHourly \nRate',
  37: 'Notes for hourly \nrate changes', 38: 'Total \nHourly\nPay', 39: 'MESA\nContribution\n(100PHP)',
  40: 'Orphan\npay', 41: 'Tech \nBonus', 42: 'Attendance \nBonus', 43: 'Perfornance \nBonus',
  44: 'Additional\nBonus or\nUS Bonus', 45: 'Notes explaining \nbonuses', 46: 'Total Pay\nPHP',
  47: '\nPHP\nUSD\nConversoin', 48: 'Total Pay\nUS\nWorkers', 49: 'Bank preferred',
  50: 'Last 4 of\npreferred\nacct #', 51: 'Sending\nbank used', 52: 'Pay status', 60: 'HRIS', 61: 'HRIS NOTES',
};
const HOGAN_HEADER: Record<number, string> = {
  0: 'Phone Number', 1: 'Work Email', 19: 'Name', 21: 'Department', 22: 'Bank\nNeeds\nUpdate',
  23: 'MESA\nParticipant', 24: 'Position', 25: 'Week', 26: 'M-F\nTotal Hours', 27: 'M-F\nRate',
  28: 'WE Hours', 29: 'Hogan \nWE \nRate', 30: 'Total OT Hours', 31: 'OT \nDifferential',
  32: 'Hours Until OT', 33: 'Orphan Total Hours', 34: 'Orphan Hours Total Pay',
  35: 'Mid-week\nNew \nRate\nTotal\nHours', 36: 'Mid-week\nTransition\nHourly \nRate',
  37: 'Notes for hourly \nrate changes', 38: 'Total \nHourly\nPay', 39: 'MESA\nContribution\n(100PHP)',
  40: 'Orphan\npay', 41: 'Tech \nBonus', 42: 'Attendance \nBonus', 43: 'Performance \nBonus',
  44: 'Additional\nBonus or\nUS Bonus', 45: 'Notes explaining \nbonuses', 46: 'Total Pay\nPHP',
  47: '\nPHP\nUSD\nConversoin', 48: 'Total Pay\nUS\nWorkers', 49: 'Bank\npreferred',
  50: 'Last 4 of\npreferred\nacct #', 51: 'Pay status ', 53: 'Sending\nbank used', 60: 'HRIS', 61: 'Notes',
};
const WIDTH = 62;

/** A cell as the API gives it three ways: formula text, unformatted value, displayed text. */
type Cell = { f?: string; v?: unknown; d?: string };
const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
const col = (l: string) => {
  for (let i = 0; i < 80; i += 1) if (letter(i) === l) return i;
  throw new Error(l);
};

function grids(header: Record<number, string>, rows: Array<Record<string, Cell>>): GoogleSheetGrids {
  const h = Array.from({ length: WIDTH }, (_, i) => header[i] ?? '');
  const formulas: unknown[][] = [h];
  const values: unknown[][] = [h];
  const formatted: unknown[][] = [h];
  for (const r of rows) {
    const f: unknown[] = [];
    const v: unknown[] = [];
    const d: unknown[] = [];
    for (const [l, c] of Object.entries(r)) {
      const i = col(l);
      const value = c.v ?? '';
      f[i] = c.f ?? value;
      v[i] = value;
      d[i] = c.d ?? (value === '' ? '' : String(value));
    }
    formulas.push(f);
    values.push(v);
    formatted.push(d);
  }
  return { formulas, values, formatted };
}

const at = (sheet: NpdSheetKind, values: readonly string[], key: string) => values[NPD_COLUMNS[sheet].findIndex((c) => c.key === key)];
const WEEK = '2026-09-20';

describe('parseSheetWeekLabel reads the Week cells the sheet types', () => {
  test('every spelling seen in the live tabs', () => {
    for (const label of ['Week 9/20/26 - 9/26/26', 'week 9/20/26 - 9/26/26', 'Week 9/20/26 -9/26/26', 'Week 9/20/2026 – 9/26/2026', '9/20/26-9/26/26']) {
      assert.deepEqual(parseSheetWeekLabel(label), { start: '2026-09-20', end: '2026-09-26' }, label);
    }
    assert.deepEqual(parseSheetWeekLabel('Week 12/27/26 - 1/2/27'), { start: '2026-12-27', end: '2027-01-02' });
  });
  test('anything else is unreadable, never guessed', () => {
    for (const label of ['', 'TBD', 'Week of 9/20', '9/20/26', 'Week 2/30/26 - 3/7/26', 'Week 13/1/26 - 13/7/26']) {
      assert.equal(parseSheetWeekLabel(label), null, label);
    }
  });
});

describe('sheetCellText keeps every digit the sheet holds', () => {
  test('the display text when it reads back exactly', () => {
    assert.equal(sheetCellText('11,304.80', 11304.8), '11,304.80');
    assert.equal(sheetCellText('₱1,234.56', 1234.56), '₱1,234.56');
    assert.equal(sheetCellText('-100.00', -100), '-100.00');
    assert.equal(sheetCellText('260', 260), '260');
  });
  test('the exact number when the display rounds', () => {
    assert.equal(sheetCellText('40.25', 40.2533), '40.2533');
    assert.equal(sheetCellText('$213.49', 213.48618527999997), '213.48618527999997');
    assert.equal(sheetCellText('50%', 0.5), '0.5');
  });
  test('text, booleans, errors and empties', () => {
    assert.equal(sheetCellText('Yes', 'Yes'), 'Yes');
    assert.equal(sheetCellText('TRUE', true), 'TRUE');
    assert.equal(sheetCellText('#N/A', '#N/A (Did not find value in XLOOKUP evaluation.)'), '#N/A');
    assert.equal(sheetCellText(undefined, '#N/A (Did not find value in XLOOKUP evaluation.)'), '#N/A');
    assert.equal(sheetCellText('', ''), '');
    assert.equal(sheetCellText(undefined, undefined), '');
    assert.equal(sheetCellText('Line one\nline two', 'Line one\nline two'), 'Line one\nline two');
  });
});

describe('genericFormula', () => {
  test('replaces this row number only, never part of a constant or another number', () => {
    assert.equal(genericFormula('=AU12*0.0162575', 12), '=AU{r}*0.0162575');
    assert.equal(genericFormula('=IF(AC5<40,(40-AC5),0)', 5), '=IF(AC{r}<40,(40-AC{r}),0)');
    assert.equal(genericFormula('=AD123*1.5', 12), '=AD123*1.5');
  });
  test('the shared patterns cover every default formula column', () => {
    for (const sheet of ['all_departments', 'hsl'] as const) {
      assert.ok(Object.keys(SHEET_FORMULA_PATTERNS[sheet]).length >= 6);
    }
    assert.equal(GOOGLE_SHEET_TABS.all_departments.button, 'All Dept Payroll CSV');
    assert.equal(GOOGLE_SHEET_TABS.hsl.button, 'Hogan Payroll Sync');
    assert.equal(GOOGLE_SHEET_TABS.hsl.title, 'Hogan');
  });
});

/** Row 2 of All Dept: every calculated column is the sheet's standard formula. */
function standardAllDeptRow(n: number, extra: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    B: { v: `person${n}@example.com` },
    V: { v: `Person ${n}` },
    AB: { v: 'Week 9/20/26 - 9/26/26' },
    AC: { v: 40.2533, d: '40.25' },
    AD: { v: 260, d: '260' },
    AE: { v: 2.32, d: '2.32' },
    AF: { f: `=AD${n}*1.5`, v: 390, d: '390.00' },
    AG: { f: `=IF(AC${n}<40,(40-AC${n}),0)`, v: 0, d: '0.00' },
    AI: { f: `=IF(AC${n}>=40,(AH${n}*AF${n}),IF((AH${n}+AC${n})<=40,AH${n}*AD${n},(AG${n}*AD${n})+(AH${n}-AG${n})*AF${n}))`, v: 0, d: '0.00' },
    AM: { f: `=((AC${n}*AD${n})+(AE${n}*AF${n})+(AI${n})+(AJ${n}*AK${n}))`, v: 11370.658, d: '11,370.66' },
    AR: { v: 2100, d: '2,100.00' },
    AU: { f: `=AM${n}+AO${n}+AP${n}+AQ${n}+AR${n}+AS${n}+AN${n}`, v: 13470.658, d: '13,470.66' },
    AV: { f: `=AU${n}*0.0162575`, v: 219.0, d: '$219.00' },
    BI: { v: 'PAID IN HRIS' },
    ...extra,
  };
}

describe('buildNpdImport — All Dept', () => {
  const sheetRows: Array<Record<string, Cell>> = [
    standardAllDeptRow(2),
    // Row 3: OT Rate TYPED (no formula), Hours Until OT blank with no formula, and a
    // USD formula with another week's constant.
    standardAllDeptRow(3, {
      AF: { v: 400, d: '400.00' },
      AG: {},
      AV: { f: '=AU3*0.016', v: 215.53, d: '$215.53' },
    }),
    { B: { v: 'other@example.com' }, AB: { v: 'Week 9/13/26 - 9/19/26' }, AC: { v: 40 } },
    { B: { v: 'noweek@example.com' }, AC: { v: 12 } },
    { A: { v: 'Totals' }, AB: { v: 'TBD' } },
    {},
    standardAllDeptRow(8, { AB: { v: 'week 9/20/26 -9/26/26' } }),
  ];
  const result = buildNpdImport({ sheet: 'all_departments', week: WEEK, tab: 'All Dept', grids: grids(ALL_DEPT_HEADER, sheetRows) });

  test('takes exactly the week’s rows, in sheet order, and counts the rest', () => {
    assert.ok(result.ok, !result.ok ? result.error : '');
    if (!result.ok) return;
    assert.equal(result.rows.length, 3);
    assert.deepEqual(result.rows.map((r) => at('all_departments', r.values, 'work_email')), [
      'person2@example.com',
      'person3@example.com',
      'person8@example.com',
    ]);
    assert.deepEqual(result.rows.map((r) => r.sheetRow), [2, 3, 8]);
    assert.deepEqual(result.summary.skipped, { otherWeek: 1, noWeek: 1, unreadableWeek: 1 });
    assert.deepEqual(result.summary.labels, ['Week 9/20/26 - 9/26/26', 'week 9/20/26 -9/26/26']);
  });

  test('standard formulas are left to NPD; inputs keep every digit', () => {
    if (!result.ok) return;
    const r = result.rows[0]!;
    assert.deepEqual(r.overrides, []);
    for (const key of ['ot_rate', 'hours_until_ot', 'orphan_hours_total_pay', 'total_hourly_pay', 'total_pay_php', 'php_usd_conversion']) {
      assert.equal(at('all_departments', r.values, key), '', key);
    }
    assert.equal(at('all_departments', r.values, 'regular_total_hours'), '40.2533');
    assert.equal(at('all_departments', r.values, 'regular_rate'), '260');
    assert.equal(at('all_departments', r.values, 'performance_bonus'), '2,100.00');
    assert.equal(at('all_departments', r.values, 'name'), 'Person 2');
    assert.equal(at('all_departments', r.values, 'hris'), 'PAID IN HRIS');
  });

  test('the week’s rate is the constant in its USD formulas; another constant keeps its figure typed', () => {
    if (!result.ok) return;
    assert.equal(result.rateText, '0.0162575');
    assert.equal(result.summary.rate, '0.0162575');
    assert.deepEqual(result.summary.otherRates, [{ rate: '0.016', rows: 1 }]);
    const r = result.rows[1]!;
    assert.ok(r.overrides.includes('php_usd_conversion'));
    assert.equal(at('all_departments', r.values, 'php_usd_conversion'), '$215.53');
  });

  test('a typed figure and a blank formula-less cell are typed over, exactly as the sheet has them', () => {
    if (!result.ok) return;
    const r = result.rows[1]!;
    assert.ok(r.overrides.includes('ot_rate'));
    assert.equal(at('all_departments', r.values, 'ot_rate'), '400.00');
    assert.ok(r.overrides.includes('hours_until_ot'));
    assert.equal(at('all_departments', r.values, 'hours_until_ot'), '');
    assert.equal(result.summary.typedCells, 3);
  });

  test('NPD’s formulas then give the sheet’s figures from the exact hours, not the rounded ones', () => {
    if (!result.ok) return;
    const rows = recomputeSheet(
      'all_departments',
      result.rows.map((r, i) => ({ id: String(i), values: r.values, overrides: r.overrides, formulas: {} })),
      { columnFormulas: {}, rate: 0.0162575 },
    );
    const hourly = (40.2533 * 260) + (2.32 * 390) + (0) + (0 * 0);
    assert.equal(at('all_departments', rows[0]!.values, 'total_hourly_pay'), formatSheetNumber(hourly, 'money'));
    const php = hourly + 0 + 0 + 2100 + 0 + 0;
    assert.equal(at('all_departments', rows[0]!.values, 'total_pay_php'), formatSheetNumber(php, 'money'));
    assert.equal(at('all_departments', rows[0]!.values, 'php_usd_conversion'), formatSheetNumber(php * 0.0162575, 'usd'));
    // Row 3: the typed OT rate of 400 is what its Total Hourly Pay reads.
    assert.equal(at('all_departments', rows[1]!.values, 'total_hourly_pay'), formatSheetNumber((40.2533 * 260) + (2.32 * 400) + 0 + (0 * 0), 'money'));
  });
});

describe('buildNpdImport — Hogan', () => {
  test('a standard Hogan row: no typed cells, and NPD reaches the sheet’s Total Pay PHP', () => {
    const n = 2;
    const g = grids(HOGAN_HEADER, [
      {
        B: { v: 'hsl@example.com' },
        T: { v: 'HSL Person' },
        X: { v: 'Yes' },
        Z: { v: 'Week 9/20/26 - 9/26/26' },
        AA: { v: 40.42, d: '40.42' },
        AB: { v: 355, d: '355.00' },
        AC: { v: 0, d: '0.00' },
        AD: { f: `=AB${n}+15`, v: 370, d: '370.00' },
        AE: { f: `=MAX(0,((AA${n}+AC${n})-40))`, v: 0.4200000000000017, d: '0.42' },
        AF: { f: `=AB${n}*0.5`, v: 177.5, d: '177.50' },
        AG: { f: `=MAX(0,IF((AC${n}+AA${n})<40,(40-(AA${n}+AC${n})),0))`, v: 0, d: '0.00' },
        AI: { f: `=IF((AA${n}+AC${n})>=40,AH${n}*(AB${n}+AF${n}),IF((AH${n}+AC${n}+AA${n})<40,AH${n}*AB${n},(AG${n}*AB${n})+(AH${n}-AG${n})*(AB${n}+AF${n})))`, v: 0, d: '0.00' },
        AM: { f: `=((AA${n}*AB${n})+(AC${n}*AD${n}))+(AE${n}*AF${n})+AI${n}+(AJ${n}*AK${n})`, v: 14423.650000000001, d: '14,423.65' },
        AN: { v: -100, d: '-100.00' },
        AU: { f: `=AM${n}+AO${n}+AP${n}+AQ${n}+AR${n}+AS${n}+AN${n}`, v: 14323.650000000001, d: '14,323.65' },
        AV: { f: `=AU${n} * 0.016005`, v: 229.25, d: '$229.25' },
      },
    ]);
    const result = buildNpdImport({ sheet: 'hsl', week: WEEK, tab: 'Hogan', grids: g });
    assert.ok(result.ok, !result.ok ? result.error : '');
    if (!result.ok) return;
    assert.deepEqual(result.rows[0]!.overrides, []);
    assert.equal(result.rateText, '0.016005');
    const [row] = recomputeSheet('hsl', [{ id: 'a', ...result.rows[0]!, formulas: {} }], { columnFormulas: {}, rate: 0.016005 });
    assert.equal(at('hsl', row!.values, 'total_pay_php'), '14,323.65');
    assert.equal(at('hsl', row!.values, 'mesa_contribution'), '-100.00');
    assert.equal(at('hsl', row!.values, 'mesa_participant'), 'Yes');
  });
});

describe('buildNpdImport refuses rather than loading half a sheet', () => {
  test('a missing column is named and nothing is loaded', () => {
    const header = { ...ALL_DEPT_HEADER };
    delete header[29];
    const r = buildNpdImport({ sheet: 'all_departments', week: WEEK, tab: 'All Dept', grids: grids(header, [standardAllDeptRow(2)]) });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'missing_columns');
    assert.match(r.error, /Regular Rate/);
  });
  test('no header row', () => {
    const r = buildNpdImport({ sheet: 'hsl', week: WEEK, tab: 'Hogan', grids: { formulas: [['x']], values: [['x']], formatted: [['x']] } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'no_header');
  });
  test('no rows for the week: says so, and names the newest week the tab has', () => {
    const r = buildNpdImport({ sheet: 'all_departments', week: '2026-09-27', tab: 'All Dept', grids: grids(ALL_DEPT_HEADER, [standardAllDeptRow(2)]) });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'no_rows');
    assert.match(r.error, /Sep 27/);
    assert.match(r.error, /newest week is Sep 20/);
  });
  test('a rate NPD would refuse (≥ 1) is not used: the USD figures stay the sheet’s, typed', () => {
    const r = buildNpdImport({
      sheet: 'all_departments',
      week: WEEK,
      tab: 'All Dept',
      grids: grids(ALL_DEPT_HEADER, [standardAllDeptRow(2, { AV: { f: '=AU2*61.51', v: 828577, d: '$828,577.00' } })]),
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.rateText, '');
    assert.ok(r.rows[0]!.overrides.includes('php_usd_conversion'));
    assert.equal(at('all_departments', r.rows[0]!.values, 'php_usd_conversion'), '$828,577.00');
  });
  test('a tie between two rates goes to the first one in the sheet', () => {
    const r = buildNpdImport({
      sheet: 'all_departments',
      week: WEEK,
      tab: 'All Dept',
      grids: grids(ALL_DEPT_HEADER, [
        standardAllDeptRow(2, { AV: { f: '=AU2*0.0161', v: 1, d: '$1.00' } }),
        standardAllDeptRow(3, { AV: { f: '=AU3*0.0162', v: 1, d: '$1.00' } }),
      ]),
    });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.rateText, '0.0161');
  });
});

describe('the save contract carries a sync, and refuses a malformed one', () => {
  const base = { sheet: 'hsl', week: WEEK, expectedVersion: 0, rows: [] };
  test('no googleSheetSync → null (an ordinary save)', () => {
    const r = validateSaveBody(base);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value.googleSheetSync, null);
  });
  test('a sync names its tab and the wizard upload', () => {
    const r = validateSaveBody({ ...base, googleSheetSync: { tab: ' Hogan ', sourceFile: 'hubstaff_2026-09-20_to_2026-09-26.csv' } });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value.googleSheetSync, { tab: 'Hogan', sourceFile: 'hubstaff_2026-09-20_to_2026-09-26.csv' });
  });
  test('anything else is refused, never coerced', () => {
    for (const bad of [{ tab: '' }, { tab: 7 }, 'Hogan', ['Hogan'], { tab: 'x'.repeat(101) }, { tab: 'Hogan', sourceFile: 5 }]) {
      assert.equal(validateSaveBody({ ...base, googleSheetSync: bad }).ok, false, JSON.stringify(bad).slice(0, 40));
    }
  });
});
