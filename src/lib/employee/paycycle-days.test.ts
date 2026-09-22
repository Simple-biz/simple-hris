import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaycycleDays, daySecondsFromRow } from './paycycle-days';

/**
 * The exact prod row, measured read-only 2026-09-22 (marca@simple.biz).
 * Columns are canonical weekday names; every value is a duration string.
 */
const FILE = 'simple-biz_daily_report_2026-09-13_to_2026-09-19.csv';
const PROD_ROW: Record<string, unknown> = {
  id: 'cc328ede-c370-4643-8487-fd5332d75452',
  Organization: 'Simple.biz',
  'Time Zone': 'America/New_York',
  Member: 'Marc Lawrence Andes',
  Email: 'marca@simple.biz',
  'Job title': null,
  'Total worked': '42:27:06',
  Activity: '48%',
  'Spent total': 0,
  Currency: 'USD',
  monday: '8:20:29',
  tuesday: '8:52:03',
  wednesday: '8:17:01',
  thursday: '8:33:08',
  friday: '8:24:25',
  saturday: '0:00:00',
  sunday: '0:00:00',
  source_file: FILE,
  upload_id: '93487a2f-31ab-41cc-95ab-f7dd1ba05114',
};

test('REGRESSION — the real prod row produces real hours, not seven blanks', () => {
  // The shipped bug: `Number("8:20:29")` is NaN, so every day fell to null and
  // the ladder rendered "—" seven times for a full week of tracked time.
  const days = buildPaycycleDays(FILE, [PROD_ROW]);
  assert.equal(days.length, 7);
  assert.ok(days.every((d) => d.hours !== null), JSON.stringify(days));
  const total = days.reduce((s, d) => s + (d.hours ?? 0), 0);
  assert.ok(Math.abs(total - 42.45) < 0.02, `total ${total} should be ~42.45 h`);
});

test('the ladder starts on SUNDAY and runs to Saturday', () => {
  const days = buildPaycycleDays(FILE, [PROD_ROW]);
  assert.deepEqual(days.map((d) => d.label), [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
  ]);
  assert.equal(days[0].iso, '2026-09-13');
  assert.equal(days[6].iso, '2026-09-19');
});

test('canonical weekday columns land on the RIGHT dates', () => {
  // `monday` is 2026-09-14 in this file, not 2026-09-13.
  const days = buildPaycycleDays(FILE, [PROD_ROW]);
  const byIso = new Map(days.map((d) => [d.iso, d.hours]));
  assert.equal(byIso.get('2026-09-14'), 8.34); // monday  8:20:29
  assert.equal(byIso.get('2026-09-15'), 8.87); // tuesday 8:52:03
  assert.equal(byIso.get('2026-09-13'), 0);    // sunday  0:00:00
  assert.equal(byIso.get('2026-09-19'), 0);    // saturday 0:00:00
});

test('TOTAL WORKED never becomes a day', () => {
  // 42:27:06 is a valid duration string sitting on the same row. If the column
  // predicate lets it through it lands on some day as a 42-hour shift.
  const days = buildPaycycleDays(FILE, [PROD_ROW]);
  assert.ok(days.every((d) => (d.hours ?? 0) < 24), JSON.stringify(days));
});

test('a worked-zero day is 0, a MISSING day is null — they must not collapse', () => {
  // employee-current-paycycle.md §2: absent is not zero.
  const noSaturday = { ...PROD_ROW };
  delete noSaturday.saturday;
  const days = buildPaycycleDays(FILE, [noSaturday]);
  const sat = days.find((d) => d.label === 'Saturday');
  const sun = days.find((d) => d.label === 'Sunday');
  assert.equal(sat?.hours, null, 'a column the file does not carry must read null');
  assert.equal(sun?.hours, 0, 'a column reading 0:00:00 must read 0, not null');
});

test('an employee with no row at all gets seven blanks, not seven zeros', () => {
  const days = buildPaycycleDays(FILE, []);
  assert.equal(days.length, 7);
  assert.ok(days.every((d) => d.hours === null));
});

test('ISO-dated columns are read directly, without canonical resolution', () => {
  const dated: Record<string, unknown> = {
    Email: 'x@simple.biz',
    'Total worked': '16:00:00',
    '2026-09-14': '8:00:00',
    '2026-09-15': '8:00:00',
    source_file: FILE,
  };
  const days = buildPaycycleDays(FILE, [dated]);
  const byIso = new Map(days.map((d) => [d.iso, d.hours]));
  assert.equal(byIso.get('2026-09-14'), 8);
  assert.equal(byIso.get('2026-09-15'), 8);
  assert.equal(byIso.get('2026-09-13'), null);
});

test('TWO ROWS for the same week take the MAX per day, never the sum', () => {
  // INDEX.md:41 — "readers dedupe, they do not sum." A double ingest that got
  // past the batch collapse must not double someone's Monday.
  const a = { ...PROD_ROW };
  const b = { ...PROD_ROW, monday: '3:00:00' };
  const days = buildPaycycleDays(FILE, [a, b]);
  const mon = days.find((d) => d.iso === '2026-09-14');
  assert.equal(mon?.hours, 8.34, 'max of 8:20:29 and 3:00:00');
  const total = days.reduce((s, d) => s + (d.hours ?? 0), 0);
  assert.ok(total < 50, `${total} h — summing would have doubled the week`);
});

test('an undatable filename yields no ladder rather than a wrong one', () => {
  assert.deepEqual(buildPaycycleDays('not-a-dated-file.csv', [PROD_ROW]), []);
});

test('daySecondsFromRow omits days with no column, and keeps zeros', () => {
  const secs = daySecondsFromRow(PROD_ROW, FILE);
  assert.equal(secs.get('2026-09-14'), 8 * 3600 + 20 * 60 + 29);
  assert.equal(secs.get('2026-09-13'), 0);
  const noSat = { ...PROD_ROW };
  delete noSat.saturday;
  assert.equal(daySecondsFromRow(noSat, FILE).has('2026-09-19'), false);
});
