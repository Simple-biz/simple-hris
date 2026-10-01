/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/sheet-import.test.ts
 *
 * Fixtures copy the SHAPES measured on Carla's sheet on 2026-10-01 (summary rows above the log
 * header, a "Holiday" placeholder, CAD amounts, a History week pasted one column off its header, a
 * week whose pasted figure is the sheet's own formula bug, a week listed twice). The names are
 * made up: the repo is public.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_BLOCKS,
  parseArchiveTab,
  parseCollectionLog,
  parseHistoryBlock,
  parseUsDate,
  resolveRowLabel,
  type Cell,
  type HistoryBlockSpec,
} from './sheet-import';

const spec = (section: string): HistoryBlockSpec => {
  const s = HISTORY_BLOCKS.find((b) => b.section === section);
  if (!s) throw new Error(section);
  return s;
};

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test('parseUsDate reads the log (4-digit) and History (2-digit) forms, and refuses non-dates', () => {
  assert.equal(parseUsDate('09/28/2026'), '2026-09-28');
  assert.equal(parseUsDate('9/2/2026'), '2026-09-02');
  assert.equal(parseUsDate('9/28/26', true), '2026-09-28');
  assert.equal(parseUsDate('9/28/26'), null);
  assert.equal(parseUsDate('02/30/2026'), null);
  assert.equal(parseUsDate('Total'), null);
  assert.equal(parseUsDate(45000), null);
});

// ---------------------------------------------------------------------------
// Collection Count
// ---------------------------------------------------------------------------

const LOG: Cell[][] = [
  ['', '', '', 'THIS IS FOR', '12/30/2024'],
  ['', '', '', 'ALL TIME #', '10/1/2026'],
  ['Date', 'Rep', 'Business Name', 'Points', 'Amount Collected'],
  [],
  ['10/01/2026'], // pre-dated blank line
  ['09/29/2026', 'Avery', 'Acme Roofing', '1', '$1,234.50'],
  ['09/29/2026', 'Avery', 'Acme Roofing (TU)', '2', '$44.00'],
  ['09/29/2026', 'Blake', 'Trailing Space Co ', '1', '$94.00'],
  ['09/28/2026', 'Blake', 'Maple Clinic', '1', 'CAD154'],
  ['09/28/2026', 'Blake', 'Pine Clinic', '1'], // no amount typed
  ['09/28/2026', 'Blake', 'Zero Point Co', '0', '$12.00'], // a real line worth 0
  ['09/27/2026', 'Blake', 'Sunday Co', '1', '$5.00'], // weekend
  ['09/25/2026', 'Casey', 'Half Point Co', '1.5', '$5.00'],
  ['01/01/2025', 'Casey', 'Holiday', '0', '$0'],
  ['13/01/2025', 'Casey', 'Bad Date Co', '1', '$5.00'],
];

test('parseCollectionLog finds the header below the summary rows and keeps every real line', () => {
  const r = parseCollectionLog(LOG);
  assert.equal(r.headerRow, 3);
  assert.deepEqual(
    r.lines.map((l) => [l.sheetRow, l.date, l.rep, l.businessName, l.points, l.amountUsd]),
    [
      [6, '2026-09-29', 'Avery', 'Acme Roofing', 1, 1234.5],
      [7, '2026-09-29', 'Avery', 'Acme Roofing (TU)', 2, 44],
      [8, '2026-09-29', 'Blake', 'Trailing Space Co', 1, 94],
      [9, '2026-09-28', 'Blake', 'Maple Clinic', 1, null],
      [10, '2026-09-28', 'Blake', 'Pine Clinic', 1, null],
      [11, '2026-09-28', 'Blake', 'Zero Point Co', 0, 12],
    ],
  );
});

test('parseCollectionLog skips what is not a collection, and says why, by sheet row', () => {
  const r = parseCollectionLog(LOG);
  const why = new Map(r.skipped.map((s) => [s.sheetRow, s.reason]));
  assert.match(why.get(5) ?? '', /date with nothing else/);
  assert.match(why.get(12) ?? '', /weekend/);
  assert.match(why.get(13) ?? '', /whole number/);
  assert.match(why.get(14) ?? '', /Holiday/);
  assert.match(why.get(15) ?? '', /not a calendar date/);
  assert.equal(r.skipped.length, 5);
});

test('a CAD amount is dropped from its line, never converted or read as dollars', () => {
  const r = parseCollectionLog(LOG);
  assert.deepEqual(r.amountNotes, [{ sheetRow: 9, typed: 'CAD154', reason: 'not a US dollar amount; imported with no amount' }]);
  assert.deepEqual(parseCollectionLog([LOG[2], ['09/29/2026', 'A', 'B', '1', '$462 CAD']]).amountNotes.length, 1);
});

test('parseCollectionLog refuses a tab without the header', () => {
  assert.throws(() => parseCollectionLog([['Date', 'Who']]), /header/);
});

// ---------------------------------------------------------------------------
// Labels → rows
// ---------------------------------------------------------------------------

const ROWS = [
  { id: 'r1', label: 'Avery', archived: false },
  { id: 'r2', label: 'Blake', archived: true },
  { id: 'r3', label: 'blake', archived: false },
  { id: 'r4', label: 'Dana & Others', archived: false },
  { id: 'r5', label: "Kev's Bucket ", archived: true },
];

test('resolveRowLabel: exact label first, a live row before an archived one', () => {
  assert.equal(resolveRowLabel(' avery ', ROWS)?.id, 'r1');
  assert.equal(resolveRowLabel('Blake', ROWS)?.id, 'r3');
  assert.equal(resolveRowLabel("kev's   bucket", ROWS)?.id, 'r5');
});

test('resolveRowLabel: a name listed in a "&" row belongs to it, only when exactly one row lists it', () => {
  assert.equal(resolveRowLabel('Others', ROWS)?.id, 'r4');
  const two = [...ROWS, { id: 'r6', label: 'Eli & Others', archived: false }];
  assert.equal(resolveRowLabel('Others', two), null);
});

test('resolveRowLabel never merges on similarity', () => {
  assert.equal(resolveRowLabel('Kev', ROWS), null);
  assert.equal(resolveRowLabel('Aver', ROWS), null);
  assert.equal(resolveRowLabel('', ROWS), null);
});

// ---------------------------------------------------------------------------
// History: AM/PM blocks
// ---------------------------------------------------------------------------

/**
 * An inbox-shaped block: title row with AM/PM, a date row, a day-total row, then people.
 * Week 1 (Sep 14–18) sits on its header. Week 2 (Sep 21–25) was pasted ONE COLUMN to the right,
 * as measured on the real tab, so read at the header its AM and PM swap.
 */
function inboxGrid(): { values: Cell[][]; formulas: Cell[][] } {
  const d1 = ['9/14/26', '9/15/26', '9/16/26', '9/17/26', '9/18/26'];
  const d2 = ['9/21/26', '9/22/26', '9/23/26', '9/24/26', '9/25/26'];
  const title: Cell[] = ['Email Inbox'];
  const dates: Cell[] = [''];
  for (const week of [d1, d2]) {
    for (const d of week) {
      title.push('AM', 'PM');
      dates.push(d, d);
    }
    title.push('', '');
    dates.push('Total', 'Prod. ');
  }
  const people: Array<[string, number[], number[]]> = [
    ['Avery', [10, 2, 8, 1, 9, 0, 7, 3, 6, 4], [20, 5, 9, 1, 8, 2, 7, 0, 5, 2]],
    ['Blake', [4, 0, 5, 1, 6, 2, 3, 0, 2, 2], [8, 3, 7, 2, 6, 1, 5, 1, 4, 3]],
    ['Casey', [12, 3, 11, 2, 10, 1, 9, 0, 8, 4], [3, 1, 4, 2, 5, 3, 6, 0, 7, 1]],
    ['Dana', [6, 1, 5, 0, 4, 2, 3, 1, 2, 0], [9, 4, 8, 3, 7, 2, 6, 1, 5, 0]],
    ['Eli', [2, 2, 3, 1, 4, 0, 5, 2, 6, 1], [11, 2, 10, 0, 9, 4, 8, 3, 7, 2]],
    ['Fran', [7, 0, 6, 1, 5, 3, 4, 2, 3, 1], [1, 0, 2, 1, 3, 2, 4, 3, 5, 4]],
  ];
  const avgPm = (xs: number[]) => xs.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0) / 5;
  const values: Cell[][] = [title, dates, ['', 'day totals…']];
  const formulas: Cell[][] = [[], [], []];
  for (const [name, w1, w2] of people) {
    const row: Cell[] = [name, ...w1, avgPm(w1), 10 - avgPm(w1)];
    // Week 2 pasted one column right: an empty cell first, then its ten numbers, then its figure.
    row.push('', ...w2, avgPm(w2));
    values.push(row);
    formulas.push([]);
  }
  values.push(['PM Buckets']); // the next block's title ends this one
  return { values, formulas };
}

test('an AM/PM week on its header is imported cell for cell; a week pasted one column off is skipped', () => {
  const { values, formulas } = inboxGrid();
  const r = parseHistoryBlock(values, formulas, spec('inbox'));
  const [w1, w2] = r.weeks;
  assert.equal(w1.weekStart, '2026-09-13');
  assert.equal(w1.imported, true);
  assert.equal(w1.verified, 6);
  assert.equal(w2.weekStart, '2026-09-20');
  assert.equal(w2.imported, false);
  assert.match(w2.reason ?? '', /reproduce/);
  assert.equal(r.cells.length, 6 * 10);
  assert.ok(r.cells.every((c) => c.date < '2026-09-20'));
  const avery = r.cells.filter((c) => c.label === 'Avery' && c.date === '2026-09-14');
  assert.deepEqual(
    avery.map((c) => [c.slot, c.value]),
    [
      ['am', 10],
      ['pm', 2],
    ],
  );
});

test('a week whose pasted figure is wrong for one row (a sheet formula bug) still imports every row', () => {
  const { values, formulas } = inboxGrid();
  values[3][11] = 99; // Avery's week-1 average, as a mis-referenced formula would show it
  const r = parseHistoryBlock(values, formulas, spec('inbox'));
  assert.equal(r.weeks[0].imported, true);
  assert.deepEqual(r.weeks[0].disagreeing, ['Avery']);
  assert.equal(r.cells.filter((c) => c.label === 'Avery').length, 10);
});

test('a week where most rows disagree is skipped whole, never partly imported', () => {
  const { values, formulas } = inboxGrid();
  for (const i of [3, 4, 5]) values[i][11] = 99;
  const r = parseHistoryBlock(values, formulas, spec('inbox'));
  assert.equal(r.weeks[0].imported, false);
  assert.equal(r.cells.length, 0);
});

test('a "-" in a cell stays absent, and is reported', () => {
  const { values, formulas } = inboxGrid();
  values[8][9] = '-'; // Fran, Friday AM
  const r = parseHistoryBlock(values, formulas, spec('inbox'));
  assert.equal(r.weeks[0].imported, true);
  assert.equal(r.cells.some((c) => c.label === 'Fran' && c.date === '2026-09-18' && c.slot === 'am'), false);
  assert.deepEqual(
    r.skippedCells.map((s) => [s.label, s.date, s.typed, s.reason]),
    [['Fran', '2026-09-18', '-', 'not a number']],
  );
});

// ---------------------------------------------------------------------------
// History: one-number blocks
// ---------------------------------------------------------------------------

/**
 * An onboarding-shaped block: each date heads a two-column pair. Week 1 keeps the number in the
 * first half, week 2 in the second half (both measured on the real tab). The week's Total sits
 * right after Friday's pair, and must never be read as Friday.
 */
function onboardingGrid(): { values: Cell[][]; formulas: Cell[][] } {
  const d1 = ['9/7/26', '9/8/26', '9/9/26', '9/10/26', '9/11/26'];
  const d2 = ['9/14/26', '9/15/26', '9/16/26', '9/17/26', '9/18/26'];
  const header: Cell[] = [''];
  for (const week of [d1, d2]) {
    for (const d of week) header.push(d, '');
    header.push('Total');
  }
  const people: Array<[string, number[], number[]]> = [
    ['Avery', [1, 2, 3, 0, 1], [2, 2, 1, 0, 4]],
    ['Blake', [0, 1, 0, 2, 2], [3, 0, 1, 1, 1]],
    ['Casey', [4, 0, 1, 1, 0], [0, 5, 0, 2, 1]],
    ['Dana', [2, 2, 0, 3, 1], [1, 1, 3, 0, 2]],
    ['Eli', [1, 0, 0, 0, 5], [2, 0, 2, 0, 2]],
    ['Fran', [0, 3, 1, 1, 2], [1, 1, 0, 4, 0]],
  ];
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const values: Cell[][] = [['Customer Sales Onboarding'], header, ['', 'day totals…']];
  for (const [name, w1, w2] of people) {
    const row: Cell[] = [name];
    for (const v of w1) row.push(v, '');
    row.push(sum(w1));
    for (const v of w2) row.push('', v);
    row.push(sum(w2));
    values.push(row);
  }
  values.push(['Email Inbox']);
  return { values, formulas: values.map(() => []) };
}

test('a one-number week is read from either half of its pair, and never from the Total', () => {
  const { values, formulas } = onboardingGrid();
  const r = parseHistoryBlock(values, formulas, spec('onboarding'));
  assert.deepEqual(
    r.weeks.map((w) => [w.weekStart, w.imported, w.verified]),
    [
      ['2026-09-06', true, 6],
      ['2026-09-13', true, 6],
    ],
  );
  const avery = r.cells.filter((c) => c.label === 'Avery').map((c) => [c.date, c.value]);
  assert.deepEqual(avery.slice(5), [
    ['2026-09-14', 2],
    ['2026-09-15', 2],
    ['2026-09-16', 1],
    ['2026-09-17', 0],
    ['2026-09-18', 4],
  ]);
  assert.ok(r.cells.every((c) => c.slot === 'day'));
});

test('a one-number week pasted a whole day late is skipped, not shifted back', () => {
  const { values, formulas } = onboardingGrid();
  // Week 2 moved two columns right: Monday's pair is empty and Friday spills past the Total.
  for (let i = 3; i <= 8; i++) {
    const row = values[i];
    const moved = row.slice(12, 23);
    row[12] = '';
    row[13] = '';
    moved.forEach((c, j) => {
      row[14 + j] = c;
    });
  }
  const r = parseHistoryBlock(values, formulas, spec('onboarding'));
  assert.equal(r.weeks[0].imported, true);
  assert.equal(r.weeks[1].imported, false);
  assert.match(r.weeks[1].reason ?? '', /can be checked/);
  assert.equal(r.cells.length, 6 * 5);
  assert.ok(r.cells.every((c) => c.date < '2026-09-13'));
});

test('two numbers in one pair is ambiguous: the cell is skipped and reported', () => {
  const { values, formulas } = onboardingGrid();
  values[3][2] = 7; // Avery Monday week 1: both halves now hold a number
  const r = parseHistoryBlock(values, formulas, spec('onboarding'));
  assert.equal(r.cells.some((c) => c.label === 'Avery' && c.date === '2026-09-07'), false);
  assert.equal(r.skippedCells[0].reason, 'two numbers for one day');
});

test('dates the header lists twice belong to neither copy', () => {
  const { values, formulas } = onboardingGrid();
  const header = values[1];
  ['9/7/26', '9/8/26', '9/9/26', '9/10/26', '9/11/26'].forEach((d, k) => {
    header[12 + 2 * k] = d; // week 2's header retyped as week 1's dates
  });
  const r = parseHistoryBlock(values, formulas, spec('onboarding'));
  assert.equal(r.weeks.length, 2);
  assert.ok(r.weeks.every((w) => !w.imported && /twice/.test(w.reason ?? '')));
  assert.equal(r.cells.length, 0);
});

test('a header whose dates are not one Monday-to-Friday week is skipped', () => {
  const { values, formulas } = onboardingGrid();
  values[1][9] = '9/12/26'; // a Saturday in week 1
  const r = parseHistoryBlock(values, formulas, spec('onboarding'));
  assert.equal(r.weeks[0].imported, false);
  assert.match(r.weeks[0].reason ?? '', /weekend/);
});

test('rows with numbers but no label are counted, never filed under someone', () => {
  const { values, formulas } = onboardingGrid();
  values.splice(5, 0, ['', 1, '', 1]);
  const r = parseHistoryBlock(values, formulas, spec('onboarding'));
  assert.deepEqual(r.unlabelledRows, [6]);
  assert.ok(r.cells.every((c) => c.label !== ''));
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

test('parseArchiveTab keeps every non-blank row as typed and reads column A as a date when it is one', () => {
  const rows = parseArchiveTab([
    ['Date', 'Collections', 'Daily Collection', 'Payment Sheet?'],
    ['Total\nDec 02-06', '503', '', 'FALSE'],
    ['12/05/2024', '116', '34/26', 'FALSE', '', ''],
    [],
    ['11/29/2024', 'Holiday', 'Holiday'],
    ['HOLIDAY', '-', '-'],
  ]);
  assert.deepEqual(
    rows.map((r) => [r.sheetRow, r.entryDate, r.cells]),
    [
      [1, null, ['Date', 'Collections', 'Daily Collection', 'Payment Sheet?']],
      [2, null, ['Total\nDec 02-06', '503', '', 'FALSE']],
      [3, '2024-12-05', ['12/05/2024', '116', '34/26', 'FALSE']],
      [5, '2024-11-29', ['11/29/2024', 'Holiday', 'Holiday']],
      [6, null, ['HOLIDAY', '-', '-']],
    ],
  );
});
