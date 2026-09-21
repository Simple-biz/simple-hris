import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFERABLE_COLUMNS, NEVER_COLUMNS } from './catalog';
import {
  filterVisibility,
  hiddenCount,
  isVisible,
  normalizeGrant,
  projectRow,
  projectRows,
  quoteIdent,
  refusedFilters,
  selectFor,
  visibleColumns,
} from './grants';
import { applyGmlQuery, type GmlQuery, type GmlRow } from './gml-query';

const q: GmlQuery = { department: null, email: null, search: null, limit: 100, cursor: null };

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function fullRow(seed: number, extra: Record<string, unknown> = {}): GmlRow {
  const r: GmlRow = { id: uuid(seed) };
  for (const c of OFFERABLE_COLUMNS) r[c] = `${c}-${seed}`;
  for (const c of NEVER_COLUMNS) r[c] = null;
  r['Work Email'] = `p${seed}@simple.biz`;
  r['Personal Email'] = `p${seed}@gmail.com`;
  r['Name'] = `Person ${seed}`;
  r['Department'] = 'Sales';
  return { ...r, ...extra };
}

test('normalizeGrant: null/undefined = whole table; a full list collapses to null; order is catalog order', () => {
  assert.deepEqual(normalizeGrant(null), { ok: true, grant: null });
  assert.deepEqual(normalizeGrant(undefined), { ok: true, grant: null });
  assert.deepEqual(normalizeGrant([...OFFERABLE_COLUMNS].reverse()), { ok: true, grant: null });
  const some = normalizeGrant(['Work Email', 'Name', 'Name', ' Department ']);
  assert.deepEqual(some, { ok: true, grant: ['Name', 'Department', 'Work Email'] });
});

test('normalizeGrant: id is implicit; unknown, never-offerable and empty lists are errors that NAME the column', () => {
  assert.deepEqual(normalizeGrant(['id', 'Name']), { ok: true, grant: ['Name'] });
  const unknown = normalizeGrant(['Name', 'Salary']);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /Salary/);
  const never = normalizeGrant(['Name', 'off_boarded_at']);
  assert.equal(never.ok, false);
  if (!never.ok) assert.match(never.error, /off_boarded_at/);
  assert.equal(normalizeGrant([]).ok, false);
  assert.equal(normalizeGrant(['id']).ok, false, 'only the implicit column is not a grant');
  assert.equal(normalizeGrant('Name').ok, false);
  assert.equal(normalizeGrant([42]).ok, false);
});

test('selectFor never contains * and always carries id + off_boarded_at; hidden columns are not fetched', () => {
  const all = selectFor(null);
  assert.ok(!all.includes('*'));
  assert.ok(all.split(',').includes('id'));
  assert.ok(all.split(',').includes('off_boarded_at'));
  assert.ok(all.includes('"Work Email"'), 'spaced identifiers are quoted');
  for (const never of NEVER_COLUMNS.filter((c) => c !== 'off_boarded_at')) {
    assert.ok(!all.split(',').includes(never), `${never} must not be selected even for a whole-table key`);
  }
  const narrow = selectFor(['Name', 'Work Email']);
  assert.deepEqual(narrow.split(',').sort(), ['"Work Email"', '"Name"', 'id', 'off_boarded_at'].sort());
  assert.ok(!narrow.includes('Personal Email'));
});

test('quoteIdent', () => {
  assert.equal(quoteIdent('id'), 'id');
  assert.equal(quoteIdent('full_address'), 'full_address');
  assert.equal(quoteIdent('Name'), '"Name"');
  assert.equal(quoteIdent('Work Email'), '"Work Email"');
});

test('projectRow: a hidden column NEVER appears, the always column always does, off_boarded_at is dropped', () => {
  const row = fullRow(7, { off_boarded_at: null, import_batch_id: 'b1' });
  const narrow = projectRow(row, ['Name', 'Work Email']);
  assert.deepEqual(Object.keys(narrow).sort(), ['Name', 'Work Email', 'id'].sort());
  assert.equal(narrow['id'], uuid(7));
  assert.ok(!('Personal Email' in narrow));
  assert.ok(!('off_boarded_at' in narrow));
  assert.ok(!('import_batch_id' in narrow));

  const whole = projectRow(row, null);
  assert.deepEqual(Object.keys(whole).sort(), ['id', ...OFFERABLE_COLUMNS].sort());
  for (const never of NEVER_COLUMNS) assert.ok(!(never in whole), `${never} leaked through a whole-table grant`);
});

test('projectRow keeps a stable shape: a granted column missing from the row comes back as null', () => {
  const r = projectRow({ id: uuid(1), Name: 'A' }, ['Name', 'Work Email']);
  assert.deepEqual(r, { id: uuid(1), Name: 'A', 'Work Email': null });
});

test('end to end: filter + page + project — hidden columns absent from every row of the page', () => {
  const rows = [fullRow(1), fullRow(2, { off_boarded_at: '2026-01-01' }), fullRow(3)];
  const grant = ['Name', 'Department'];
  const page = applyGmlQuery(rows, q, filterVisibility(grant));
  const out = projectRows(page.rows, grant);
  assert.equal(out.length, 2, 'the leaver is gone before projection');
  for (const r of out) {
    assert.deepEqual(Object.keys(r).sort(), ['Department', 'Name', 'id']);
  }
});

test('visibleColumns / isVisible / hiddenCount', () => {
  assert.deepEqual(visibleColumns(['Work Email', 'Name']), ['id', 'Name', 'Work Email']);
  assert.equal(isVisible(null, 'Personal Email'), true);
  assert.equal(isVisible(null, 'off_boarded_at'), false);
  assert.equal(isVisible(['Name'], 'id'), true);
  assert.equal(isVisible(['Name'], 'Work Email'), false);
  assert.equal(hiddenCount(null), 0);
  assert.equal(hiddenCount(['Name']), OFFERABLE_COLUMNS.length - 1);
});

test('filters on hidden columns are refused by name; search survives while any searchable column is visible', () => {
  const narrow = ['Name', 'Work Email'];
  assert.deepEqual(refusedFilters({ ...q, department: 'Sales' }, narrow), ['department']);
  assert.deepEqual(refusedFilters({ ...q, email: 'x@y.z' }, narrow), []);
  assert.deepEqual(refusedFilters({ ...q, email: 'x@y.z' }, ['Name']), ['email']);
  assert.deepEqual(refusedFilters({ ...q, search: 'x' }, ['Department']), ['search']);
  assert.deepEqual(refusedFilters({ ...q, search: 'x' }, ['Work Email']), []);
  assert.deepEqual(refusedFilters({ ...q, department: 'a', email: 'b@c.d', search: 'e' }, ['TeamIndex']), ['department', 'email', 'search']);
  assert.deepEqual(refusedFilters({ ...q, department: 'a', email: 'b@c.d', search: 'e' }, null), []);
});

test('a hidden email column cannot be probed: ?email= matches only VISIBLE email columns', () => {
  const rows = [fullRow(1)];
  const grant = ['Name', 'Work Email']; // Personal Email hidden
  const vis = filterVisibility(grant);
  assert.deepEqual(vis.emailColumns, ['Work Email']);
  const byPersonal = applyGmlQuery(rows, { ...q, email: 'p1@gmail.com' }, vis);
  assert.equal(byPersonal.rows.length, 0, 'the hidden Personal Email must not confirm the person exists');
  const byWork = applyGmlQuery(rows, { ...q, email: 'p1@simple.biz' }, vis);
  assert.equal(byWork.rows.length, 1);
  const searchPersonal = applyGmlQuery(rows, { ...q, search: 'gmail' }, vis);
  assert.equal(searchPersonal.rows.length, 0);
});
