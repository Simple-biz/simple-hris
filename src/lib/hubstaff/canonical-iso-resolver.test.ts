import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCanonicalIsoResolver,
  resolveCanonicalColumnsToIso,
} from './calendar-column-dedupe';

// `createCanonicalIsoResolver` is `resolveCanonicalColumnsToIso` with the
// per-filename work hoisted out of the per-row loop. It feeds the wizard's
// all-uploads merge, which Step 2's pay hours read — so it must agree with the
// original on EVERY row: same keys, same order, same values.

const FILES = [
  'simple-biz_daily_report_2026-09-13_to_2026-09-19.csv', // 7-day Sun→Sat
  'simple-biz_daily_report_2026-05-10_to_2026-05-17.csv', // 8-day Sun→Sun: two Sundays, last wins
  'backfill-may10_2026-05-04_to_2026-05-10.csv',          // Mon→Sun
  'time-activity-report_2026-04-05_to_2026-05-02.csv',    // four weeks
  'simple-biz_daily_report_2026-08-30_to_2026-09-05 4.csv',
  'simple-biz_daily_report_2026-10-25_to_2026-11-07.csv', // spans the US DST change
  'no-range-here.csv',
];

const ROWS: Record<string, unknown>[] = [
  { id: '1', Member: 'A', Email: 'a@simple.biz', monday: '7:00', tuesday: null, sunday: '1:15', 'Total worked': '8:15' },
  { Monday: 'upper', monday: 'lower', SUNDAY: 'x' },            // case variants collide on one date
  { Email: 'b@simple.biz', '2026-09-14': '7:00', friday: '6:00' },
  {},
  { saturday: 0, wednesday: '', thursday: undefined },
];

for (const file of FILES) {
  test(`matches resolveCanonicalColumnsToIso row-for-row: ${file}`, () => {
    const resolve = createCanonicalIsoResolver(file);
    for (const row of ROWS) {
      const expected = resolveCanonicalColumnsToIso(row, file);
      const actual = resolve(row);
      assert.deepEqual(Object.keys(actual), Object.keys(expected));
      assert.deepEqual(actual, expected);
    }
  });
}

test('an unparseable filename returns the row itself, like the original', () => {
  const row = { monday: '7:00' };
  assert.equal(createCanonicalIsoResolver('no-range-here.csv')(row), row);
  assert.equal(resolveCanonicalColumnsToIso(row, 'no-range-here.csv'), row);
});

test('the resolver holds no per-row state between calls', () => {
  const resolve = createCanonicalIsoResolver(FILES[0]);
  const first = resolve({ monday: '1' });
  const second = resolve({ tuesday: '2' });
  assert.deepEqual(first, { '2026-09-14': '1' });
  assert.deepEqual(second, { '2026-09-15': '2' });
});
