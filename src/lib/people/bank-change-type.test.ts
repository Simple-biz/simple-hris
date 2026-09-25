import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bankTypeKey, bankTypeLabel, bankTypeOptions, NO_BANK_TYPE } from './bank-change-type';

/**
 * Pins the People → Bank changes bank-type filter (bank-preferred-routing.md §10.7).
 * The load-bearing property is the §10.5 rule: a filter never hides a row — every
 * row's bucket is one of the offered options.
 */

test('stored processor ids bucket as themselves', () => {
  for (const id of ['hurupay', 'higlobe', 'wise', 'jeeves', 'wires', 'wepay']) {
    assert.equal(bankTypeKey(id), id);
  }
});

test('rebrand and wire-account spellings normalise onto their rail', () => {
  assert.equal(bankTypeKey('Kolan'), 'hurupay');
  assert.equal(bankTypeKey(' HURUPAY '), 'hurupay');
  assert.equal(bankTypeKey('x1153'), 'wires');
});

test('blank processor gets its own bucket', () => {
  assert.equal(bankTypeKey(null), NO_BANK_TYPE);
  assert.equal(bankTypeKey(undefined), NO_BANK_TYPE);
  assert.equal(bankTypeKey('   '), NO_BANK_TYPE);
});

test('unrecognised text buckets under its own text, never dropped', () => {
  assert.equal(bankTypeKey('Payoneer'), 'payoneer');
  assert.equal(bankTypeLabel('payoneer'), 'payoneer');
});

test('labels follow the rebrand', () => {
  assert.equal(bankTypeLabel('hurupay'), 'Kolan');
  assert.equal(bankTypeLabel('wires'), 'Wires');
  assert.equal(bankTypeLabel(NO_BANK_TYPE), 'No bank type recorded');
});

test('options: known in processor order, then unknown, then blank last; no duplicates', () => {
  const opts = bankTypeOptions(['wires', null, 'Payoneer', 'hurupay', 'kolan', 'wise', 'wires']);
  assert.deepEqual(
    opts.map((o) => o.value),
    ['hurupay', 'wise', 'wires', 'payoneer', NO_BANK_TYPE],
  );
});

test('options only offer buckets that have rows', () => {
  assert.deepEqual(bankTypeOptions(['higlobe']).map((o) => o.value), ['higlobe']);
  assert.deepEqual(bankTypeOptions([]), []);
});

test('a filter never hides a row: every row buckets into an offered option', () => {
  const rows = ['wires', 'Kolan', null, '', 'x1153', 'Payoneer', 'jeeves', 'HiGlobe'];
  const offered = new Set(bankTypeOptions(rows).map((o) => o.value));
  for (const r of rows) assert.ok(offered.has(bankTypeKey(r)), `row ${JSON.stringify(r)} is unreachable`);
});
