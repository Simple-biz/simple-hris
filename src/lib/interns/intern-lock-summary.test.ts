import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { internLockSummary, type InternLockSummaryRow } from './intern-lock-summary';

const row = (over: Partial<InternLockSummaryRow> & { key: string }): InternLockSummaryRow => ({
  name: over.key.toUpperCase(),
  refusal: null,
  hoursPaid: 5,
  cappedOff: 0,
  internPhp: 500,
  ...over,
});

test('three interns sum to the total, to the centavo', () => {
  // 0.1 + 0.2 is 0.30000000000000004 in binary; the total is still 2dp.
  const s = internLockSummary([
    row({ key: 'a', internPhp: 500.1 }),
    row({ key: 'b', internPhp: 499.2 }),
    row({ key: 'c', internPhp: 182.0 }),
  ]);
  assert.equal(s.internCount, 3);
  assert.equal(s.totalPhp, 1181.3);
  assert.equal(s.lines.length, 3);
  assert.equal(
    s.totalPhp,
    Math.round(s.lines.reduce((t, l) => t + l.amountPhp, 0) * 100) / 100,
    'the headline is the sum of the lines under it',
  );
});

test('an intern with capped hours shows them on their own line', () => {
  const s = internLockSummary([
    row({ key: 'under', hoursPaid: 3.5, cappedOff: 0, internPhp: 350 }),
    row({ key: 'over', hoursPaid: 5, cappedOff: 1.4, internPhp: 500 }),
  ]);
  const over = s.lines.find((l) => l.key === 'over');
  const under = s.lines.find((l) => l.key === 'under');
  assert.deepEqual(over, { key: 'over', name: 'OVER', hoursPaid: 5, hoursCapped: 1.4, amountPhp: 500 });
  assert.equal(under?.hoursCapped, 0);
  assert.equal(s.hoursPaid, 8.5);
  assert.equal(s.hoursCapped, 1.4);
  assert.equal(s.internsCapped, 1);
});

test('a refused row is not locked in, so it is not counted, summed or listed', () => {
  // internPayRowsFromPreview writes priced rows only (intern-week-server.ts).
  const s = internLockSummary([
    row({ key: 'priced', internPhp: 500 }),
    row({ key: 'refused', refusal: 'No rate is in force on 2026-08-10.', internPhp: 0, hoursPaid: 0 }),
  ]);
  assert.equal(s.internCount, 1);
  assert.equal(s.totalPhp, 500);
  assert.deepEqual(s.lines.map((l) => l.key), ['priced']);
});

test('lines keep the order they were handed (the server sorts by name)', () => {
  const s = internLockSummary([row({ key: 'z' }), row({ key: 'a' }), row({ key: 'm' })]);
  assert.deepEqual(s.lines.map((l) => l.key), ['z', 'a', 'm']);
});

test('nothing priced: zero interns, ₱0, no lines (never NaN)', () => {
  const s = internLockSummary([]);
  assert.deepEqual(s, { internCount: 0, totalPhp: 0, hoursPaid: 0, hoursCapped: 0, internsCapped: 0, lines: [] });
});

test('the measured 2026-09-27 week: ₱4,164.00 across 9 interns is one week, not a running total', () => {
  // Shape of the figure Alivia read on 2026-10-07 (scripts/measure-intern-capped-hours.mts):
  // 9 interns, 41.64 paid hours, 9.80 capped, ₱4,164.00 to the interns. Amounts here are
  // synthetic per-intern splits of that week's totals, not anyone's real pay.
  const paid = [5, 5, 5, 5, 5, 5, 5, 4.64, 2];
  const capped = [1.2, 0.4, 2.1, 0.9, 1.5, 3.1, 0.6, 0, 0];
  const s = internLockSummary(paid.map((h, i) => row({ key: `i${i}`, hoursPaid: h, cappedOff: capped[i], internPhp: h * 100 })));
  assert.equal(s.internCount, 9);
  assert.equal(s.totalPhp, 4164);
  assert.equal(s.hoursPaid, 41.64);
  assert.equal(s.hoursCapped, 9.8);
  assert.equal(s.internsCapped, 7);
});
