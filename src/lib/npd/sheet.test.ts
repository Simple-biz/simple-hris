import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { NPD_COLUMNS, NPD_SHEETS, normalizeHeaderText } from './columns';
import {
  NPD_MAX_CELL_LENGTH,
  NPD_MAX_ROWS,
  applyPaste,
  blankRow,
  clearRange,
  defaultNpdWeek,
  deleteRows,
  ensureSpareRows,
  fromDbRecord,
  insertRows,
  isBlankRow,
  isSundayIso,
  looksLikeHeaderRow,
  normalizeRange,
  rangeToMatrix,
  removedRows,
  rowForAudit,
  setCell,
  shiftWeek,
  toDbRecords,
  trimTrailingBlankRows,
  validateLockBody,
  validateSaveBody,
  NPD_UNLOCK_REASON_MAX,
  weekLabel,
  type NpdRow,
} from './sheet';

const HSL = NPD_COLUMNS.hsl;
const ALL = NPD_COLUMNS.all_departments;

function ids() {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
}

function rowsOf(width: number, data: string[][], newId = ids()): NpdRow[] {
  return data.map((cells) => {
    const values = Array.from({ length: width }, (_, i) => cells[i] ?? '');
    return { id: newId(), values };
  });
}

// The header rows exactly as Kane pasted them on 2026-10-01 (tabs between cells,
// line breaks inside a cell kept as the sheet holds them).
const PASTED_HSL_HEADERS = [
  'Work Email', 'Name', 'Department', 'MESA\nParticipant', 'Position', 'Week', 'M-F\nTotal Hours',
  'M-F\nRate', 'WE Hours', 'Hogan \nWE \nRate', 'Total OT Hours', 'OT \nDifferential', 'Hours Until OT',
  'Orphan Total Hours', 'Orphan Hours Total Pay', 'Mid-week\nNew \nRate\nTotal\nHours',
  'Mid-week\nTransition\nHourly \nRate', 'Notes for hourly \nrate changes', 'Total \nHourly\nPay',
  'MESA\nContribution\n(100PHP)', 'Tech \nBonus', 'Attendance \nBonus', 'Performance \nBonus',
  'Additional\nBonus or\nUS Bonus', 'Notes explaining \nbonuses', 'Total Pay\nPHP', '\nPHP\nUSD\nConversoin',
  'Total Pay\nUS\nWorkers', 'Bank\npreferred', 'Last 4 of\npreferred\nacct #', 'Sending\nbank used', 'HRIS',
];
const PASTED_ALL_HEADERS = [
  'Work Email', '  Name', 'Department', 'MESA\nParticipant', 'Position', 'Week', 'Regular \nTotal\nHours',
  'Regular \nRate', 'OT \nTotal\nHours', 'OT \nRate', 'Hours Until OT', 'Orphan Total Hours',
  'Orphan Hours Total Pay', 'Mid-week\nNew \nRate\nTotal\nHours', 'Mid-week\nNew \nHourly \nRate',
  'Notes for hourly \nrate changes', 'Total \nHourly\nPay', 'MESA\nContribution\n(100PHP)', 'Tech \nBonus',
  'Attendance \nBonus', 'Perfornance \nBonus', 'Additional\nBonus or\nUS Bonus', 'Notes explaining \nbonuses',
  'Total Pay\nPHP', '\nPHP\nUSD\nConversoin', 'Total Pay\nUS\nWorkers', 'Bank preferred',
  'Last 4 of\npreferred\nacct #', 'Sending\nbank used', 'HRIS',
];

describe('the column registry is the pasted header rows', () => {
  test('HSL has 32 columns and All Departments 30, as the SQL and apply script expect', () => {
    assert.equal(HSL.length, 32);
    assert.equal(ALL.length, 30);
  });

  test('each column matches Kane\'s pasted header, in order (spacing and the two typos aside)', () => {
    const check = (cols: typeof HSL, pasted: string[]) => {
      cols.forEach((col, i) => {
        const names = [col.header, ...(col.headerAliases ?? [])].map(normalizeHeaderText);
        assert.ok(names.includes(normalizeHeaderText(pasted[i]!)), `column ${i + 1}: ${col.key} vs ${JSON.stringify(pasted[i])}`);
      });
    };
    check(HSL, PASTED_HSL_HEADERS);
    check(ALL, PASTED_ALL_HEADERS);
  });

  test('the two header typos are corrected on screen', () => {
    for (const sheet of NPD_SHEETS) {
      const headers = NPD_COLUMNS[sheet].map((c) => c.header).join(' ');
      assert.doesNotMatch(headers, /Conversoin|Perfornance/);
    }
  });

  test('keys are unique per sheet and every key is a column in the SQL row table', () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'references', 'sql', 'create', '2026-10-01_npd_sheets.sql'),
      'utf8',
    );
    const tableBody = (name: string) => {
      const start = sql.indexOf(`create table if not exists public.${name} (`);
      assert.ok(start >= 0, `${name} is created`);
      return sql.slice(start, sql.indexOf('\n);', start));
    };
    for (const [sheet, table] of [['hsl', 'npd_hsl_rows'], ['all_departments', 'npd_all_departments_rows']] as const) {
      const keys = NPD_COLUMNS[sheet].map((c) => c.key);
      assert.equal(new Set(keys).size, keys.length, `${sheet} keys unique`);
      const body = tableBody(table);
      const sqlCols = [...body.matchAll(/^\s{2}([a-z0-9_]+)\s+text,?\s*$/gm)].map((m) => m[1]);
      // `sheet` is the discriminator column, not a cell.
      assert.deepEqual(sqlCols.filter((c) => c !== 'sheet'), keys, `${table} columns are the registry, in order`);
      // And the save function inserts every one of them.
      const fnInsert = sql.slice(sql.indexOf(`insert into public.${table} (`));
      for (const k of keys) assert.match(fnInsert.slice(0, 2000), new RegExp(`\\b${k}\\b`), `${table} insert names ${k}`);
    }
  });
});

describe('header-row detection', () => {
  test('Kane\'s pasted header rows are recognised as headers', () => {
    assert.ok(looksLikeHeaderRow(PASTED_HSL_HEADERS, HSL));
    assert.ok(looksLikeHeaderRow(PASTED_ALL_HEADERS, ALL));
  });

  test('a slice of the header copied from the middle is still a header', () => {
    assert.ok(looksLikeHeaderRow(['Tech \nBonus', 'Attendance \nBonus', 'Perfornance \nBonus'], ALL));
  });

  test('a data row is not a header, even with one header-looking cell', () => {
    assert.equal(looksLikeHeaderRow(['jane@simple.biz', 'Jane Cruz', 'HSL', 'Yes', 'Agent', 'HRIS'], HSL), false);
    assert.equal(looksLikeHeaderRow(['Week'], HSL), false);
    assert.equal(looksLikeHeaderRow(['', '', ''], HSL), false);
  });
});

describe('applyPaste', () => {
  test('fills right and down from the anchor and adds rows as needed', () => {
    const rows = rowsOf(4, [['a']]);
    const cols = HSL.slice(0, 4);
    const out = applyPaste(rows, { row: 0, col: 1 }, [['x', 'y'], ['z', 'w']], cols, ids())!;
    assert.deepEqual(out.rows.map((r) => r.values), [
      ['a', 'x', 'y', ''],
      ['', 'z', 'w', ''],
    ]);
    assert.equal(out.addedRows, 1);
    assert.deepEqual(out.range, { r0: 0, c0: 1, r1: 1, c1: 2 });
  });

  test('a pasted header row is skipped and reported', () => {
    const out = applyPaste([], { row: 0, col: 0 }, [PASTED_HSL_HEADERS, ['jane@simple.biz', 'Jane']], HSL, ids())!;
    assert.equal(out.headerSkipped, true);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]!.values[0], 'jane@simple.biz');
  });

  test('a paste that was only the header changes nothing but says so', () => {
    const rows = rowsOf(HSL.length, [['keep']]);
    const out = applyPaste(rows, { row: 0, col: 0 }, [PASTED_HSL_HEADERS], HSL, ids())!;
    assert.equal(out.headerSkipped, true);
    assert.deepEqual(out.rows.map((r) => r.values[0]), ['keep']);
  });

  test('cells past the last column are dropped and counted, never wrapped', () => {
    const cols = HSL.slice(0, 3);
    const out = applyPaste(rowsOf(3, [[]]), { row: 0, col: 1 }, [['b', 'c', 'X', 'Y'], ['b2']], cols, ids())!;
    assert.deepEqual(out.rows[0]!.values, ['', 'b', 'c']);
    assert.equal(out.droppedColumns, 2);
  });

  test('values are pasted verbatim', () => {
    const cols = HSL.slice(0, 3);
    const out = applyPaste([], { row: 0, col: 0 }, [['₱1,234.56', '  spaced  ', 'line\nbreak']], cols, ids())!;
    assert.deepEqual(out.rows[0]!.values, ['₱1,234.56', '  spaced  ', 'line\nbreak']);
  });

  test('a single copied cell fills a multi-cell selection', () => {
    const cols = HSL.slice(0, 3);
    const rows = rowsOf(3, [[], [], []]);
    const out = applyPaste(rows, { row: 0, col: 0 }, [['Yes']], cols, ids(), { r0: 0, c0: 1, r1: 2, c1: 2 })!;
    assert.deepEqual(out.rows.map((r) => r.values), [
      ['', 'Yes', 'Yes'],
      ['', 'Yes', 'Yes'],
      ['', 'Yes', 'Yes'],
    ]);
  });

  test('rows past the cap are dropped and counted', () => {
    const cols = HSL.slice(0, 1);
    const matrix = Array.from({ length: 5 }, (_, i) => [`r${i}`]);
    const out = applyPaste([], { row: NPD_MAX_ROWS - 2, col: 0 }, matrix, cols, ids())!;
    assert.equal(out.droppedRows, 3);
    assert.equal(out.rows.length, NPD_MAX_ROWS);
  });

  test('NUL is stripped and an over-long cell is clipped and counted', () => {
    const cols = HSL.slice(0, 2);
    const out = applyPaste([], { row: 0, col: 0 }, [['a\u0000b', 'x'.repeat(NPD_MAX_CELL_LENGTH + 5)]], cols, ids())!;
    assert.equal(out.rows[0]!.values[0], 'ab');
    assert.equal(out.rows[0]!.values[1]!.length, NPD_MAX_CELL_LENGTH);
    assert.equal(out.clippedCells, 1);
  });

  test('an empty paste returns null', () => {
    assert.equal(applyPaste([], { row: 0, col: 0 }, [], HSL, ids()), null);
  });

  test('rows the paste did not touch keep their identity (memoised grid rows do not re-render)', () => {
    const rows = rowsOf(2, [['a'], ['b'], ['c']]);
    const out = applyPaste(rows, { row: 1, col: 0 }, [['B']], HSL.slice(0, 2), ids())!;
    assert.equal(out.rows[0], rows[0]);
    assert.equal(out.rows[2], rows[2]);
    assert.notEqual(out.rows[1], rows[1]);
    assert.equal(out.rows[1]!.id, rows[1]!.id, 'the edited row keeps its id');
  });
});

describe('row operations', () => {
  test('setCell replaces one cell and keeps the row id', () => {
    const rows = rowsOf(2, [['a', 'b']]);
    const out = setCell(rows, { row: 0, col: 1 }, 'B');
    assert.deepEqual(out[0]!.values, ['a', 'B']);
    assert.equal(out[0]!.id, rows[0]!.id);
  });

  test('clearRange empties exactly the range', () => {
    const rows = rowsOf(3, [['a', 'b', 'c'], ['d', 'e', 'f']]);
    const out = clearRange(rows, normalizeRange({ row: 1, col: 2 }, { row: 0, col: 1 }));
    assert.deepEqual(out.map((r) => r.values), [['a', '', ''], ['d', '', '']]);
  });

  test('insertRows and deleteRows', () => {
    const rows = rowsOf(1, [['a'], ['b']]);
    const ins = insertRows(rows, 1, 2, 1, ids());
    assert.deepEqual(ins.map((r) => r.values[0]), ['a', '', '', 'b']);
    assert.deepEqual(deleteRows(ins, 2, 1).map((r) => r.values[0]), ['a', 'b']);
  });

  test('rangeToMatrix copies the selected cells', () => {
    const rows = rowsOf(3, [['a', 'b', 'c'], ['d', 'e', 'f']]);
    assert.deepEqual(rangeToMatrix(rows, { r0: 0, c0: 1, r1: 1, c1: 2 }), [['b', 'c'], ['e', 'f']]);
  });

  test('trailing blank rows are trimmed; a blank row between filled rows stays', () => {
    const rows = rowsOf(2, [['a'], [], ['b'], [], ['  ']]);
    assert.deepEqual(trimTrailingBlankRows(rows).map((r) => r.values[0]), ['a', '', 'b']);
  });

  test('ensureSpareRows leaves exactly N blank rows below the last filled row', () => {
    const newId = ids();
    const rows = rowsOf(2, [['a'], []], newId);
    const out = ensureSpareRows(rows, 2, newId, 3);
    assert.equal(out.length, 4);
    assert.equal(out[1]!.id, rows[1]!.id, 'an existing spare keeps its id');
    assert.ok(out.slice(1).every(isBlankRow));
    const many = ensureSpareRows(rowsOf(1, [['a'], [], [], [], [], []], newId), 1, newId, 2);
    assert.equal(many.length, 3);
  });
});

describe('weeks', () => {
  test('isSundayIso accepts only a real Sunday in YYYY-MM-DD', () => {
    assert.ok(isSundayIso('2026-09-27'));
    assert.equal(isSundayIso('2026-09-28'), false);
    assert.equal(isSundayIso('2026-02-29'), false);
    assert.equal(isSundayIso('2026-9-27'), false);
    assert.equal(isSundayIso(null), false);
  });

  test('the default week is the last COMPLETED Sun–Sat week', () => {
    // Thu 2026-10-01 → this week started Sun 09-27 → payroll runs for 09-20.
    assert.equal(defaultNpdWeek('2026-10-01'), '2026-09-20');
    // On the Sunday itself, the week that just ended.
    assert.equal(defaultNpdWeek('2026-09-27'), '2026-09-20');
    assert.equal(defaultNpdWeek('2026-09-26'), '2026-09-13');
  });

  test('shiftWeek crosses months and years', () => {
    assert.equal(shiftWeek('2026-12-27', 1), '2027-01-03');
    assert.equal(shiftWeek('2026-03-01', -1), '2026-02-22');
  });

  test('weekLabel', () => {
    assert.equal(weekLabel('2026-09-20'), 'Sep 20 – Sep 26, 2026');
    assert.equal(weekLabel('2026-09-27'), 'Sep 27 – Oct 3, 2026');
    assert.equal(weekLabel('2026-12-27'), 'Dec 27, 2026 – Jan 2, 2027');
  });
});

describe('validateSaveBody', () => {
  const good = () => ({
    sheet: 'hsl',
    week: '2026-09-20',
    expectedVersion: 3,
    rows: [
      { id: '00000000-0000-4000-8000-000000000001', values: HSL.map((_, i) => (i === 0 ? 'jane@simple.biz' : '')) },
      { id: '00000000-0000-4000-8000-000000000002', values: HSL.map(() => '') },
    ],
  });

  test('a good body passes, with trailing blank rows trimmed', () => {
    const v = validateSaveBody(good());
    assert.ok(v.ok);
    if (v.ok) assert.equal(v.value.rows.length, 1);
  });

  test('every malformed field is refused, nothing is coerced', () => {
    const bad: Array<[string, (b: ReturnType<typeof good>) => unknown]> = [
      ['unknown sheet', (b) => ({ ...b, sheet: 'payroll' })],
      ['a Monday', (b) => ({ ...b, week: '2026-09-21' })],
      ['a string version', (b) => ({ ...b, expectedVersion: '3' })],
      ['a negative version', (b) => ({ ...b, expectedVersion: -1 })],
      ['rows not an array', (b) => ({ ...b, rows: {} })],
      ['a row without a uuid', (b) => ({ ...b, rows: [{ ...b.rows[0], id: 'row-1' }] })],
      ['a repeated id', (b) => ({ ...b, rows: [b.rows[0], { ...b.rows[1], id: b.rows[0]!.id.toUpperCase() }] })],
      ['a short row', (b) => ({ ...b, rows: [{ ...b.rows[0], values: ['a'] }] })],
      ['a number cell', (b) => ({ ...b, rows: [{ ...b.rows[0], values: HSL.map(() => 5) }] })],
      ['a NUL cell', (b) => ({ ...b, rows: [{ ...b.rows[0], values: HSL.map(() => 'a\u0000') }] })],
      ['an over-long cell', (b) => ({ ...b, rows: [{ ...b.rows[0], values: HSL.map(() => 'x'.repeat(NPD_MAX_CELL_LENGTH + 1)) }] })],
    ];
    for (const [label, mutate] of bad) {
      const v = validateSaveBody(mutate(good()));
      assert.equal(v.ok, false, label);
    }
    assert.equal(validateSaveBody(null).ok, false);
  });

  test('more than the row cap is refused (after trimming trailing blanks)', () => {
    const newId = ids();
    const rows = Array.from({ length: NPD_MAX_ROWS + 1 }, () => ({ id: newId(), values: HSL.map(() => 'x') }));
    assert.equal(validateSaveBody({ ...good(), rows }).ok, false);
  });
});

describe('validateLockBody (Lock in / Unlock)', () => {
  test('a lock carries the saved version the editor is looking at', () => {
    const v = validateLockBody({ action: 'lock', sheet: 'hsl', week: '2026-09-20', expectedVersion: 4 });
    assert.deepEqual(v, { ok: true, value: { action: 'lock', sheet: 'hsl', week: '2026-09-20', expectedVersion: 4 } });
  });

  test('a lock of an unsaved sheet (version 0) or a non-integer version is refused', () => {
    for (const expectedVersion of [0, -1, 1.5, '4', null, undefined]) {
      assert.equal(validateLockBody({ action: 'lock', sheet: 'hsl', week: '2026-09-20', expectedVersion }).ok, false, String(expectedVersion));
    }
  });

  test('an unlock needs a reason: missing, blank or whitespace is refused', () => {
    for (const reason of [undefined, null, '', '   ', 5]) {
      assert.equal(validateLockBody({ action: 'unlock', sheet: 'hsl', week: '2026-09-20', reason }).ok, false, String(reason));
    }
  });

  test('the reason is trimmed and capped', () => {
    const v = validateLockBody({ action: 'unlock', sheet: 'all_departments', week: '2026-09-20', reason: '  Fix Jane\'s OT  ' });
    assert.ok(v.ok && v.value.action === 'unlock' && v.value.reason === "Fix Jane's OT");
    const long = 'x'.repeat(NPD_UNLOCK_REASON_MAX + 1);
    assert.equal(validateLockBody({ action: 'unlock', sheet: 'hsl', week: '2026-09-20', reason: long }).ok, false);
  });

  test('unknown action, sheet or a non-Sunday week is refused', () => {
    assert.equal(validateLockBody({ action: 'freeze', sheet: 'hsl', week: '2026-09-20', expectedVersion: 1 }).ok, false);
    assert.equal(validateLockBody({ action: 'lock', sheet: 'payroll', week: '2026-09-20', expectedVersion: 1 }).ok, false);
    assert.equal(validateLockBody({ action: 'lock', sheet: 'hsl', week: '2026-09-21', expectedVersion: 1 }).ok, false);
    assert.equal(validateLockBody(null).ok, false);
  });
});

describe('removed rows and records', () => {
  test('removedRows names the filled rows a save drops, by id', () => {
    const newId = ids();
    const before = rowsOf(2, [['a'], ['b'], []], newId);
    const after = [before[1]!];
    assert.deepEqual(removedRows(before, after).map((r) => r.values[0]), ['a']);
  });

  test('toDbRecords: row_no is the 1-based position and "" is NULL', () => {
    const rows = rowsOf(HSL.length, [['jane@simple.biz', '', 'HSL']]);
    const [rec] = toDbRecords('hsl', rows);
    assert.equal(rec!.row_no, 1);
    assert.equal(rec!.work_email, 'jane@simple.biz');
    assert.equal(rec!.name, null);
    assert.equal(rec!.department, 'HSL');
    assert.equal(Object.keys(rec!).length, HSL.length + 2);
  });

  test('fromDbRecord reads NULL back as an empty cell', () => {
    const row = fromDbRecord('all_departments', { id: 'x', work_email: 'a@simple.biz', regular_rate: null });
    assert.equal(row.values.length, ALL.length);
    assert.equal(row.values[0], 'a@simple.biz');
    assert.equal(row.values[7], '');
  });

  test('rowForAudit carries only the filled cells', () => {
    const row = blankRow('x', HSL.length);
    const filled = { ...row, values: row.values.map((_, i) => (i === 0 ? 'jane@simple.biz' : '')) };
    assert.deepEqual(rowForAudit('hsl', filled), { work_email: 'jane@simple.biz' });
  });
});
