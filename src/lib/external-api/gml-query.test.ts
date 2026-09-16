import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGmlQuery, MAX_LIMIT, parseGmlQuery, type GmlQuery, type GmlRow } from './gml-query';

const base: GmlQuery = { department: null, email: null, search: null, limit: 100, cursor: null };

function row(id: number, extra: Record<string, unknown> = {}): GmlRow {
  return {
    id,
    Name: `Person ${id}`,
    'Work Email': `p${id}@simple.biz`,
    'Personal Email': `p${id}@gmail.com`,
    'Alternate Work Email': null,
    'Alternate Work Email 2': null,
    Department: 'Sales',
    off_boarded_at: null,
    ...extra,
  };
}

test('MAX_LIMIT stays below the PostgREST 1000-row cap', () => {
  assert.ok(MAX_LIMIT < 1000);
});

test('parseGmlQuery: defaults, clamps and rejects', () => {
  const ok = parseGmlQuery(new URLSearchParams(''));
  assert.ok(ok.ok);
  assert.deepEqual(ok.query, base);

  const full = parseGmlQuery(
    new URLSearchParams('department=HSL&email=Kev@Simple.biz&search=kev&limit=500&cursor=42'),
  );
  assert.ok(full.ok);
  assert.deepEqual(full.query, { department: 'HSL', email: 'kev@simple.biz', search: 'kev', limit: 500, cursor: 42 });

  for (const bad of [
    'limit=0',
    'limit=501',
    'limit=abc',
    'limit=-1',
    'cursor=abc',
    'cursor=-3',
    'email=nope',
    'include_offboarded=true',
    'offboarded=1',
  ]) {
    const r = parseGmlQuery(new URLSearchParams(bad));
    assert.equal(r.ok, false, bad);
  }
});

test('off-boarded rows are unreachable through EVERY filter path', () => {
  const rows = [row(1), row(2, { off_boarded_at: '2026-09-01T00:00:00Z' }), row(3)];
  assert.deepEqual(applyGmlQuery(rows, base).rows.map((r) => r.id), [1, 3]);
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'p2@simple.biz' }).rows, []);
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'p2@gmail.com' }).rows, []);
  assert.deepEqual(applyGmlQuery(rows, { ...base, search: 'person 2' }).rows, []);
  assert.deepEqual(applyGmlQuery(rows, { ...base, department: 'sales' }).rows.map((r) => r.id), [1, 3]);
  assert.equal(applyGmlQuery(rows, base).total, 2);
});

test('email matches any of the four alias columns, case-insensitively', () => {
  const rows = [
    row(1, { 'Work Email': 'kevt@simple.biz', 'Alternate Work Email': 'Kevin@Simple.biz' }),
    row(2, { 'Alternate Work Email 2': 'x@simple.biz' }),
  ];
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'kevin@simple.biz' }).rows.map((r) => r.id), [1]);
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'kevt@simple.biz' }).rows.map((r) => r.id), [1]);
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'x@simple.biz' }).rows.map((r) => r.id), [2]);
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'nobody@simple.biz' }).rows, []);
});

test('department is an exact, case-insensitive match', () => {
  const rows = [row(1, { Department: 'HSL - Collections' }), row(2, { Department: 'Sales' })];
  assert.deepEqual(applyGmlQuery(rows, { ...base, department: 'hsl - collections' }).rows.map((r) => r.id), [1]);
  assert.deepEqual(applyGmlQuery(rows, { ...base, department: 'HSL' }).rows, []);
});

test('paging is keyset on id: stable order, exclusive cursor, null at the end', () => {
  const rows = [row(30), row(10), row(20), row(40), row(50)];
  const p1 = applyGmlQuery(rows, { ...base, limit: 2 });
  assert.deepEqual(p1.rows.map((r) => r.id), [10, 20]);
  assert.equal(p1.nextCursor, 20);
  assert.equal(p1.total, 5);
  const p2 = applyGmlQuery(rows, { ...base, limit: 2, cursor: p1.nextCursor });
  assert.deepEqual(p2.rows.map((r) => r.id), [30, 40]);
  assert.equal(p2.nextCursor, 40);
  const p3 = applyGmlQuery(rows, { ...base, limit: 2, cursor: p2.nextCursor });
  assert.deepEqual(p3.rows.map((r) => r.id), [50]);
  assert.equal(p3.nextCursor, null);
  // an exactly-full last page also ends the walk
  const exact = applyGmlQuery(rows, { ...base, limit: 5 });
  assert.equal(exact.nextCursor, null);
});

test('every column on the row is returned as stored', () => {
  const rows = [row(1, { 'Phone Number': '0917', full_address: 'Somewhere', google_photo_url: 'https://x' })];
  const [r] = applyGmlQuery(rows, base).rows;
  assert.equal(r['Phone Number'], '0917');
  assert.equal(r['full_address'], 'Somewhere');
  assert.equal(r['google_photo_url'], 'https://x');
});
