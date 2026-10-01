/**
 * The scheduled-deletion reaper never deletes someone who is here (audit item 301).
 *
 * Measured 2026-10-01: of 83 overdue legacy timers, three belong to people who are working — a
 * rehire on a new row with the same work email, a person with no live row who logged Hubstaff time
 * on the account in the live week, and a rehire on a new work email whose personal email is live.
 * Each failure class below is one of those, or the read that would have to be right to catch it.
 *
 * The loader runs against the recording PostgREST double (1000-row pages, no env file read), so a
 * truncated or failed read is proven to fail CLOSED rather than read as "nobody is here".
 *
 * Run:  npx tsx --test src/lib/hr/deletion-hold.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createFakeSupabase,
  type FakeOp,
  type FakeTableFixture,
} from '@/lib/documents/termination/test-support/fake-supabase';
import {
  deletionHoldReasons,
  loadDeletionGuardIndex,
  normEmail,
  splitDueDeletions,
  type DeletionGuardIndex,
} from './deletion-hold';

const EMPTY: DeletionGuardIndex = {
  liveWorkEmails: new Set(),
  livePersonalEmails: new Set(),
  pendingHires: [],
  hubstaffWorkedEmails: new Set(),
};

const idx = (over: Partial<DeletionGuardIndex>): DeletionGuardIndex => ({ ...EMPTY, ...over });

const LEFT = '2026-07-30T04:00:00+00:00';

// ── The pure rule ──────────────────────────────────────────────────────────────────────────────

test('no signal: the row may fire', () => {
  assert.deepEqual(
    deletionHoldReasons({ workEmail: 'gone@simple.biz', personalEmail: 'gone@gmail.com', leftAt: LEFT }, EMPTY),
    [],
  );
});

test('class 1/2: the work email is on a live row (rehire on a new row, or a recycled address) → hold', () => {
  const r = deletionHoldReasons(
    { workEmail: 'markg@simple.biz', personalEmail: null, leftAt: LEFT },
    idx({ liveWorkEmails: new Set(['markg@simple.biz']) }),
  );
  assert.deepEqual(r, ['work_email_on_live_row']);
});

test('class 3: rehired on a NEW work email, the personal email is live → hold', () => {
  const r = deletionHoldReasons(
    { workEmail: 'old@simple.biz', personalEmail: 'person@gmail.com', leftAt: LEFT },
    idx({ livePersonalEmails: new Set(['person@gmail.com']) }),
  );
  assert.deepEqual(r, ['personal_email_on_live_row']);
});

test('class 3: a blank personal email never matches, even against a blank live one', () => {
  const r = deletionHoldReasons(
    { workEmail: 'old@simple.biz', personalEmail: '   ', leftAt: LEFT },
    idx({ livePersonalEmails: new Set(['']) }),
  );
  assert.deepEqual(r, []);
});

test('class 4: no live row, but worked time on the account in the live Hubstaff week → hold', () => {
  const r = deletionHoldReasons(
    { workEmail: 'invisible@simple.biz', personalEmail: null, leftAt: LEFT },
    idx({ hubstaffWorkedEmails: new Set(['invisible@simple.biz']) }),
  );
  assert.deepEqual(r, ['hubstaff_time_in_live_week']);
});

test('class 5: a hire in flight on the address holds, whatever its date', () => {
  for (const status of ['pending_work_email', 'ready', 'failed_to_promote']) {
    const r = deletionHoldReasons(
      { workEmail: 'a@simple.biz', personalEmail: null, leftAt: LEFT },
      idx({ pendingHires: [{ id: 1, work_email: 'a@simple.biz', status, created_at: '2026-01-01T00:00:00Z' }] }),
    );
    assert.deepEqual(r, ['later_hire_on_work_email'], status);
  }
});

test('class 5: a promoted hire AFTER the departure holds; the original stint BEFORE it does not', () => {
  const later = deletionHoldReasons(
    { workEmail: 'a@simple.biz', personalEmail: null, leftAt: LEFT },
    idx({ pendingHires: [{ id: 2, work_email: 'a@simple.biz', status: 'promoted', created_at: '2026-08-20T00:00:00Z' }] }),
  );
  assert.deepEqual(later, ['later_hire_on_work_email']);
  const original = deletionHoldReasons(
    { workEmail: 'a@simple.biz', personalEmail: null, leftAt: LEFT },
    idx({ pendingHires: [{ id: 3, work_email: 'a@simple.biz', status: 'promoted', created_at: '2026-05-01T00:00:00Z' }] }),
  );
  assert.deepEqual(original, []);
});

test('class 5: an unknown departure date or hire date cannot prove the hire came first → hold', () => {
  const noLeft = deletionHoldReasons(
    { workEmail: 'a@simple.biz', personalEmail: null, leftAt: null },
    idx({ pendingHires: [{ id: 4, work_email: 'a@simple.biz', status: 'promoted', created_at: '2026-05-01T00:00:00Z' }] }),
  );
  assert.deepEqual(noLeft, ['later_hire_on_work_email']);
  const noCreated = deletionHoldReasons(
    { workEmail: 'a@simple.biz', personalEmail: null, leftAt: LEFT },
    idx({ pendingHires: [{ id: 5, work_email: 'a@simple.biz', status: 'promoted', created_at: null }] }),
  );
  assert.deepEqual(noCreated, ['later_hire_on_work_email']);
});

test('class 5: cancelled and no-show hires on the address do not hold', () => {
  const r = deletionHoldReasons(
    { workEmail: 'a@simple.biz', personalEmail: null, leftAt: LEFT },
    idx({
      pendingHires: [
        { id: 6, work_email: 'a@simple.biz', status: 'cancelled', created_at: '2026-09-01T00:00:00Z' },
        { id: 7, work_email: 'a@simple.biz', status: 'no_show', created_at: '2026-09-01T00:00:00Z' },
      ],
    }),
  );
  assert.deepEqual(r, []);
});

test('class 7: a no-show row is never its own later hire, but a second hire on its address holds it', () => {
  const own = { id: 9, work_email: 'ns@simple.biz', status: 'no_show', created_at: '2026-07-01T00:00:00Z' };
  assert.deepEqual(
    deletionHoldReasons(
      { workEmail: 'ns@simple.biz', personalEmail: null, leftAt: own.created_at, ownPendingId: 9 },
      idx({ pendingHires: [{ ...own, status: 'ready' }] }),
    ),
    [],
    'the row itself, whatever status the index read it at, is excluded by id',
  );
  assert.deepEqual(
    deletionHoldReasons(
      { workEmail: 'ns@simple.biz', personalEmail: null, leftAt: own.created_at, ownPendingId: 9 },
      idx({ pendingHires: [own, { id: 10, work_email: 'ns@simple.biz', status: 'ready', created_at: '2026-08-01T00:00:00Z' }] }),
    ),
    ['later_hire_on_work_email'],
  );
});

test('class 8: case and whitespace drift on either side still matches', () => {
  assert.equal(normEmail('  MarkG@Simple.BIZ '), 'markg@simple.biz');
  assert.equal(normEmail(''), null);
  assert.equal(normEmail(null), null);
  const r = deletionHoldReasons(
    { workEmail: ' MarkG@Simple.biz', personalEmail: 'Person@Gmail.com ', leftAt: LEFT },
    idx({
      liveWorkEmails: new Set(['markg@simple.biz']),
      livePersonalEmails: new Set(['person@gmail.com']),
      pendingHires: [{ id: 11, work_email: 'MARKG@simple.biz ', status: 'ready', created_at: null }],
      hubstaffWorkedEmails: new Set(['markg@simple.biz']),
    }),
  );
  assert.deepEqual(r, [
    'work_email_on_live_row',
    'personal_email_on_live_row',
    'later_hire_on_work_email',
    'hubstaff_time_in_live_week',
  ]);
});

test('splitDueDeletions keeps order, fires only the clean rows, and reports every held one', () => {
  const due = [
    { w: 'gone1@simple.biz' },
    { w: 'Back@simple.biz' },
    { w: 'gone2@simple.biz' },
  ];
  const { fire, held } = splitDueDeletions(
    due,
    (r) => ({ workEmail: r.w, personalEmail: null, leftAt: LEFT }),
    idx({ liveWorkEmails: new Set(['back@simple.biz']) }),
  );
  assert.deepEqual(fire.map((r) => r.w), ['gone1@simple.biz', 'gone2@simple.biz']);
  assert.deepEqual(held, [{ work_email: 'back@simple.biz', reasons: ['work_email_on_live_row'] }]);
});

// ── The loader: paged, and fail-closed ─────────────────────────────────────────────────────────

const MASTER = 'global_master_list';
const HUBSTAFF = 'hubstaff_hours';
const UPLOAD_ID = 'upload-live';

function liveRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${String(i).padStart(5, '0')}`,
    'Work Email': `person${i}@simple.biz`,
    'Personal Email': i % 2 ? `person${i}@gmail.com` : null,
  }));
}

function baseTables(over: Record<string, FakeTableFixture> = {}): Record<string, FakeTableFixture> {
  return {
    [MASTER]: liveRows(1500),
    hr_pending_employees: Array.from({ length: 1200 }, (_, i) => ({
      id: i,
      work_email: `hire${i}@simple.biz`,
      status: 'promoted',
      created_at: '2026-09-01T00:00:00Z',
    })),
    hubstaff_uploads: [{ id: UPLOAD_ID }],
    [HUBSTAFF]: [
      ...Array.from({ length: 1100 }, (_, i) => ({ id: `h${i}`, Email: `worker${i}@simple.biz`, 'Total worked': '0:00:00' })),
      { id: 'h-inv', Email: 'Invisible@simple.biz', 'Total worked': '0:09:54' },
    ],
    ...over,
  };
}

async function load(tables: Record<string, FakeTableFixture>) {
  const fake = createFakeSupabase({ tables });
  const out = await loadDeletionGuardIndex(fake.client as SupabaseClient, {
    masterTable: MASTER,
    hubstaffTable: HUBSTAFF,
  });
  return { out, fake };
}

test('class 6: every read pages past 1000 rows, so the tail of the roster is never dropped', async () => {
  const { out, fake } = await load(baseTables());
  assert.equal(out.error, null);
  assert.ok(out.index);
  assert.ok(out.index.liveWorkEmails.has('person1499@simple.biz'), 'row 1,500 of the live roster is indexed');
  assert.ok(out.index.livePersonalEmails.has('person1499@gmail.com'));
  assert.equal(out.index.pendingHires.length, 1200);
  assert.ok(out.index.hubstaffWorkedEmails.has('invisible@simple.biz'), 'the 1,101st Hubstaff row is read');
  assert.ok(!out.index.hubstaffWorkedEmails.has('worker0@simple.biz'), 'a zero-time row is not "working"');
  assert.deepEqual(
    fake.opsFor(MASTER).map((op) => [op.from, op.to]),
    [[0, 999], [1000, 1999]],
  );
});

test('class 6: the live read is the not-off-boarded set, and the Hubstaff read is the current upload', async () => {
  const { fake } = await load(baseTables());
  const master = fake.opsFor(MASTER)[0];
  assert.ok(master.chain.includes('is(off_boarded_at,null)'), master.chain.join(' '));
  assert.ok(fake.opsFor('hubstaff_uploads')[0].chain.includes('eq(is_current,true)'));
  assert.ok(fake.opsFor(HUBSTAFF)[0].chain.includes(`eq(upload_id,${UPLOAD_ID})`));
});

test('class 6: ANY failed read returns an error, never a partial index', async () => {
  const fail = (_op: FakeOp) => ({ data: null, error: { message: 'boom' } });
  for (const table of [MASTER, 'hr_pending_employees', 'hubstaff_uploads', HUBSTAFF]) {
    const { out } = await load(baseTables({ [table]: fail }));
    assert.equal(out.index, null, table);
    assert.match(String(out.error), /boom/, table);
  }
});

test('class 6: a SECOND-page failure is still a failure, not "the first 1000 were everyone"', async () => {
  const rows = liveRows(1500);
  const { out } = await load(
    baseTables({
      [MASTER]: (op: FakeOp) =>
        op.from === 0 ? rows.slice(0, 1000) : { data: null, error: { message: 'page 2 died' } },
    }),
  );
  assert.equal(out.index, null);
  assert.match(String(out.error), /page 2 died/);
});

test('class 6: no current Hubstaff upload means live-week time cannot be checked → error', async () => {
  const { out } = await load(baseTables({ hubstaff_uploads: [] }));
  assert.equal(out.index, null);
  assert.match(String(out.error), /no current Hubstaff upload/);
});

// ── The route: nothing fires before the guard, and only cleared rows fire ─────────────────────

test('the route loads the guard before the first webhook, aborts on its error, and fires only cleared rows', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'app/api/cron/process-scheduled-deletions/route.ts'),
    'utf8',
  );
  const guardAt = src.indexOf('await loadDeletionGuardIndex(');
  const firstFire = src.indexOf('await fireOffboardWebhook(');
  assert.ok(guardAt > 0 && firstFire > guardAt, 'the guard is read before any webhook fires');
  assert.match(src, /if \(guard\.error !== null\) \{\s*return NextResponse\.json\(/, 'a guard error returns');
  assert.match(src, /for \(const row of fireMaster\)/);
  assert.match(src, /for \(const row of firePending\)/);
  assert.doesNotMatch(src, /for \(const row of due\)/, 'the raw master queue is never iterated');
  assert.doesNotMatch(src, /for \(const row of duePending\)/, 'the raw no-show queue is never iterated');
  // Both queues are read before any webhook fires, so a failed second read cannot half-run a pass.
  assert.ok(src.indexOf('.from("hr_pending_employees")') < firstFire);
});
