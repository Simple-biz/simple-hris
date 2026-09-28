import test from 'node:test';
import assert from 'node:assert/strict';
import { inFilterLists, quoteInValue, IN_LIST_URL_BUDGET } from './in-list-chunks';

/** The id shape `DeptBonusCalculator` writes (`appliedId`). */
const appliedId = (i: number) => `app:2026-09-20:lead_gen:someone.long.name${i}@simple.biz:bonus-catalog-item-${i}`;

/** The live Lead Gen 09-20 row keyed on a name, which `.in()` could not match. */
const NAME_KEYED_ID = 'app:2026-09-20:lead_gen:arriola, mark anthony  "mark":bonus_mq9yxlmsyj7avdmc';

/** Undo `quoteInValue` the way PostgREST's list parser reads one quoted item. */
function parseList(list: string): string[] {
  assert.ok(list.startsWith('(') && list.endsWith(')'));
  const out: string[] = [];
  const body = list.slice(1, -1);
  let i = 0;
  while (i < body.length) {
    assert.equal(body[i], '"', `item must be quoted at ${i}`);
    i++;
    let v = '';
    while (body[i] !== '"') {
      if (body[i] === '\\') i++;
      assert.ok(i < body.length, 'unterminated item');
      v += body[i];
      i++;
    }
    out.push(v);
    i++;
    if (i < body.length) {
      assert.equal(body[i], ',');
      i++;
    }
  }
  return out;
}

test('no values → no lists, so a caller loops zero times', () => {
  assert.deepEqual(inFilterLists([]), []);
});

test('a small list stays one list and round-trips exactly', () => {
  const ids = Array.from({ length: 20 }, (_, i) => appliedId(i));
  const lists = inFilterLists(ids);
  assert.equal(lists.length, 1);
  assert.deepEqual(parseList(lists[0]!), ids);
});

test('Lead Gen 09-20 (478 ids, ~43 KB as one list) splits into lists that each fit the budget', () => {
  const ids = Array.from({ length: 478 }, (_, i) => appliedId(i));
  assert.ok(encodeURIComponent(ids.map(quoteInValue).join(',')).length > 40_000, 'fixture must reproduce the list that failed');
  const lists = inFilterLists(ids);
  assert.ok(lists.length > 1);
  for (const l of lists) assert.ok(encodeURIComponent(l).length <= IN_LIST_URL_BUDGET + 6, `list of ${encodeURIComponent(l).length} bytes`);
  // Nothing dropped, nothing repeated, order kept.
  assert.deepEqual(lists.flatMap(parseList), ids);
});

test('the budget stays under the ~14.4 KB query string measured to succeed', () => {
  assert.ok(IN_LIST_URL_BUDGET <= 14_000);
});

test('a value with a comma and embedded quotes is escaped, not split', () => {
  assert.equal(quoteInValue('a"b'), '"a\\"b"');
  assert.equal(quoteInValue('a\\b'), '"a\\\\b"');
  const lists = inFilterLists([appliedId(1), NAME_KEYED_ID, appliedId(2)]);
  assert.deepEqual(parseList(lists[0]!), [appliedId(1), NAME_KEYED_ID, appliedId(2)]);
});

test('a value cannot close its quote and inject list items', () => {
  const hostile = 'x"),("y';
  assert.deepEqual(parseList(inFilterLists([hostile])[0]!), [hostile]);
});

test('a single value larger than the budget throws instead of becoming a list the gateway refuses', () => {
  assert.throws(() => inFilterLists(['x'.repeat(IN_LIST_URL_BUDGET)]), /exceeds/);
});
