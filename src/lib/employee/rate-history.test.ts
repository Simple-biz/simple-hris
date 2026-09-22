import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRateHistoryRows,
  parseRateText,
  type RawRateHistoryRow,
} from '@/lib/employee/rate-history';

test('parseRateText strips thousands separators', () => {
  assert.equal(parseRateText('1,250.50'), 1250.5);
  assert.equal(parseRateText('175'), 175);
  assert.equal(parseRateText(262.5), 262.5);
});

test('parseRateText returns null — never NaN — for unusable input', () => {
  assert.equal(parseRateText(null), null);
  assert.equal(parseRateText(undefined), null);
  assert.equal(parseRateText(''), null);
  assert.equal(parseRateText('n/a'), null);
  // The failure that matters: NaN would flow into a pay total as NaN pesos.
  assert.equal(parseRateText('8:20:29'), null);
});

test('effective_from is read as a LOCAL calendar date, not UTC', () => {
  // `new Date('2026-09-13')` is midnight UTC, which is 2026-09-12 in a negative
  // offset and still the 13th in Manila. Building it from the parts keeps the
  // calendar day the accountant typed, in every timezone the app runs in.
  const [entry] = parseRateHistoryRows([
    { regular_rate: '175', ot_rate: '262.5', effective_from: '2026-09-13' },
  ]);
  assert.ok(entry);
  assert.equal(entry.effectiveFrom.getFullYear(), 2026);
  assert.equal(entry.effectiveFrom.getMonth(), 8); // September
  assert.equal(entry.effectiveFrom.getDate(), 13);
});

test('a row with an unreadable effective_from is DROPPED, never coerced', () => {
  const rows: RawRateHistoryRow[] = [
    { regular_rate: '175', ot_rate: null, effective_from: 'not-a-date' },
    { regular_rate: '200', ot_rate: null, effective_from: '2026-01-05' },
  ];
  const parsed = parseRateHistoryRows(rows);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.regularRate, 200);
});

test('entries come back newest first even when the API sends them ascending', () => {
  // `resolveRateAsOf` takes the FIRST entry at or before the day, so a list in
  // ascending order would hand back the OLDEST rate — an underpay or overpay
  // with nothing on screen to show for it.
  const parsed = parseRateHistoryRows([
    { regular_rate: '150', ot_rate: null, effective_from: '2026-01-01' },
    { regular_rate: '175', ot_rate: null, effective_from: '2026-06-01' },
    { regular_rate: '225', ot_rate: null, effective_from: '2026-09-01' },
  ]);
  assert.deepEqual(
    parsed.map((p) => p.regularRate),
    [225, 175, 150],
  );
});

test('the RAW rows are JSON round-trippable and the parsed entries are NOT', () => {
  // This is the whole reason the cache holds rows and derives entries.
  const rows: RawRateHistoryRow[] = [
    { regular_rate: '175', ot_rate: '262.5', effective_from: '2026-09-13' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows);

  const parsed = parseRateHistoryRows(rows);
  const roundTripped = JSON.parse(JSON.stringify(parsed)) as unknown as typeof parsed;
  assert.equal(typeof roundTripped[0]!.effectiveFrom, 'string');
  assert.throws(
    () => (roundTripped[0]!.effectiveFrom as unknown as Date).getTime(),
    TypeError,
    'a cached Date comes back as a string and .getTime() throws — cache the rows',
  );
});

test('an empty history parses to an empty list, not a thrown error', () => {
  assert.deepEqual(parseRateHistoryRows([]), []);
});

test('parseRateText rejects a PARTIAL read — the whole string must be a number', () => {
  // `parseFloat` returns 175 for "175abc" and 8 for "8:20:29". Both copies of
  // this parser did that before it was consolidated; a partial read hands back
  // a plausible rate with nothing on screen to say it was invented.
  assert.equal(parseRateText('175abc'), null);
  assert.equal(parseRateText('8:20:29'), null);
  assert.equal(parseRateText('12 hours'), null);
  assert.equal(parseRateText('₱175'), null);
  // ...while every shape a rate is actually stored in still parses.
  assert.equal(parseRateText('175'), 175);
  assert.equal(parseRateText(' 262.50 '), 262.5);
  assert.equal(parseRateText('1,250.50'), 1250.5);
  assert.equal(parseRateText('-50'), -50);
});
