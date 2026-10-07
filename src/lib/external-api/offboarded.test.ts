import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORK_EMAIL_DOMAIN } from '../hr/work-email';
import {
  COMPANY_EMAIL_DOMAINS,
  OFFBOARDED_COLUMNS,
  OFFBOARDED_NEVER,
  OFFBOARDED_SELECT,
  REASON_CATEGORIES,
  applyOffboardedQuery,
  categorizeReason,
  executeOffboardedRead,
  parseOffboardedQuery,
  type OffboardedLedgerRow,
  type OffboardedQuery,
} from './offboarded';
import { MAX_LIMIT } from './gml-query';

function row(id: number, over: Partial<OffboardedLedgerRow> = {}): OffboardedLedgerRow {
  return {
    id,
    name: `Person ${id}`,
    work_email: `p${id}@simple.biz`,
    department: 'Lead Gen',
    start_date: '05/18/26',
    off_boarded_at: '2026-09-01T00:00:00+00:00',
    off_boarded_reason: 'resigned',
    origin: 'hris',
    ...over,
  };
}

const Q = (over: Partial<OffboardedQuery> = {}): OffboardedQuery => ({
  email: null,
  department: null,
  reason: null,
  since: null,
  until: null,
  search: null,
  limit: 100,
  cursor: null,
  ...over,
});

function parse(qs: string) {
  return parseOffboardedQuery(new URLSearchParams(qs));
}

// ─── Reasons ──────────────────────────────────────────────────────────────────

test('canonical reasons pass through, in either casing', () => {
  assert.deepEqual(categorizeReason('performance'), { kind: 'category', value: 'performance' });
  assert.deepEqual(categorizeReason('Performance'), { kind: 'category', value: 'performance' });
  assert.deepEqual(categorizeReason('ncns'), { kind: 'category', value: 'ncns' });
  assert.deepEqual(categorizeReason('End of contract'), { kind: 'category', value: 'end_of_contract' });
});

test('the sheet labels with volume map to a category', () => {
  assert.deepEqual(categorizeReason('No Show During Orientation'), { kind: 'category', value: 'no_show' });
  assert.deepEqual(categorizeReason('No Show'), { kind: 'category', value: 'no_show' });
  assert.deepEqual(categorizeReason('Policy Violation'), { kind: 'category', value: 'policy_violation' });
  assert.deepEqual(categorizeReason('Declined Offer'), { kind: 'category', value: 'declined_offer' });
  assert.deepEqual(categorizeReason('Reschedule For Next Week'), { kind: 'category', value: 'rescheduled' });
  assert.deepEqual(categorizeReason('Underperformance'), { kind: 'category', value: 'performance' });
});

test('temporary pause and the other not-a-departure labels are EXCLUDED, never served', () => {
  for (const label of ['temporary_pause', 'Temporary Pause', 'Active', 'duplicate_cleanup', 'sheet_sync']) {
    assert.deepEqual(categorizeReason(label), { kind: 'excluded' }, label);
  }
});

test('a free-text label is "other" — the text itself never goes out', () => {
  const sentence =
    '06/26/26 He has shown inconsistent improvement and quality of work despite receiving tons of targeted feedback';
  assert.deepEqual(categorizeReason(sentence), { kind: 'category', value: 'other' });
  assert.deepEqual(categorizeReason('Agent Passed Away'), { kind: 'category', value: 'other' });
});

test('a blank reason is null (not recorded), not "other"', () => {
  assert.deepEqual(categorizeReason(null), { kind: 'category', value: null });
  assert.deepEqual(categorizeReason('   '), { kind: 'category', value: null });
});

test('every served reason is one of REASON_CATEGORIES', () => {
  for (const label of ['resigned', 'x y z', 'Withdrawn', 'Tech Issue', 'productivity', '']) {
    const r = categorizeReason(label);
    if (r.kind === 'category' && r.value !== null) assert.ok((REASON_CATEGORIES as readonly string[]).includes(r.value), label);
  }
});

// ─── What is never read or served ─────────────────────────────────────────────

test('the select is explicit and never reads personal email, note, actor or *', () => {
  assert.ok(!OFFBOARDED_SELECT.includes('*'));
  for (const col of ['personal_email', 'off_boarded_note', 'off_boarded_by', 'synced_at']) {
    assert.ok(!OFFBOARDED_SELECT.split(',').includes(col), col);
    assert.ok(OFFBOARDED_NEVER.some((n) => n.startsWith(col)), `${col} must be listed as never served`);
  }
});

test('a served row carries exactly OFFBOARDED_COLUMNS — even when the DB row carries more', async () => {
  const leaky = { ...row(1), personal_email: 'private@gmail.com', off_boarded_note: 'secret', off_boarded_by: 'hr@simple.biz' };
  const out = await executeOffboardedRead(async () => ({ rows: [leaky as OffboardedLedgerRow], error: null }), Q());
  assert.ok(out.ok);
  assert.deepEqual(Object.keys(out.data[0]), [...OFFBOARDED_COLUMNS]);
  const text = JSON.stringify(out);
  for (const leak of ['private@gmail.com', 'secret', 'hr@simple.biz', 'off_boarded_reason']) assert.ok(!text.includes(leak), leak);
  assert.deepEqual(out.columns, [...OFFBOARDED_COLUMNS]);
});

test('projection normalises start_date, lower-cases the work email and keeps off_boarded_at as stored', async () => {
  const out = await executeOffboardedRead(
    async () => ({ rows: [row(7, { work_email: ' Dave@Simple.biz ', start_date: '6/24/24', off_boarded_reason: 'Performance' })], error: null }),
    Q(),
  );
  assert.ok(out.ok);
  assert.deepEqual(out.data[0], {
    id: 7,
    name: 'Person 7',
    work_email: 'dave@simple.biz',
    department: 'Lead Gen',
    start_date: '2024-06-24',
    off_boarded_at: '2026-09-01T00:00:00+00:00',
    reason: 'performance',
    origin: 'hris',
  });
});

test('a personal inbox in the work_email column is served as null, and cannot be confirmed by a filter', async () => {
  // Measured 2026-10-07: ~110 sheet-era ledger rows hold gmail / yahoo / outlook in work_email.
  const rows = [
    row(1, { work_email: 'Someone@Gmail.com' }),
    row(2, { work_email: 'old@simplesitecompany.com' }),
    row(3, { work_email: 'x@simplebizteam.com' }),
    row(4, { work_email: 'typo@simple.bi' }),
    row(5, { work_email: 'not an address' }),
  ];
  const out = await executeOffboardedRead(async () => ({ rows, error: null }), Q());
  assert.ok(out.ok);
  assert.deepEqual(
    out.data.map((d) => d.work_email),
    [null, 'old@simplesitecompany.com', 'x@simplebizteam.com', null, null],
  );
  assert.ok(!JSON.stringify(out).toLowerCase().includes('gmail'));
  assert.equal(applyOffboardedQuery(rows, Q({ email: 'someone@gmail.com' })).total, 0, '?email= must not confirm a personal inbox');
  assert.equal(applyOffboardedQuery(rows, Q({ search: 'gmail' })).total, 0, '?search= must not find one either');
  assert.equal(applyOffboardedQuery(rows, Q({ email: 'old@simplesitecompany.com' })).total, 1);
});

test('a name cell holding an address is served as null and is not searchable', async () => {
  const rows = [row(1, { name: 'someone@gmail.com' }), row(2, { name: 'Kramer, Dave "Dave"' })];
  const out = await executeOffboardedRead(async () => ({ rows, error: null }), Q());
  assert.ok(out.ok);
  assert.deepEqual(out.data.map((d) => d.name), [null, 'Kramer, Dave "Dave"']);
  assert.equal(applyOffboardedQuery(rows, Q({ search: 'someone' })).total, 0);
});

test('the company domains include today’s WORK_EMAIL_DOMAIN', () => {
  assert.ok(COMPANY_EMAIL_DOMAINS.includes(WORK_EMAIL_DOMAIN));
  for (const d of COMPANY_EMAIL_DOMAINS) assert.doesNotMatch(d, /gmail|yahoo|outlook|hotmail|icloud/);
});

test('an unparseable start date is null, never a guess', async () => {
  const out = await executeOffboardedRead(async () => ({ rows: [row(1, { start_date: 'TBD' })], error: null }), Q());
  assert.ok(out.ok);
  assert.equal(out.data[0].start_date, null);
});

test('a read error is a 500 read_failed, never an empty 200', async () => {
  const out = await executeOffboardedRead(async () => ({ rows: [], error: 'boom' }), Q());
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 500);
    assert.equal(out.denial, 'read_failed');
  }
});

// ─── Exclusions and filters ───────────────────────────────────────────────────

test('temporary pause rows are unreachable by every filter', () => {
  const rows = [row(1), row(2, { off_boarded_reason: 'Temporary Pause', work_email: 'cathyp@simple.biz' })];
  assert.equal(applyOffboardedQuery(rows, Q()).total, 1);
  assert.equal(applyOffboardedQuery(rows, Q({ email: 'cathyp@simple.biz' })).total, 0);
  assert.equal(applyOffboardedQuery(rows, Q({ search: 'cathyp' })).total, 0);
});

test('email matches the work email exactly, case-insensitively', () => {
  const rows = [row(1, { work_email: 'Ann@simple.biz' }), row(2, { work_email: 'annette@simple.biz' })];
  const p = applyOffboardedQuery(rows, Q({ email: 'ann@simple.biz' }));
  assert.deepEqual(p.rows.map((s) => s.row.id), [1]);
});

test('a re-hire who left twice is two rows', () => {
  const rows = [row(10, { work_email: 'x@simple.biz' }), row(20, { work_email: 'x@simple.biz', off_boarded_at: '2026-10-01T00:00:00+00:00' })];
  assert.equal(applyOffboardedQuery(rows, Q({ email: 'x@simple.biz' })).total, 2);
});

test('department is exact and case-insensitive; reason filters the category', () => {
  const rows = [row(1, { department: 'Lead Gen' }), row(2, { department: 'lead gen ' }), row(3, { department: 'Lead Gen QA' })];
  assert.equal(applyOffboardedQuery(rows, Q({ department: 'LEAD GEN' })).total, 2);
  const r2 = [row(1, { off_boarded_reason: 'No Show During Orientation' }), row(2, { off_boarded_reason: 'no_show' }), row(3)];
  assert.equal(applyOffboardedQuery(r2, Q({ reason: 'no_show' })).total, 2);
});

test('since/until are inclusive on the departure date; a row with no date never matches a date filter', () => {
  const rows = [
    row(1, { off_boarded_at: '2026-09-30T23:00:00+00:00' }),
    row(2, { off_boarded_at: '2026-10-01T00:00:00+00:00' }),
    row(3, { off_boarded_at: '2026-10-07T14:04:38.412+00:00' }),
    row(4, { off_boarded_at: null }),
  ];
  assert.deepEqual(applyOffboardedQuery(rows, Q({ since: '2026-10-01' })).rows.map((s) => s.row.id), [2, 3]);
  assert.deepEqual(applyOffboardedQuery(rows, Q({ until: '2026-10-01' })).rows.map((s) => s.row.id), [1, 2]);
  assert.equal(applyOffboardedQuery(rows, Q()).total, 4, 'undated rows are served when no date filter is set');
});

test('search covers name and work email', () => {
  const rows = [row(1, { name: 'Kramer, Dave' }), row(2, { work_email: 'davek@simple.biz' }), row(3)];
  assert.deepEqual(applyOffboardedQuery(rows, Q({ search: 'dave' })).rows.map((s) => s.row.id), [1, 2]);
});

// ─── Paging ───────────────────────────────────────────────────────────────────

test('keyset paging walks the whole ledger, every issued cursor parses, pages are disjoint', () => {
  const rows = Array.from({ length: 1234 }, (_, i) => row(41958 + i * 3));
  const seen = new Set<number>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const parsed = parse(`limit=${MAX_LIMIT}${cursor ? `&cursor=${cursor}` : ''}`);
    assert.ok(parsed.ok, `cursor ${cursor} must round-trip through the parser`);
    if (!parsed.ok) break;
    const p = applyOffboardedQuery(rows, parsed.query);
    for (const s of p.rows) {
      assert.ok(!seen.has(s.row.id), `row ${s.row.id} returned twice`);
      seen.add(s.row.id);
    }
    assert.equal(p.total, 1234);
    cursor = p.nextCursor;
    pages += 1;
  } while (cursor !== null && pages < 10);
  assert.equal(seen.size, 1234);
  assert.equal(pages, 3);
});

test('order is numeric, not lexical (id 9 before id 10)', () => {
  const p = applyOffboardedQuery([row(10), row(9), row(100)], Q());
  assert.deepEqual(p.rows.map((s) => s.row.id), [9, 10, 100]);
});

test('a stored cursor yields only rows recorded after it', () => {
  const p = applyOffboardedQuery([row(1), row(2), row(3)], Q({ cursor: 2 }));
  assert.deepEqual(p.rows.map((s) => s.row.id), [3]);
  assert.equal(p.nextCursor, null);
});

// ─── Parse ────────────────────────────────────────────────────────────────────

test('parse: defaults', () => {
  const p = parse('');
  assert.ok(p.ok);
  if (p.ok) assert.deepEqual(p.query, Q());
});

test('parse: every filter', () => {
  const p = parse('email=Ann@Simple.biz&department=Lead%20Gen&reason=NCNS&since=2026-09-01&until=2026-09-30&search=ann&limit=50&cursor=46420');
  assert.ok(p.ok);
  if (p.ok) {
    assert.deepEqual(p.query, {
      email: 'ann@simple.biz',
      department: 'Lead Gen',
      reason: 'ncns',
      since: '2026-09-01',
      until: '2026-09-30',
      search: 'ann',
      limit: 50,
      cursor: 46420,
    });
  }
});

test('parse: refusals name the field', () => {
  const cases: Array<[string, string]> = [
    ['limit=0', 'limit'],
    [`limit=${MAX_LIMIT + 1}`, 'limit'],
    ['limit=abc', 'limit'],
    ['cursor=00000000-0000-4000-8000-000000000001', 'cursor'],
    ['cursor=-5', 'cursor'],
    ['cursor=1.5', 'cursor'],
    ['email=notanemail', 'email'],
    ['reason=temporary_pause', 'reason'],
    ['reason=fired', 'reason'],
    ['since=2026-02-30', 'since'],
    ['since=09/01/2026', 'since'],
    ['since=2026-10-01&until=2026-09-01', 'until'],
    ['include_temporary_pause=1', 'include_temporary_pause'],
    ['personal_email=x@gmail.com', 'personal_email'],
  ];
  for (const [qs, field] of cases) {
    const p = parse(qs);
    assert.equal(p.ok, false, qs);
    if (!p.ok) assert.ok(p.errors.some((e) => e.field === field), `${qs} → ${JSON.stringify(p.errors)}`);
  }
});

test('MAX_LIMIT stays below the PostgREST 1000-row cap', () => {
  assert.ok(MAX_LIMIT < 1000);
});
