/**
 * The gift-tracker sheet importer.
 *
 * Two properties carry the whole thing:
 *
 *  1. A "No" against a milestone that has NOT come due is not imported. The
 *     source file carries 8,398 of them — they are the spreadsheet's default,
 *     not anybody's statement, and writing them would make `owed` meaningless.
 *  2. Nothing is ever defaulted. An unreadable cell produces a problem and no
 *     assertion, because absence is a representable state downstream.
 *
 * Run:  npx tsx --test src/lib/gift-tracker/receipt-import.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_COLUMN_COUNT,
  parseCsv,
  parseGiftReceiptCsv,
  selectAssertions,
} from './receipt-import';
import { parseStartDate } from '@/lib/gift-milestones';

const TODAY = new Date('2026-09-11T00:00:00');

const HEADER =
  'Employee ID,Name,Email Not found on Gift Tracker,Work Email,Start Date,' +
  '6 Mo Gift Date,Received?,12 Mo Gift Date,Received?,18 Mo Gift Date,Received?,' +
  '24 Mo Gift Date,Received?,30 Mo Gift Date,Received?,36 Mo Gift Date,Received?,' +
  '42 Mo Gift Date,Received?,48 Mo Gift Date,Received?';

/** A row for someone who started 2022-12-27 — milestones 1–7 are due on TODAY. */
function row(opts: {
  workEmail?: string;
  start?: string;
  received?: string[];
  name?: string;
  scratch?: string;
} = {}): string {
  const start = opts.start ?? '12/27/2022';
  const received = opts.received ?? ['Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'No', 'No'];
  const dates = [
    '6/27/2023', '12/27/2023', '6/27/2024', '12/27/2024',
    '6/27/2025', '12/27/2025', '6/27/2026', '12/27/2026',
  ];
  const pairs = dates.map((d, i) => `${d},${received[i]}`).join(',');
  const name = opts.name ?? '"Lagundi, Bryan ""Bry"""';
  return `2212-0001,${name},${opts.scratch ?? 'bryanl@simple.biz'},${opts.workEmail ?? 'bryanl@simple.biz'},${start},${pairs}`;
}

// ── CSV mechanics ────────────────────────────────────────────────────────────

test('parseCsv handles embedded commas and doubled quotes in names', () => {
  const table = parseCsv(`${HEADER}\n${row()}\n`);
  assert.equal(table.length, 2);
  assert.equal(table[1].length, EXPECTED_COLUMN_COUNT);
  assert.equal(table[1][1], 'Lagundi, Bryan "Bry"');
});

test('a trailing newline does not produce a phantom row', () => {
  assert.equal(parseCsv(`${HEADER}\n${row()}\n\n`).length, 2);
});

test('CRLF line endings parse identically to LF', () => {
  const lf = parseCsv(`${HEADER}\n${row()}\n`);
  const crlf = parseCsv(`${HEADER}\r\n${row()}\r\n`);
  assert.deepEqual(crlf, lf);
});

// ── The header is asserted, never sniffed ────────────────────────────────────

test('a file with the wrong column count is REFUSED, not remapped', () => {
  assert.throws(
    () => parseGiftReceiptCsv('Employee ID,Name,Work Email\n1,A,a@simple.biz\n'),
    /Refusing to guess the column mapping/,
  );
});

test('a file whose Work Email column moved is REFUSED', () => {
  const moved = HEADER.replace('Work Email', 'Personal Email');
  assert.throws(() => parseGiftReceiptCsv(`${moved}\n${row()}\n`), /should be "Work Email"/);
});

test('a file whose Received? headers moved is REFUSED', () => {
  const moved = HEADER.replace('6 Mo Gift Date,Received?', '6 Mo Gift Date,Shipped?');
  assert.throws(() => parseGiftReceiptCsv(`${moved}\n${row()}\n`), /Refusing to guess/);
});

// ── Row-level parsing ────────────────────────────────────────────────────────

test('the work email is the key, lower-cased; the scratch column is ignored', () => {
  const { rows, problems } = parseGiftReceiptCsv(
    `${HEADER}\n${row({ workEmail: 'BryanL@Simple.Biz', scratch: '#N/A' })}\n`,
  );
  assert.equal(problems.length, 0);
  assert.equal(rows[0].workEmail, 'bryanl@simple.biz');
});

test('a free-text scratch column never becomes a key or a problem', () => {
  const { rows, problems } = parseGiftReceiptCsv(
    `${HEADER}\n${row({ scratch: '"not on gift tracker, never received anything"' })}\n`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workEmail, 'bryanl@simple.biz');
  assert.equal(problems.length, 0);
});

test('a blank work email is reported and the row is skipped, never guessed from the name', () => {
  const { rows, problems } = parseGiftReceiptCsv(`${HEADER}\n${row({ workEmail: '' })}\n`);
  assert.equal(rows.length, 0);
  assert.equal(problems[0].kind, 'blank_work_email');
});

test('a duplicate work email is reported and skipped — two rows never merge silently', () => {
  const { rows, problems } = parseGiftReceiptCsv(`${HEADER}\n${row()}\n${row()}\n`);
  assert.equal(rows.length, 1);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'duplicate_work_email');
  assert.match(problems[0].detail, /already seen on line 2/);
});

test('an unreadable Received value yields a problem and NO assertion — not a false', () => {
  const { rows, problems } = parseGiftReceiptCsv(
    `${HEADER}\n${row({ received: ['Yes', 'maybe', 'No', 'No', 'No', 'No', 'No', 'No'] })}\n`,
  );
  const bad = rows[0].cells[1];
  assert.equal(bad.received, null);
  assert.equal(problems.some((p) => p.kind === 'unreadable_received_value' && p.milestoneIndex === 2), true);

  const { assertions } = selectAssertions({ row: rows[0], start: rows[0].startDate, today: TODAY });
  assert.equal(assertions.some((a) => a.milestoneIndex === 2), false);
});

test('an unreadable start date is reported and the row still parses', () => {
  const { rows, problems } = parseGiftReceiptCsv(`${HEADER}\n${row({ start: 'not a date' })}\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].startDate, null);
  assert.equal(problems[0].kind, 'unreadable_start_date');
});

test('a Yes following a No is imported as stated and reported as a sequence gap', () => {
  const { rows, problems } = parseGiftReceiptCsv(
    `${HEADER}\n${row({ received: ['Yes', 'No', 'Yes', 'No', 'No', 'No', 'No', 'No'] })}\n`,
  );
  assert.equal(problems.some((p) => p.kind === 'received_after_gap' && p.milestoneIndex === 3), true);
  const { assertions } = selectAssertions({ row: rows[0], start: rows[0].startDate, today: TODAY });
  assert.equal(assertions.find((a) => a.milestoneIndex === 3)?.received, true);
});

test('the sheet’s own milestone date is carried as evidence, not used as a rule', () => {
  const { rows } = parseGiftReceiptCsv(`${HEADER}\n${row()}\n`);
  assert.equal(rows[0].cells[0].sourceMilestoneDate, '2023-06-27');
});

// ── Selection: what actually becomes a database row ──────────────────────────

test('a No against a milestone that has NOT come due is not imported', () => {
  // Started 2026-08-16 — nothing is due on 2026-09-11.
  const { rows } = parseGiftReceiptCsv(
    `${HEADER}\n${row({ start: '8/16/2026', received: Array(8).fill('No') })}\n`,
  );
  const { assertions, skipped } = selectAssertions({
    row: rows[0],
    start: rows[0].startDate,
    today: TODAY,
  });
  assert.deepEqual(assertions, []);
  assert.equal(skipped.notDue, 8);
});

test('a No against a milestone that HAS come due is imported as owed evidence', () => {
  const { rows } = parseGiftReceiptCsv(
    `${HEADER}\n${row({ received: ['No', 'No', 'No', 'No', 'No', 'No', 'No', 'No'] })}\n`,
  );
  const { assertions, skipped } = selectAssertions({
    row: rows[0],
    start: rows[0].startDate,
    today: TODAY,
  });
  // Started 2022-12-27: milestones 1–7 are due on 2026-09-11, 8 is not.
  assert.equal(assertions.length, 7);
  assert.equal(assertions.every((a) => a.received === false), true);
  assert.equal(skipped.notDue, 1);
});

test('a Yes is imported even when its milestone has not arrived, and is flagged', () => {
  const { rows } = parseGiftReceiptCsv(
    `${HEADER}\n${row({ received: ['Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes'] })}\n`,
  );
  const { assertions, problems } = selectAssertions({
    row: rows[0],
    start: rows[0].startDate,
    today: TODAY,
  });
  assert.equal(assertions.length, 8);
  assert.equal(problems.some((p) => p.kind === 'received_before_due' && p.milestoneIndex === 8), true);
});

test('selection uses the AUTHORITATIVE start date, not the sheet’s', () => {
  // The sheet claims a 2022 start (7 milestones due); the master list says 2026.
  const { rows } = parseGiftReceiptCsv(
    `${HEADER}\n${row({ received: Array(8).fill('No') })}\n`,
  );
  const { assertions } = selectAssertions({
    row: rows[0],
    start: parseStartDate('2026-08-16'),
    today: TODAY,
  });
  assert.deepEqual(assertions, []);
});

test('with no authoritative start date only Yes cells import', () => {
  const { rows } = parseGiftReceiptCsv(
    `${HEADER}\n${row({ received: ['Yes', 'No', 'No', 'No', 'No', 'No', 'No', 'No'] })}\n`,
  );
  const { assertions, problems } = selectAssertions({
    row: rows[0],
    start: null,
    today: TODAY,
  });
  assert.equal(assertions.length, 1);
  assert.equal(assertions[0].received, true);
  assert.equal(problems.some((p) => p.kind === 'received_before_due'), true);
});

test('every assertion carries the work email as its key', () => {
  const { rows } = parseGiftReceiptCsv(`${HEADER}\n${row({ workEmail: 'BRYANL@simple.biz' })}\n`);
  const { assertions } = selectAssertions({ row: rows[0], start: rows[0].startDate, today: TODAY });
  assert.equal(assertions.length > 0, true);
  assert.equal(assertions.every((a) => a.workEmail === 'bryanl@simple.biz'), true);
});
