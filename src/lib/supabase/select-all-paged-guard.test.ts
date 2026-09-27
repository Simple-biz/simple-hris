import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAllPagedUnorderedGuarded } from './select-all-paged';

type Row = { id: string | null; n: number };
const rowsOf = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, n: i }));

/** A fake PostgREST page builder over a fixed row list, with a hook to shear a given call. */
function fakeTable(all: Row[], shear?: (call: number, from: number, rows: Row[]) => Row[]) {
  let calls = 0;
  const page = (from: number, to: number) => {
    const call = calls++;
    const slice = all.slice(from, to + 1);
    return Promise.resolve({ data: shear ? shear(call, from, slice) : slice, error: null });
  };
  return { page, get calls() { return calls; } };
}

const PAGE = 10;
const base = {
  keyOf: (r: Row) => r.id,
  label: 'test',
  pageSize: PAGE,
};

test('a clean read returns rows in the order the source gave them — never re-sorted', async () => {
  const all = rowsOf(25).reverse();
  const t = fakeTable(all);
  const ordered = fakeTable([...all].sort((a, b) => a.n - b.n));
  const rows = await selectAllPagedUnorderedGuarded({ ...base, page: t.page, orderedPage: ordered.page });
  assert.deepEqual(rows, all);
  assert.equal(ordered.calls, 0, 'the ordered read never runs on a clean read');
});

test('a single short page is returned without paging further', async () => {
  const t = fakeTable(rowsOf(7));
  const rows = await selectAllPagedUnorderedGuarded({ ...base, page: t.page, orderedPage: t.page });
  assert.equal(rows.length, 7);
});

test('exact multiples of the page size terminate on the empty page', async () => {
  for (const n of [10, 20, 30]) {
    const t = fakeTable(rowsOf(n));
    const rows = await selectAllPagedUnorderedGuarded({ ...base, page: t.page, orderedPage: t.page });
    assert.equal(rows.length, n);
    assert.equal(new Set(rows.map((r) => r.id)).size, n);
  }
});

test('a sheared read (a row repeated, another dropped) is retried and the clean retry is used', async () => {
  const all = rowsOf(15);
  // Call 1 is the first attempt's SECOND page: it repeats id-0 in place of id-10.
  const t = fakeTable(all, (call, from, rows) => (call === 1 && from === PAGE ? [all[0], ...rows.slice(1)] : rows));
  const seen: string[] = [];
  const rows = await selectAllPagedUnorderedGuarded({
    ...base, page: t.page, orderedPage: () => { throw new Error('ordered read must not run'); },
    onRepeat: (i) => seen.push(`${i.attempt}:${i.fetched}/${i.distinct}`),
  });
  assert.deepEqual(rows, all);
  assert.deepEqual(seen, ['unordered:15/14']);
});

test('a read that shears twice falls back to the ordered read, which is correct by construction', async () => {
  const all = rowsOf(15);
  const sheared = fakeTable(all, (_call, from, rows) => (from === PAGE ? [all[0], ...rows.slice(1)] : rows));
  const orderedRows = [...all].sort((a, b) => (a.id! < b.id! ? -1 : 1));
  const ordered = fakeTable(orderedRows);
  const rows = await selectAllPagedUnorderedGuarded({ ...base, page: sheared.page, orderedPage: ordered.page });
  assert.deepEqual(rows, orderedRows);
  assert.equal(new Set(rows.map((r) => r.id)).size, all.length, 'no row lost');
});

test('an ordered read that STILL repeats a key throws — it is never de-duplicated into a pass', async () => {
  const all = rowsOf(15);
  const bad = fakeTable(all, (_c, from, rows) => (from === PAGE ? [all[0], ...rows.slice(1)] : rows));
  await assert.rejects(
    selectAllPagedUnorderedGuarded({ ...base, page: bad.page, orderedPage: bad.page }),
    /ordered read repeated rows \(15 fetched, 14 distinct\)/,
  );
});

test('rows inserted mid-read (a re-ingest in progress) repeat nothing and do not trip the guard', async () => {
  const all = rowsOf(15);
  const grown = [...all, { id: 'new-1', n: 99 }, { id: 'new-2', n: 100 }];
  const t = fakeTable(grown, (call, _from, rows) => (call === 0 ? rows : rows));
  const rows = await selectAllPagedUnorderedGuarded({ ...base, page: t.page, orderedPage: () => { throw new Error('no'); } });
  assert.equal(rows.length, 17);
});

test('a page error is thrown, on either of the first two pages or later', async () => {
  const failAt = (target: number) => (from: number, to: number) =>
    Promise.resolve(from === target
      ? { data: null, error: { message: `boom@${from}` } }
      : { data: rowsOf(35).slice(from, to + 1), error: null });
  for (const target of [0, PAGE, 2 * PAGE]) {
    await assert.rejects(
      selectAllPagedUnorderedGuarded({ ...base, page: failAt(target), orderedPage: failAt(target) }),
      new RegExp(`boom@${target}`),
    );
  }
});

test('the second page is ignored when the first is short, even if it errored', async () => {
  const page = (from: number, to: number) =>
    Promise.resolve(from === 0 ? { data: rowsOf(4).slice(from, to + 1), error: null } : { data: null, error: { message: 'should be ignored' } });
  const rows = await selectAllPagedUnorderedGuarded({ ...base, page, orderedPage: page });
  assert.equal(rows.length, 4);
});

test('rows without a key are counted as distinct, never as repeats', async () => {
  const all: Row[] = [{ id: null, n: 1 }, { id: null, n: 2 }, { id: 'a', n: 3 }];
  const t = fakeTable(all);
  const rows = await selectAllPagedUnorderedGuarded({ ...base, page: t.page, orderedPage: () => { throw new Error('no'); } });
  assert.equal(rows.length, 3);
});
