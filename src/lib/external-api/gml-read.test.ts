import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeGmlRead, type ReadRows } from './gml-read';
import type { GmlQuery, GmlRow } from './gml-query';
import { OFFERABLE_COLUMNS } from './catalog';

const q: GmlQuery = { department: null, email: null, search: null, limit: 100, cursor: null };

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function row(seed: number, extra: Record<string, unknown> = {}): GmlRow {
  const r: GmlRow = { id: uuid(seed), off_boarded_at: null, import_batch_id: 'b' };
  for (const c of OFFERABLE_COLUMNS) r[c] = `${c}-${seed}`;
  r['Work Email'] = `p${seed}@simple.biz`;
  r['Personal Email'] = `p${seed}@gmail.com`;
  return { ...r, ...extra };
}

function fakeRead(rows: GmlRow[], seen: string[] = []): ReadRows {
  return async (select) => {
    seen.push(select);
    return { rows, error: null };
  };
}

test('the select handed to the reader is built from the grant, never *', async () => {
  const seen: string[] = [];
  const out = await executeGmlRead(fakeRead([row(1)], seen), q, ['Name']);
  assert.ok(out.ok);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].includes('*'));
  assert.deepEqual(seen[0].split(',').sort(), ['Name', 'id', 'off_boarded_at'].map((c) => (c === 'Name' ? '"Name"' : c)).sort());
});

test('a hidden column is absent from every row and from `columns`', async () => {
  const out = await executeGmlRead(fakeRead([row(1), row(2)]), q, ['Name', 'Work Email']);
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.deepEqual(out.columns, ['id', 'Name', 'Work Email']);
  for (const r of out.data) {
    assert.deepEqual(Object.keys(r).sort(), ['Name', 'Work Email', 'id'].sort());
    assert.ok(!('Personal Email' in r));
    assert.ok(!('off_boarded_at' in r));
    assert.ok(!('import_batch_id' in r));
  }
  assert.equal(out.page.returned, 2);
  assert.equal(out.page.total, 2);
});

test('a whole-table grant still never emits the NEVER columns', async () => {
  const out = await executeGmlRead(fakeRead([row(1)]), q, null);
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.ok(!('import_batch_id' in out.data[0]));
  assert.ok(!('off_boarded_at' in out.data[0]));
  assert.ok('Personal Email' in out.data[0]);
});

test('a filter on a hidden column is refused BEFORE the read, naming the parameter', async () => {
  const seen: string[] = [];
  const out = await executeGmlRead(fakeRead([row(1)], seen), { ...q, department: 'Sales' }, ['Name']);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.status, 400);
  assert.equal(out.denial, 'column_not_granted');
  assert.deepEqual(out.details, [{ field: 'department', message: 'filters a column this key cannot see' }]);
  assert.equal(seen.length, 0, 'nothing was read');
});

test('a read failure is a 500 read_failed, never an empty 200', async () => {
  const failing: ReadRows = async () => ({ rows: [], error: 'boom' });
  const out = await executeGmlRead(failing, q, null);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.denial, 'read_failed');
});

test('leavers are dropped and the page cursor works through the pipeline', async () => {
  const rows = [row(1), row(2, { off_boarded_at: '2026-01-01T00:00:00Z' }), row(3), row(4)];
  const first = await executeGmlRead(fakeRead(rows), { ...q, limit: 2 }, ['Name']);
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.deepEqual(first.data.map((r) => r['id']), [uuid(1), uuid(3)]);
  assert.equal(first.page.next_cursor, uuid(3));
  const second = await executeGmlRead(fakeRead(rows), { ...q, limit: 2, cursor: uuid(3) }, ['Name']);
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.deepEqual(second.data.map((r) => r['id']), [uuid(4)]);
  assert.equal(second.page.next_cursor, null);
});
