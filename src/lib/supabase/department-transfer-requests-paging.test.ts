/**
 * Every Transfers list reader returns the WHOLE matching set (audit item 290).
 *
 * On 2026-09-30 the table held 434 rows and every list reader ended in
 * `.limit(300)`. HR and Accounting showed "299 completed", the Accounting
 * export exported 300, and the per-department readers cut the newest 300
 * across ALL departments before keeping a manager's own. These tests run the
 * REAL readers against a PostgREST double that behaves the way this project's
 * server does:
 *
 *   - at most 1000 rows per request (`db.max-rows`), with or without `.range()`;
 *   - `.limit(n)` is honoured, so a re-added cap fails here;
 *   - rows that tie on every requested order key come back in a DIFFERENT order
 *     on every request, so a reader without the `id` tiebreaker repeats and
 *     drops rows across pages (the 2026-09-03 `payment_dispatches` failure).
 *
 * The recording double is the one Termination Docs built
 * (`documents/termination/test-support/fake-supabase.ts`). The client is
 * passed in directly, so no module is redirected and `.env.local`, which holds
 * PRODUCTION credentials, is never read.
 *
 * Run:  npx tsx --test src/lib/supabase/department-transfer-requests-paging.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  chainArgs,
  chainArgsAll,
  createFakeSupabase,
  type FakeOp,
  type FakeResult,
} from '@/lib/documents/termination/test-support/fake-supabase';
import {
  listAllResolvedTransfers,
  listAllTransferRequests,
  listIncomingTransfersForDepartments,
  listPendingTransfers,
  listResolvedTransfersForDepartments,
  listScheduledDueTransfers,
  listTransferRequestsByRequester,
  type DepartmentTransferRequestRow,
  type TransferRequestStatus,
} from './department-transfer-requests';

const TABLE = 'department_transfer_requests';
const MAX_ROWS = 1000;
const TODAY = '2026-09-30';

// ── Fixture: well past 1000 rows in every filter the readers use ────────────

const STATUSES: TransferRequestStatus[] = ['pending', 'applied', 'approved', 'rejected', 'cancelled'];
const DEPTS = ['Lead Gen', 'hsl:intake_specialist', 'Client VA', 'QC'];
const REQUESTERS = ['cjm@simple.biz', 'jackie@simple.biz', 'carla@simple.biz'];

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function makeRows(count: number): DepartmentTransferRequestRow[] {
  const rows: DepartmentTransferRequestRow[] = [];
  for (let n = 0; n < count; n++) {
    const status = STATUSES[n % STATUSES.length];
    // Heavy ties on purpose: 28 distinct created_at values, 17 updated_at.
    const created = `2026-07-${pad((n % 28) + 1, 2)}T00:00:00+00:00`;
    const updated = `2026-08-${pad((n % 17) + 1, 2)}T00:00:00+00:00`;
    // Approved rows: some due, some in October, some with no date at all.
    const effective =
      status !== 'approved' ? null : n % 7 === 0 ? null : n % 5 === 0 ? '2026-10-04' : `2026-09-${pad((n % 30) + 1, 2)}`;
    rows.push({
      id: `00000000-0000-4000-8000-${pad(n, 12)}`,
      employee_email: `person${n}@simple.biz`,
      employee_name: `Person ${n}`,
      employee_work_email: `person${n}@simple.biz`,
      employee_personal_email: null,
      from_department: DEPTS[n % DEPTS.length],
      to_department: 'Client VA',
      reason: null,
      status,
      // Mixed casing: the requester read is case-insensitive.
      requested_by: n % 2 === 0 ? REQUESTERS[n % REQUESTERS.length] : REQUESTERS[n % REQUESTERS.length].toUpperCase(),
      approver_email: null,
      approver_note: null,
      decided_at: null,
      proposed_effective_date: effective,
      effective_date: effective,
      applied_at: null,
      sheet_synced: true,
      sheet_sync_error: null,
      created_at: created,
      updated_at: updated,
    });
  }
  return rows;
}

const ROWS = makeRows(6000);

// ── A PostgREST double for this one table ───────────────────────────────────

/** Deterministic per-request shuffle, so tied rows really do move between pages. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  let s = seed * 2654435761 + 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type Row = Record<string, unknown>;

function field(row: Row, col: string): string {
  const v = row[col];
  return v === null || v === undefined ? '' : String(v);
}

/** Answer one recorded select the way the server would. Anything this double
 *  does not understand is an ERROR, so a new filter can never be silently
 *  ignored into a passing test. */
function answer(rows: Row[], op: FakeOp, requestNo: number): FakeResult {
  let out = shuffled(rows, requestNo);
  let limit: number | null = null;
  const orders: { col: string; ascending: boolean }[] = [];
  for (const entry of op.chain) {
    const name = entry.slice(0, entry.indexOf('('));
    const args = entry.slice(name.length + 1, -1).split(',');
    if (name === 'select' || name === 'range') continue;
    if (name === 'eq') out = out.filter((r) => field(r, args[0]) === args[1]);
    else if (name === 'neq') out = out.filter((r) => field(r, args[0]) !== args[1]);
    else if (name === 'ilike') out = out.filter((r) => field(r, args[0]).toLowerCase() === args[1].toLowerCase());
    else if (name === 'lte') out = out.filter((r) => field(r, args[0]) !== '' && field(r, args[0]) <= args[1]);
    else if (name === 'not' && args[1] === 'is' && args[2] === 'null') out = out.filter((r) => field(r, args[0]) !== '');
    else if (name === 'order') {
      const opts = args.length > 1 ? (JSON.parse(args.slice(1).join(',')) as { ascending?: boolean }) : {};
      orders.push({ col: args[0], ascending: opts.ascending !== false });
    } else if (name === 'limit') limit = Number(args[0]);
    else return { data: null, error: { message: `FAKE: unemulated ${entry}` } };
  }
  // Array.prototype.sort is stable, so rows tied on every key keep the
  // per-request shuffle: exactly the unstable tie order PostgREST gives.
  out.sort((a, b) => {
    for (const o of orders) {
      const x = field(a, o.col);
      const y = field(b, o.col);
      if (x !== y) return (x < y ? -1 : 1) * (o.ascending ? 1 : -1);
    }
    return 0;
  });
  if (limit !== null) out = out.slice(0, limit);
  const from = op.from ?? 0;
  const to = Math.min(op.to ?? Number.MAX_SAFE_INTEGER, from + MAX_ROWS - 1);
  return { data: out.slice(from, to + 1), error: null };
}

function fakeTransfers(
  rows: Row[] = ROWS,
  override?: (op: FakeOp, requestNo: number) => FakeResult | null,
) {
  let requestNo = 0;
  const fake = createFakeSupabase({
    tables: {
      [TABLE]: (op) => {
        requestNo += 1;
        return override?.(op, requestNo) ?? answer(rows, op, requestNo);
      },
    },
  });
  return { fake, client: fake.client as SupabaseClient };
}

// ── Helpers for the assertions ──────────────────────────────────────────────

function ids(rows: { id: string }[]): string[] {
  return rows.map((r) => r.id).sort();
}

function assertComplete(
  got: { rows: DepartmentTransferRequestRow[]; error: string | null },
  expected: DepartmentTransferRequestRow[],
  label: string,
) {
  assert.equal(got.error, null, `${label}: ${got.error}`);
  assert.ok(expected.length > MAX_ROWS, `${label}: fixture must exceed one page (${expected.length})`);
  assert.equal(got.rows.length, expected.length, `${label}: row count`);
  assert.equal(new Set(got.rows.map((r) => r.id)).size, got.rows.length, `${label}: repeated rows`);
  assert.deepEqual(ids(got.rows), ids(expected), `${label}: row set`);
}

function assertSorted(rows: DepartmentTransferRequestRow[], col: keyof DepartmentTransferRequestRow, ascending: boolean) {
  for (let i = 1; i < rows.length; i++) {
    const prev = String(rows[i - 1][col] ?? '');
    const cur = String(rows[i][col] ?? '');
    assert.ok(ascending ? prev <= cur : prev >= cur, `${String(col)} out of order at ${i}: ${prev} then ${cur}`);
  }
}

/** Every page carries `.range()` and ends its order on the `id` tiebreaker. */
function assertTotalOrderPaging(fakeOps: FakeOp[], label: string) {
  assert.ok(fakeOps.length >= 2, `${label}: expected more than one page, saw ${fakeOps.length}`);
  for (const op of fakeOps) {
    assert.ok(chainArgs(op, 'range'), `${label}: a page without .range()`);
    assert.equal(chainArgs(op, 'limit'), null, `${label}: a page with .limit()`);
    const orders = chainArgsAll(op, 'order');
    assert.ok(orders.length >= 2, `${label}: needs a timestamp order AND an id tiebreaker`);
    assert.equal(orders[orders.length - 1][0], 'id', `${label}: last order key must be id`);
  }
}

const isLeadGen = (r: DepartmentTransferRequestRow) => r.from_department === 'Lead Gen';

// ── Class 1 + 2: no reader truncates, capped by .limit() or by db.max-rows ──

test('listAllTransferRequests returns every row, newest first (HR scope=all, Accounting, the export)', async () => {
  const { fake, client } = fakeTransfers();
  const got = await listAllTransferRequests(client);
  assertComplete(got, ROWS, 'all');
  assertSorted(got.rows, 'created_at', false);
  assertTotalOrderPaging(fake.opsFor(TABLE), 'all');
});

test('listTransferRequestsByRequester returns the whole outbox, case-insensitive', async () => {
  const { fake, client } = fakeTransfers();
  const got = await listTransferRequestsByRequester('  CJM@simple.biz ', client);
  assertComplete(got, ROWS.filter((r) => r.requested_by.toLowerCase() === 'cjm@simple.biz'), 'outbox');
  assertSorted(got.rows, 'created_at', false);
  assertTotalOrderPaging(fake.opsFor(TABLE), 'outbox');
});

test('listAllResolvedTransfers returns every non-pending row, newest activity first', async () => {
  const { fake, client } = fakeTransfers();
  const got = await listAllResolvedTransfers(client);
  assertComplete(got, ROWS.filter((r) => r.status !== 'pending'), 'all resolved');
  assertSorted(got.rows, 'updated_at', false);
  assertTotalOrderPaging(fake.opsFor(TABLE), 'all resolved');
});

test('listPendingTransfers returns every pending row (the admin queue and the stale sweep)', async () => {
  const { fake, client } = fakeTransfers();
  const got = await listPendingTransfers(client);
  assertComplete(got, ROWS.filter((r) => r.status === 'pending'), 'pending');
  assertSorted(got.rows, 'created_at', false);
  assertTotalOrderPaging(fake.opsFor(TABLE), 'pending');
});

test('listScheduledDueTransfers returns every due approved row, oldest effective date first (the cron)', async () => {
  const { fake, client } = fakeTransfers();
  const got = await listScheduledDueTransfers(TODAY, client);
  const due = ROWS.filter((r) => r.status === 'approved' && r.effective_date !== null && r.effective_date <= TODAY);
  assertComplete(got, due, 'due');
  assertSorted(got.rows, 'effective_date', true);
  assertTotalOrderPaging(fake.opsFor(TABLE), 'due');
});

test("the per-department readers keep a manager's rows past the first 1000 of the WHOLE table", async () => {
  // A quiet department: 1,200 of its resolved rows sit behind 5,000 newer
  // resolved rows from other teams. Cutting the whole table first and
  // filtering second — what `.limit(300)` did — returns none of them.
  const busy = makeRows(5000).map((r) => ({ ...r, from_department: 'QC', status: 'applied' as const, updated_at: '2026-09-29T00:00:00+00:00' }));
  const quiet = makeRows(1200).map((r, i) => ({
    ...r,
    id: `11111111-0000-4000-8000-${pad(i, 12)}`,
    from_department: 'Lead Gen',
    status: (i % 2 ? 'applied' : 'pending') as TransferRequestStatus,
    created_at: '2026-06-24T00:00:00+00:00',
    updated_at: '2026-07-01T00:00:00+00:00',
  }));
  const rows = [...busy, ...quiet];

  const done = fakeTransfers(rows);
  const resolved = await listResolvedTransfersForDepartments(['Lead Gen'], done.client);
  assert.equal(resolved.error, null);
  assert.deepEqual(ids(resolved.rows), ids(quiet.filter((r) => r.status !== 'pending')));
  assertTotalOrderPaging(done.fake.opsFor(TABLE), 'dept resolved');

  const inc = fakeTransfers(rows);
  const incoming = await listIncomingTransfersForDepartments(['Lead Gen'], inc.client);
  assert.equal(incoming.error, null);
  assert.deepEqual(ids(incoming.rows), ids(quiet.filter((r) => r.status === 'pending')));
});

test('the per-department readers page the full fixture and filter by source department', async () => {
  const done = fakeTransfers();
  const resolved = await listResolvedTransfersForDepartments(['Lead Gen'], done.client);
  assert.equal(resolved.error, null);
  assert.deepEqual(ids(resolved.rows), ids(ROWS.filter((r) => r.status !== 'pending' && isLeadGen(r))));
  assertSorted(resolved.rows, 'updated_at', false);

  const inc = fakeTransfers();
  const incoming = await listIncomingTransfersForDepartments(['Lead Gen'], inc.client);
  assert.equal(incoming.error, null);
  assert.deepEqual(ids(incoming.rows), ids(ROWS.filter((r) => r.status === 'pending' && isLeadGen(r))));
  assertTotalOrderPaging(inc.fake.opsFor(TABLE), 'dept incoming');
});

// ── Class 3: sheared pages are retried once, then refused ───────────────────

/** Page 2 starts one row early: the last row of page 1 comes back again, and
 *  (as in a real shear) the true last row of the read is lost. */
function shear(op: FakeOp, requestNo: number): FakeResult | null {
  if (op.from !== MAX_ROWS) return null;
  const shifted = answer(ROWS, { ...op, from: MAX_ROWS - 1, to: op.to }, requestNo);
  return shifted;
}

test('a sheared read is retried, and the retry is what gets returned', async () => {
  let sheared = false;
  const { fake, client } = fakeTransfers(ROWS, (op, n) => {
    if (sheared || op.from !== MAX_ROWS) return null;
    sheared = true;
    return shear(op, n);
  });
  const got = await listAllTransferRequests(client);
  assertComplete(got, ROWS, 'retried');
  // 6 pages for the sheared attempt + 7 for the clean one (6000 rows, last page empty).
  assert.ok(fake.opsFor(TABLE).length > 7, 'the read must have been run twice');
});

test('a read that shears on both attempts returns NO rows and an error, never a de-duplicated list', async () => {
  const { client } = fakeTransfers(ROWS, shear);
  const got = await listAllTransferRequests(client);
  assert.deepEqual(got.rows, []);
  assert.match(got.error ?? '', /repeated rows/);
});

// ── Class 4: a page error is not a short list ───────────────────────────────

test('an error on a later page returns NO rows, not the pages that did arrive', async () => {
  const { client } = fakeTransfers(ROWS, (op) =>
    op.from === 2 * MAX_ROWS ? { data: null, error: { message: 'boom' } } : null,
  );
  for (const read of [
    () => listAllTransferRequests(client),
    () => listAllResolvedTransfers(client),
    () => listResolvedTransfersForDepartments(['Lead Gen'], client),
  ]) {
    const got = await read();
    assert.deepEqual(got.rows, []);
    assert.equal(got.error, 'boom');
  }
});

test('no client is an error; no departments or no requester is an honest empty list with no query', async () => {
  assert.deepEqual(await listAllTransferRequests(null), { rows: [], error: 'Supabase not configured' });
  assert.deepEqual(await listScheduledDueTransfers(TODAY, null), { rows: [], error: 'Supabase not configured' });
  const { fake, client } = fakeTransfers();
  assert.deepEqual(await listIncomingTransfersForDepartments(['  '], client), { rows: [], error: null });
  assert.deepEqual(await listResolvedTransfersForDepartments([], client), { rows: [], error: null });
  assert.deepEqual(await listTransferRequestsByRequester('  ', client), { rows: [], error: null });
  assert.equal(fake.opsFor(TABLE).length, 0);
});

// ── Class 5: a new list reader cannot skip the pager ────────────────────────

test('every exported list reader goes through selectEveryTransferRow, and no list read carries .limit()', () => {
  // Comments are stripped first: the pager's own docstring quotes the old cap.
  const src = readFileSync(path.resolve(process.cwd(), 'src/lib/supabase/department-transfer-requests.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const starts = [...src.matchAll(/^export async function (list\w+)\(/gm)];
  assert.ok(starts.length >= 7, `expected the seven list readers, found ${starts.length}`);
  for (let i = 0; i < starts.length; i++) {
    const body = src.slice(starts[i].index, starts[i + 1]?.index ?? src.length);
    const end = body.search(/\n}\n/);
    const fn = end >= 0 ? body.slice(0, end) : body;
    assert.ok(fn.includes('selectEveryTransferRow('), `${starts[i][1]} does not page through selectEveryTransferRow`);
    assert.ok(!/\.limit\(/.test(fn), `${starts[i][1]} carries a .limit()`);
  }
  // The one bounded read left is the existence check, which needs one row.
  const limits = [...src.matchAll(/\.limit\((\w+)\)/g)].map((m) => m[1]);
  assert.deepEqual(limits, ['1'], `unexpected .limit() calls: ${limits.join(', ')}`);
});
