import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAppointmentPaste } from './paste';

/** Kane's sample, verbatim shape: TAB-separated, surname-first names, quoted nicknames. */
const SAMPLE = [
  'marcc@simple.biz\tCahig, Marc Joseph\t32',
  'jaysonm@simple.biz\tMahinay, Jayson\t25',
  'iked@simple.biz\tDispo, Kenneth "Ike"\t21',
  'ricar@simple.biz\tRabutin, Maria Fredericka "Rica"\t21',
  'nathanr@simple.biz\tRosal, Nathaniel A "Nathan"\t20',
].join('\n');

test('parses the real paste shape — commas and quotes in the name survive intact', () => {
  const { rows, refusals, headerSkipped } = parseAppointmentPaste(SAMPLE);
  assert.equal(refusals.length, 0);
  assert.equal(headerSkipped, false);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { line: 1, email: 'marcc@simple.biz', displayName: 'Cahig, Marc Joseph', count: 32 });
  // The comma-and-quotes name is the whole reason this parser is tab-only.
  assert.equal(rows[3]!.displayName, 'Rabutin, Maria Fredericka "Rica"');
  assert.equal(rows[3]!.count, 21);
});

test('a line with NO tab is refused, never comma-split — the orphanage fallback would shred the surname', () => {
  const { rows, refusals } = parseAppointmentPaste('marcc@simple.biz, Cahig, Marc Joseph, 32');
  assert.equal(rows.length, 0);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0]!.reason, /tab-separated/);
});

test('CRLF and blank lines are tolerated, and line numbers count the blanks', () => {
  const text = 'marcc@simple.biz\tCahig, Marc Joseph\t32\r\n\r\n   \r\nnathanr@simple.biz\tRosal, Nathaniel\t20';
  const { rows, refusals } = parseAppointmentPaste(text);
  assert.equal(refusals.length, 0);
  assert.deepEqual(rows.map((r) => r.line), [1, 4]);
});

test('a header row is skipped once, only at the top, and only when column 1 is not an email', () => {
  const withHeader = 'Email\tName\tAppointments\n' + SAMPLE;
  const a = parseAppointmentPaste(withHeader);
  assert.equal(a.headerSkipped, true);
  assert.equal(a.rows.length, 5);
  assert.equal(a.refusals.length, 0);

  // A non-email in column 1 AFTER the first line is a refusal, not a second header.
  const midJunk = SAMPLE + '\nTotal\t\t119';
  const b = parseAppointmentPaste(midJunk);
  assert.equal(b.rows.length, 5);
  assert.equal(b.refusals.length, 1);
  assert.match(b.refusals[0]!.reason, /must be a work email/);
});

test('trailing empty cells from a wide selection do not make a row four columns', () => {
  const { rows, refusals } = parseAppointmentPaste('marcc@simple.biz\tCahig, Marc Joseph\t32\t\t');
  assert.equal(refusals.length, 0);
  assert.equal(rows[0]!.count, 32);
});

test('a misaligned row is refused — never silently priced as zero', () => {
  // Two cells: the orphanage parser would have taken Number('') === 0 here.
  const two = parseAppointmentPaste('marcc@simple.biz\t32');
  assert.equal(two.rows.length, 0);
  assert.match(two.refusals[0]!.reason, /Expected 3 columns .* got 2/);
  // Four real cells: something shifted.
  const four = parseAppointmentPaste('marcc@simple.biz\tCahig\tMarc Joseph\t32');
  assert.equal(four.rows.length, 0);
  assert.match(four.refusals[0]!.reason, /got 4/);
});

test('the count must be a whole non-negative number — no coercion of anything else', () => {
  const cases: Array<[string, RegExp]> = [
    ['1,200', /whole number/],
    ['12.5', /whole number/],
    // An EMPTY third cell is popped as a trailing empty, so it surfaces as a missing
    // column — still a refusal, and the more actionable message of the two.
    ['', /Expected 3 columns .* got 2/],
    ['twelve', /whole number/],
    ['-3', /whole number/],
  ];
  for (const [count, re] of cases) {
    const { rows, refusals } = parseAppointmentPaste(`marcc@simple.biz\tCahig, Marc\t${count}`);
    assert.equal(rows.length, 0, `should refuse count "${count}"`);
    assert.match(refusals[0]!.reason, re);
  }
  // Zero is a legitimate count.
  const zero = parseAppointmentPaste('marcc@simple.biz\tCahig, Marc\t0');
  assert.equal(zero.rows[0]!.count, 0);
});

test('the email is lowercased and trimmed; a duplicate within the paste is refused on the SECOND occurrence', () => {
  const text = '  MarcC@Simple.biz \tCahig, Marc\t32\njaysonm@simple.biz\tMahinay, Jayson\t25\nmarcc@simple.biz\tCahig, Marc\t40';
  const { rows, refusals } = parseAppointmentPaste(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.email, 'marcc@simple.biz');
  assert.equal(rows[0]!.count, 32, 'the FIRST occurrence stands');
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]!.line, 3);
  assert.match(refusals[0]!.reason, /Duplicate .* line 1/);
});

test('column 1 must look like an email', () => {
  const { rows, refusals } = parseAppointmentPaste('not-an-email\tCahig, Marc\t32\nx@\tY\t1');
  // First line is treated as a header (no @) and skipped; second has an @ but nothing after it.
  assert.equal(rows.length, 0);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0]!.reason, /must be a work email/);
});

test('empty input parses to nothing, with no refusals', () => {
  assert.deepEqual(parseAppointmentPaste(''), { rows: [], refusals: [], headerSkipped: false });
  assert.deepEqual(parseAppointmentPaste('\n  \r\n'), { rows: [], refusals: [], headerSkipped: false });
});
