import test from 'node:test';
import assert from 'node:assert/strict';
import { payrollWeekFilenameError } from './calendar-column-dedupe';
import { apiSyncFileName } from './build-weekly-summary';

// The names production actually carries. If this list ever rejects, the guard is
// refusing a batch shape this system has already accepted — fix the guard, not
// the fixture.
const REAL_PRODUCTION_NAMES = [
  'simple-biz_daily_report_2026-08-16_to_2026-08-22.csv', // 7-day Sun–Sat
  'simple-biz_daily_report_2026-08-09_to_2026-08-15.csv',
  'simple-biz_daily_report_2026-06-14_to_2026-06-21.csv', // 8-day Sun–Sun, real
  'simple-biz_daily_report_2026-05-31_to_2026-06-07.csv', // 8-day, crosses a month
];

test('accepts every batch filename production already carries', () => {
  for (const name of REAL_PRODUCTION_NAMES) {
    assert.equal(payrollWeekFilenameError(name), null, name);
  }
});

test('accepts what the API sync generates — the guard must never refuse the sync path', () => {
  assert.equal(payrollWeekFilenameError(apiSyncFileName('2026-08-16', '2026-08-22')), null);
});

test('rejects the 2026-08-24 incident filename', () => {
  // Promoted to is_current for ~25 minutes. Hung both KPI Calculators on their
  // loading skeleton and skipped the week's MESA deposits.
  const err = payrollWeekFilenameError('8:16 - 8:22 csv.csv');
  assert.ok(err, 'must be refused');
  assert.match(err, /YYYY-MM-DD_to_YYYY-MM-DD/, 'must name the expected pattern');
  assert.match(err, /8:16 - 8:22 csv\.csv/, 'must quote what was actually given');
});

test('rejects a name with no date range at all', () => {
  for (const name of ['hours.csv', 'week 34.csv', 'aug 16-22.csv', 'report_2026-08-16.csv']) {
    assert.ok(payrollWeekFilenameError(name), name);
  }
});

test('rejects a missing or blank filename', () => {
  assert.ok(payrollWeekFilenameError(undefined));
  assert.ok(payrollWeekFilenameError(null));
  assert.ok(payrollWeekFilenameError('   '));
});

test('rejects a parseable range that is NOT Sunday-anchored', () => {
  // Parses fine, strands every row exactly like an unparseable name: readers look
  // the week up by its Sunday. This is the half of the class a parse-only check
  // would leave open.
  const monday = payrollWeekFilenameError('simple-biz_daily_report_2026-08-17_to_2026-08-23.csv');
  assert.ok(monday, 'a Monday-anchored week must be refused');
  assert.match(monday, /not a Sunday/);
  assert.match(monday, /2026-08-17/, 'must say which day it actually starts on');

  for (const name of [
    'simple-biz_daily_report_2026-08-18_to_2026-08-24.csv', // Tue
    'simple-biz_daily_report_2026-08-22_to_2026-08-28.csv', // Sat
  ]) {
    assert.ok(payrollWeekFilenameError(name), name);
  }
});

test('the error is written for the person re-picking the file', () => {
  const err = payrollWeekFilenameError('8:16 - 8:22 csv.csv');
  assert.ok(err);
  // Names a concrete example they can copy, and says what breaks without it.
  assert.match(err, /simple-biz_daily_report_2026-08-16_to_2026-08-22\.csv/);
  assert.match(err, /MESA|payroll|KPI/i);
});
