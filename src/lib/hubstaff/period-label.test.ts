import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatPeriodRange, periodLabelFromFilename } from './period-label';

test('same-month range → "Jul 5 - 11, 2026"', () => {
  assert.equal(
    formatPeriodRange(new Date(2026, 6, 5), new Date(2026, 6, 11)),
    'Jul 5 - 11, 2026',
  );
});

test('cross-month range → "Jun 28 - Jul 4, 2026"', () => {
  assert.equal(
    formatPeriodRange(new Date(2026, 5, 28), new Date(2026, 6, 4)),
    'Jun 28 - Jul 4, 2026',
  );
});

test('cross-year range → "Dec 27, 2026 - Jan 2, 2027"', () => {
  assert.equal(
    formatPeriodRange(new Date(2026, 11, 27), new Date(2027, 0, 2)),
    'Dec 27, 2026 - Jan 2, 2027',
  );
});

test('parses manual CSV export filenames', () => {
  assert.equal(
    periodLabelFromFilename('simple-biz_daily_report_2026-07-05_to_2026-07-11.csv'),
    'Jul 5 - 11, 2026',
  );
});

test('parses live API sync filenames', () => {
  assert.equal(
    periodLabelFromFilename('simple-biz_api_sync_2026-07-05_to_2026-07-11.csv'),
    'Jul 5 - 11, 2026',
  );
});

test('falls back to the raw filename when no date block exists', () => {
  assert.equal(periodLabelFromFilename('renamed-batch.csv'), 'renamed-batch.csv');
  assert.equal(periodLabelFromFilename('renamed-batch.csv', 'n/a'), 'n/a');
});

test('null/undefined file → em dash (or explicit fallback)', () => {
  assert.equal(periodLabelFromFilename(null), '—');
  assert.equal(periodLabelFromFilename(undefined, 'none'), 'none');
});
