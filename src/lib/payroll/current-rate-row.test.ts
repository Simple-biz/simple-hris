/**
 * Run:  npx tsx --test src/lib/payroll/current-rate-row.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { outranksRateRow, type RateRowRank } from './current-rate-row';

const row = (id: string, isCurrent: boolean | null, uploadedAt: string | null): RateRowRank => ({
  id,
  isCurrent,
  uploadedAt,
});

function pick(rows: RateRowRank[]): string {
  let best = rows[0]!;
  for (const r of rows.slice(1)) if (outranksRateRow(r, best)) best = r;
  return best.id;
}

describe('outranksRateRow — mirrors employee_hourly_rates_current', () => {
  it('prefers the current upload over a newer non-current one', () => {
    assert.equal(
      pick([row('a', false, '2026-09-01T00:00:00Z'), row('b', true, '2026-06-13T00:00:00Z')]),
      'b',
    );
  });

  it('ranks is_current false ahead of a row with no upload (NULLS LAST)', () => {
    assert.equal(pick([row('f', null, null), row('a', false, '2026-01-01T00:00:00Z')]), 'a');
  });

  it('then prefers the newest upload', () => {
    assert.equal(
      pick([row('a', false, '2026-05-01T00:00:00Z'), row('b', false, '2026-06-01T00:00:00Z')]),
      'b',
    );
  });

  it('puts a missing uploaded_at last', () => {
    assert.equal(pick([row('z', false, null), row('a', false, '2026-05-01T00:00:00Z')]), 'a');
  });

  it('breaks a full tie on the highest id, in uuid text order', () => {
    assert.equal(
      pick([
        row('0fa3c1e2-0000-4000-8000-000000000000', true, '2026-06-13T00:00:00Z'),
        row('fffa98cb-4cee-487d-8ae2-a9853edf0ba3', true, '2026-06-13T00:00:00Z'),
        row('9aaa0000-0000-4000-8000-000000000000', true, '2026-06-13T00:00:00Z'),
      ]),
      'fffa98cb-4cee-487d-8ae2-a9853edf0ba3',
    );
  });

  it('is order-independent', () => {
    const rows = [
      row('c', false, '2026-04-01T00:00:00Z'),
      row('a', true, '2026-03-01T00:00:00Z'),
      row('b', null, null),
    ];
    assert.equal(pick(rows), 'a');
    assert.equal(pick([...rows].reverse()), 'a');
  });
});
