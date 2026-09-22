import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isHubstaffDayColumn,
  parseHubstaffDurationHours,
  parseHubstaffDurationSeconds,
} from './duration';

test('THE BUG: a Hubstaff cell is a duration string and Number() gives NaN', () => {
  // This is the regression. Current Paycycle shipped `Number(cell)` and every
  // day rendered blank for people with a full week of tracked time.
  assert.ok(Number.isNaN(Number('8:20:29')));
  assert.equal(parseHubstaffDurationSeconds('8:20:29'), 8 * 3600 + 20 * 60 + 29);
  assert.equal(parseHubstaffDurationHours('8:20:29'), 8.34);
});

test('the real row measured on prod 2026-09-22 sums to its own Total worked', () => {
  // marca@simple.biz, simple-biz_daily_report_2026-09-13_to_2026-09-19.csv.
  // If the parser drifts, this stops adding up — which is the whole point.
  const days = ['8:20:29', '8:52:03', '8:17:01', '8:33:08', '8:24:25', '0:00:00', '0:00:00'];
  const total = days.reduce((s, d) => s + parseHubstaffDurationSeconds(d), 0);
  assert.equal(total, parseHubstaffDurationSeconds('42:27:06'));
});

test('H:MM and bare decimals parse too', () => {
  assert.equal(parseHubstaffDurationSeconds('8:20'), 8 * 3600 + 20 * 60);
  assert.equal(parseHubstaffDurationSeconds('7.5'), 27000);
  assert.equal(parseHubstaffDurationSeconds('0:00:00'), 0);
});

test('an hour count past 24 is NOT truncated — weekly totals use the same format', () => {
  assert.equal(parseHubstaffDurationSeconds('42:27:06'), 42 * 3600 + 27 * 60 + 6);
});

test('null, empty and unparseable read 0 — matching the six existing copies exactly', () => {
  for (const v of [null, undefined, '', '   ', 'n/a', {}, []]) {
    assert.equal(parseHubstaffDurationSeconds(v), 0, `${JSON.stringify(v)} should be 0`);
  }
});

test('0 cannot mean "unreadable" — callers must use cell PRESENCE for that', () => {
  // Documented contract, pinned so nobody "improves" this into returning null:
  // six shipped readers depend on the 0.
  assert.equal(parseHubstaffDurationSeconds('garbage'), 0);
  assert.equal(parseHubstaffDurationSeconds('0:00:00'), 0);
});

test('canonical weekday names and ISO dates are day columns', () => {
  for (const c of ['monday', 'Sunday', 'SATURDAY', '2026-09-14']) {
    assert.ok(isHubstaffDayColumn(c), c);
  }
});

test('TOTAL WORKED is not a day column — it is a valid duration and would become a Monday', () => {
  assert.equal(isHubstaffDayColumn('Total worked'), false);
  assert.equal(isHubstaffDayColumn('total worked'), false);
});

test('the stored row\'s own columns are not day columns', () => {
  // source_file / upload_id exist on the DB row but not in the CSV, so the
  // CSV-facing copies of this predicate never had to exclude them.
  for (const c of ['source_file', 'upload_id', 'id', 'Email', 'Member', 'Activity', 'Currency', 'Time Zone']) {
    assert.equal(isHubstaffDayColumn(c), false, c);
  }
});

test('every metadata column on the real prod row is rejected', () => {
  const real = [
    'id', 'Organization', 'Time Zone', 'Member', 'Email', 'Job title', 'Job type',
    'Employee ID', 'Tax info', 'Location', 'Time zone', 'Date added', 'Total worked',
    'Activity', 'Spent total', 'Currency', 'source_file', 'upload_id',
  ];
  for (const c of real) assert.equal(isHubstaffDayColumn(c), false, c);
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (const c of days) assert.equal(isHubstaffDayColumn(c), true, c);
});
