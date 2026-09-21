import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGmlQuery, MAX_LIMIT, parseGmlQuery, type GmlQuery, type GmlRow } from './gml-query';

const base: GmlQuery = { department: null, email: null, search: null, limit: 100, cursor: null };

/**
 * `global_master_list.id` is a **UUID** in production, not an integer. Every
 * fixture here used integer ids until 2026-09-21, which is the reason the suite
 * was green while paging was impossible for every real caller: the API issued a
 * UUID as `next_cursor` and then 400'd the value it had just issued.
 *
 * Canonical UUID text sorts lexicographically in the same order Postgres sorts
 * the `uuid` type (lowercase hex, fixed width), so a plain string comparison
 * here matches the SQL `.order('id')` the route relies on.
 */
function uuid(n: number): string {
  const h = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
}

function row(seed: number, extra: Record<string, unknown> = {}): GmlRow {
  return {
    id: uuid(seed),
    Name: `Person ${seed}`,
    'Work Email': `p${seed}@simple.biz`,
    'Personal Email': `p${seed}@gmail.com`,
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

  const cur = '004e8fe3-5571-4c8b-a933-45106d479507';
  const full = parseGmlQuery(
    new URLSearchParams(`department=HSL&email=Kev@Simple.biz&search=kev&limit=500&cursor=${cur}`),
  );
  assert.ok(full.ok);
  assert.deepEqual(full.query, { department: 'HSL', email: 'kev@simple.biz', search: 'kev', limit: 500, cursor: cur });

  // A cursor is opaque to the CALLER but not unvalidated: it is the id we
  // issued, so it must look like one. This swaps the old integer guard for a
  // UUID guard — it does not relax it. An integer is now refused, because the
  // API never issues one.
  for (const bad of [
    'limit=0',
    'limit=501',
    'limit=abc',
    'limit=-1',
    'cursor=abc',
    'cursor=-3',
    'cursor=42',
    'cursor=004e8fe3-5571-4c8b-a933',
    "cursor=004e8fe3-5571-4c8b-a933-45106d479507' OR 1=1--",
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
  assert.deepEqual(applyGmlQuery(rows, base).rows.map((r) => r.id), [uuid(1), uuid(3)]);
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'p2@simple.biz' }).rows, []);
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'p2@gmail.com' }).rows, []);
  assert.deepEqual(applyGmlQuery(rows, { ...base, search: 'person 2' }).rows, []);
  assert.deepEqual(applyGmlQuery(rows, { ...base, department: 'sales' }).rows.map((r) => r.id), [uuid(1), uuid(3)]);
  assert.equal(applyGmlQuery(rows, base).total, 2);
});

test('email matches any of the four alias columns, case-insensitively', () => {
  const rows = [
    row(1, { 'Work Email': 'kevt@simple.biz', 'Alternate Work Email': 'Kevin@Simple.biz' }),
    row(2, { 'Alternate Work Email 2': 'x@simple.biz' }),
  ];
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'kevin@simple.biz' }).rows.map((r) => r.id), [uuid(1)]);
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'kevt@simple.biz' }).rows.map((r) => r.id), [uuid(1)]);
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'x@simple.biz' }).rows.map((r) => r.id), [uuid(2)]);
  assert.deepEqual(applyGmlQuery(rows, { ...base, email: 'nobody@simple.biz' }).rows, []);
});

test('department is an exact, case-insensitive match', () => {
  const rows = [row(1, { Department: 'HSL - Collections' }), row(2, { Department: 'Sales' })];
  assert.deepEqual(applyGmlQuery(rows, { ...base, department: 'hsl - collections' }).rows.map((r) => r.id), [uuid(1)]);
  assert.deepEqual(applyGmlQuery(rows, { ...base, department: 'HSL' }).rows, []);
});

test('paging is keyset on id: stable order, exclusive cursor, null at the end', () => {
  const rows = [row(30), row(10), row(20), row(40), row(50)];
  const p1 = applyGmlQuery(rows, { ...base, limit: 2 });
  assert.deepEqual(p1.rows.map((r) => r.id), [uuid(10), uuid(20)]);
  assert.equal(p1.nextCursor, uuid(20));
  assert.equal(p1.total, 5);
  const p2 = applyGmlQuery(rows, { ...base, limit: 2, cursor: p1.nextCursor });
  assert.deepEqual(p2.rows.map((r) => r.id), [uuid(30), uuid(40)]);
  assert.equal(p2.nextCursor, uuid(40));
  const p3 = applyGmlQuery(rows, { ...base, limit: 2, cursor: p2.nextCursor });
  assert.deepEqual(p3.rows.map((r) => r.id), [uuid(50)]);
  assert.equal(p3.nextCursor, null);
  // an exactly-full last page also ends the walk
  const exact = applyGmlQuery(rows, { ...base, limit: 5 });
  assert.equal(exact.nextCursor, null);
});

test('a client can WALK a UUID-keyed roster to exhaustion without ever being refused', () => {
  // The defect this pins: `next_cursor` was a UUID returned in a field typed
  // `number`, and the very next call 400'd the value the API had just issued.
  // Measured 2026-09-21: no live call ever returned more than 500 rows.
  const rows = Array.from({ length: 23 }, (_, i) => row(i + 1));
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    // every cursor the API hands back must survive a full round-trip through
    // the public query parser — that is where the 400 came from.
    const params = new URLSearchParams({ limit: '5' });
    if (cursor != null) params.set('cursor', cursor);
    const parsed = parseGmlQuery(params);
    assert.ok(parsed.ok, `cursor the API issued was refused: ${cursor}`);

    const page = applyGmlQuery(rows, parsed.query);
    assert.equal(page.total, 23);
    seen.push(...page.rows.map((r) => r.id));
    cursor = page.nextCursor;
    if (cursor == null) break;
  }
  assert.equal(cursor, null, 'walk did not terminate');
  assert.equal(seen.length, 23, 'walk did not reach every row');
  assert.deepEqual(seen, rows.map((r) => r.id).sort());
  assert.equal(new Set(seen).size, 23, 'walk returned a row twice');
});

test('every column on the row is returned as stored', () => {
  const rows = [row(1, { 'Phone Number': '0917', full_address: 'Somewhere', google_photo_url: 'https://x' })];
  const [r] = applyGmlQuery(rows, base).rows;
  assert.equal(r['Phone Number'], '0917');
  assert.equal(r['full_address'], 'Somewhere');
  assert.equal(r['google_photo_url'], 'https://x');
});
