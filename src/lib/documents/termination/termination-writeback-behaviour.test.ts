/** [TERMINATION-DOCS]
 * `applyTerminationWriteBack` — the only irreversible act this feature performs,
 * exercised as the UPDATEs it actually issues.
 *
 * `termination-writeback.test.ts` drives the pure loop
 * (`applyTerminationWriteBackWith`) over a recording port, and pins the module's
 * text. Neither can see what the SUPABASE port does with the decision: whether
 * the guard really rode in the filter chain, whether `.select('id')` was there to
 * make a zero-row UPDATE observable, whether the second attempt is guarded too
 * (an unguarded retry can overwrite another writer's value and then record
 * `before: ''`, so the reverse destroys it), or whether `off_boarded_at` — a
 * TIMESTAMPTZ — is ever handed the empty-string guard.
 *
 * G7's assertions, restated as questions this file answers with recorded
 * operations: only the three allowlisted columns are written; a non-blank cell is
 * never overwritten; zero rows is a SKIP, never a success; every applied write is
 * recorded with `before` distinguishing null from ''; the trail is keyed on
 * `global_master_list.id`, never an email.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTerminationServerStubs } from './test-support/stub-server-modules';
import { setTestSupabaseClient } from './test-support/supabase-server-stub';
import {
  createFakeSupabase,
  type FakeOp,
  type FakeSupabase,
  type FakeTableFixture,
} from './test-support/fake-supabase';
import {
  TERMINATION_WRITEBACK_COLUMNS,
  type TerminationWritebackColumn,
  type TerminationWritebackRecord,
} from './types';

installTerminationServerStubs();

type WritebackModule = typeof import('./termination-writeback');
let loaded: WritebackModule | null = null;
/** Imported lazily so the resolution hook above is installed first. */
async function writebackModule(): Promise<WritebackModule> {
  if (!loaded) loaded = await import('./termination-writeback');
  return loaded;
}

const ROW = '11111111-1111-4111-8111-111111111111';
const REP = 'kaner@simple.biz';

/** Which column an UPDATE was for, read off its payload — the payload is the
 *  only place the column name appears on the write itself. */
function columnOf(op: FakeOp): string {
  return Object.keys(op.payload ?? {})[0] ?? '(none)';
}

function updates(fake: FakeSupabase): FakeOp[] {
  return fake.opsFor('global_master_list').filter((op) => op.action === 'update');
}

/**
 * A `global_master_list` that answers each guarded UPDATE with a row count and
 * each diagnostic re-read with one row.
 *
 * `matched` is asked per UPDATE, so a test can say "the NULL guard matched
 * nothing but the empty-string guard matched one row" — which is the exact
 * sequence the '' case has to walk.
 */
function master(
  matched: (op: FakeOp) => number,
  cell: Record<string, unknown> = {},
): FakeTableFixture {
  return (op) => {
    if (op.action === 'update') {
      return Array.from({ length: matched(op) }, () => ({ id: ROW }));
    }
    return [{ id: ROW, ...cell }];
  };
}

function harness(fixture: FakeTableFixture): FakeSupabase {
  const fake = createFakeSupabase({ tables: { global_master_list: fixture } });
  setTestSupabaseClient(fake.client);
  return fake;
}

/** A sink that records the trail AND where in the operation sequence it was
 *  called, so "persisted before the next cell is touched" is observable. */
function recordingSink(fake: FakeSupabase, fail: string | null = null) {
  const saves: Array<{ columns: string[]; opsSoFar: number }> = [];
  return {
    saves,
    sink: async (records: readonly TerminationWritebackRecord[]): Promise<string | null> => {
      saves.push({ columns: records.map((r) => r.column), opsSoFar: fake.ops.length });
      return fail;
    },
  };
}

// ── The guard rides in the filter chain ─────────────────────────────────────

test('G7: the write is one guarded UPDATE per column — .eq(id) + .is(col,null) + .select(id)', async () => {
  // Blank-only is enforced BY THE DATABASE, in the statement that writes: a
  // read-then-write races the master sync (`global-master-list-db.ts:936` writes
  // "Start Date" from the CSV on every matched row) and every other session on
  // this shared surface. `.select('id')` is the other half — a guard-filtered
  // UPDATE that matches nothing returns `{ data: [], error: null }`, so without
  // it the write reports success while writing nothing.
  const fake = harness(master(() => 1));
  const { applyTerminationWriteBack } = await writebackModule();
  const { sink } = recordingSink(fake);

  const res = await applyTerminationWriteBack({
    masterRowId: ROW,
    values: { off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned', 'Start Date': '2024-01-08' },
    actorEmail: REP,
    persistTrail: sink,
  });

  assert.equal(res.error, null);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(
    res.applied.map((r) => r.column),
    [...TERMINATION_WRITEBACK_COLUMNS],
    'the columns were not written in allowlist order',
  );
  assert.deepEqual(
    res.applied.map((r) => r.before),
    [null, null, null],
    'the NULL guard matched, so every prior state was NULL',
  );

  const ops = updates(fake);
  assert.equal(ops.length, 3, 'one UPDATE per supplied column, and no more');
  for (const op of ops) {
    const column = columnOf(op);
    assert.ok(
      op.chain.includes(`eq(id,${ROW})`),
      `the UPDATE for ${column} was not keyed on the master row id: ${op.chain.join('.')}`,
    );
    assert.ok(
      op.chain.includes(`is(${column},null)`),
      `the UPDATE for ${column} lost its blank-only guard: ${op.chain.join('.')}`,
    );
    assert.ok(
      op.chain.some((c) => c.startsWith('select(')),
      `the UPDATE for ${column} has no .select() — zero rows would read as success`,
    );
    // One key, and it is on the allowlist: the loop iterates the ALLOWLIST, not
    // the caller's keys, so no envelope can name another column.
    assert.deepEqual(Object.keys(op.payload ?? {}), [column]);
    assert.ok(
      (TERMINATION_WRITEBACK_COLUMNS as readonly string[]).includes(column),
      `${column} is not an allowlisted write-back column`,
    );
  }
  assert.deepEqual(
    fake.allChainEntries().filter((c) => c.startsWith('or(')),
    [],
  );
});

test("G7: a cell holding '' is written by a SECOND GUARDED update — never an unguarded one", async () => {
  // `.is(col, null)` cannot express `col = ''`, and these TEXT columns genuinely
  // hold '' (a whole seed migration exists to COALESCE(NULLIF(TRIM(x),'')) around
  // that fact). The second attempt therefore proves blank-ness a different way —
  // `.eq(col, '')`, still in the filter chain, still decided by the database.
  // An UNGUARDED retry would overwrite whatever a concurrent writer had just
  // put there and then record `before: ''`, so the reverse would destroy it.
  const fake = harness(
    master((op) => (op.chain.some((c) => c.startsWith('is(')) ? 0 : 1), {
      off_boarded_reason: '',
    }),
  );
  const { applyTerminationWriteBack } = await writebackModule();
  const { sink } = recordingSink(fake);

  const res = await applyTerminationWriteBack({
    masterRowId: ROW,
    values: { off_boarded_reason: 'resigned' },
    actorEmail: REP,
    persistTrail: sink,
  });

  assert.deepEqual(
    res.applied.map((r) => ({ column: r.column, before: r.before, after: r.after })),
    [{ column: 'off_boarded_reason', before: '', after: 'resigned' }],
    "the '' case did not record before: '' — the reverse would restore NULL",
  );
  const ops = updates(fake);
  assert.equal(ops.length, 2, 'expected the NULL guard and then the empty-string guard');
  assert.ok(ops[0].chain.includes('is(off_boarded_reason,null)'));
  assert.ok(
    ops[1].chain.includes("eq(off_boarded_reason,)"),
    `the second write was not guarded on '': ${ops[1].chain.join('.')}`,
  );
  for (const op of ops) {
    const guards = op.chain.filter((c) => c.startsWith('is(') || c.startsWith('eq('));
    assert.ok(
      guards.length >= 2,
      `an UPDATE ran with only ${guards.join(' + ')} — an unguarded write can clobber a real value`,
    );
  }
});

test('G7: a TIMESTAMPTZ column never gets the empty-string guard', async () => {
  // `off_boarded_at` is `timestamptz`; `= ''` is `22007 invalid input syntax`,
  // and a `before: ''` record for it would make the reverse write '' into that
  // column — the same 22007, permanently un-revertable.
  const fake = harness(master(() => 0, { off_boarded_at: null }));
  const { applyTerminationWriteBack } = await writebackModule();
  const { sink } = recordingSink(fake);

  const res = await applyTerminationWriteBack({
    masterRowId: ROW,
    values: { off_boarded_at: '2026-06-03' },
    actorEmail: REP,
    persistTrail: sink,
  });

  const ops = updates(fake);
  assert.equal(ops.length, 1, 'the empty-string guard was tried on a timestamptz column');
  assert.ok(ops[0].chain.includes('is(off_boarded_at,null)'));
  assert.deepEqual(res.applied, [], 'a write was claimed for a column that matched no row');
  assert.equal(res.skipped.length, 1);
});

// ── Zero rows is a SKIP ─────────────────────────────────────────────────────

test('G7: a cell filled since selection is SKIPPED, and the skip names the value that won', async () => {
  // The rep's answer loses to whoever wrote first. The alternative — widening the
  // guard to a bare `.eq('id', …)` to make the skip go away — is the write this
  // module exists to prevent.
  const fake = harness(master(() => 0, { off_boarded_reason: 'ncns' }));
  const { applyTerminationWriteBack } = await writebackModule();
  const { sink, saves } = recordingSink(fake);

  const res = await applyTerminationWriteBack({
    masterRowId: ROW,
    values: { off_boarded_reason: 'resigned' },
    actorEmail: REP,
    persistTrail: sink,
  });

  assert.deepEqual(res.applied, [], 'a skipped write produced an undo record it cannot honour');
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].column, 'off_boarded_reason');
  assert.equal(res.skipped[0].rowId, ROW);
  assert.match(res.skipped[0].reason, /filled since selection \('ncns'\)/);
  assert.deepEqual(saves, [], 'the undo trail was written for a cell that was never touched');
});

test('G7: a whitespace-only cell is left alone rather than rewritten as \'\'', async () => {
  // `before` can express only NULL and '', so a cell holding '   ' cannot be
  // recorded honestly — and clearing whitespace is a People edit, not a side
  // effect of printing a letter.
  const fake = harness(master(() => 0, { 'Start Date': '   ' }));
  const { applyTerminationWriteBack } = await writebackModule();
  const { sink } = recordingSink(fake);

  const res = await applyTerminationWriteBack({
    masterRowId: ROW,
    values: { 'Start Date': '2024-01-08' },
    actorEmail: REP,
    persistTrail: sink,
  });

  assert.deepEqual(res.applied, []);
  assert.match(res.skipped[0]?.reason ?? '', /not provably blank/);
});

test('G7: a master row that is GONE is a skip, not a write', async () => {
  const fake = harness((op) => (op.action === 'update' ? [] : []));
  const { applyTerminationWriteBack } = await writebackModule();
  const { sink } = recordingSink(fake);

  const res = await applyTerminationWriteBack({
    masterRowId: ROW,
    values: { off_boarded_reason: 'resigned' },
    actorEmail: REP,
    persistTrail: sink,
  });

  assert.deepEqual(res.applied, []);
  assert.match(res.skipped[0]?.reason ?? '', /master row not found/);
});

test('G7: a failed UPDATE is surfaced and skipped, never counted as applied', async () => {
  const fake = harness(() => ({
    data: null,
    error: { message: 'canceling statement due to statement timeout' },
  }));
  const { applyTerminationWriteBack } = await writebackModule();
  const { sink } = recordingSink(fake);

  const res = await applyTerminationWriteBack({
    masterRowId: ROW,
    values: { off_boarded_reason: 'resigned' },
    actorEmail: REP,
    persistTrail: sink,
  });

  assert.deepEqual(res.applied, []);
  assert.match(res.error ?? '', /statement timeout/);
  assert.match(res.skipped[0]?.reason ?? '', /guarded update failed/);
});

// ── The undo trail lands before the next cell is touched ────────────────────

test('G7: the undo trail is persisted after EACH cell, before the next one is written', async () => {
  // The failure this closes: three cells written, then one trailing UPDATE to
  // save the trail — and a crash in between left three permanent master-list
  // changes with no record anywhere, which the reverse script then reported as
  // "Nothing to reverse".
  const fake = harness(master(() => 1));
  const { applyTerminationWriteBack } = await writebackModule();
  const { sink, saves } = recordingSink(fake);

  const res = await applyTerminationWriteBack({
    masterRowId: ROW,
    values: { off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned', 'Start Date': '2024-01-08' },
    actorEmail: REP,
    persistTrail: sink,
  });

  assert.deepEqual(
    saves.map((s) => s.columns),
    [
      ['off_boarded_at'],
      ['off_boarded_at', 'off_boarded_reason'],
      ['off_boarded_at', 'off_boarded_reason', 'Start Date'],
    ],
    'the trail was not saved as it grew',
  );
  // Each save happened while only that many UPDATEs had run: the record for cell
  // N is on disk before cell N+1 is touched.
  assert.deepEqual(saves.map((s) => s.opsSoFar), [1, 2, 3]);
  assert.deepEqual(res.persistedTrail.map((r) => r.column), [...TERMINATION_WRITEBACK_COLUMNS]);
  assert.equal(res.trailError, null);
});

test('G7: a trail that cannot be saved HALTS the write-back — one unrecorded cell, never three', async () => {
  const fake = harness(master(() => 1));
  const { applyTerminationWriteBack } = await writebackModule();
  const { sink } = recordingSink(fake, 'termination_documents update failed');

  const res = await applyTerminationWriteBack({
    masterRowId: ROW,
    values: { off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned', 'Start Date': '2024-01-08' },
    actorEmail: REP,
    persistTrail: sink,
  });

  assert.equal(updates(fake).length, 1, 'the write-back carried on after losing the undo trail');
  assert.deepEqual(res.applied.map((r) => r.column), ['off_boarded_at']);
  assert.deepEqual(res.persistedTrail, [], 'a trail the sink rejected was reported as saved');
  assert.match(res.trailError ?? '', /termination_documents update failed/);
  // The written-but-unrecorded cell is named as the one thing to fix by hand,
  // and the untouched columns say they were not attempted.
  assert.match(res.skipped[0]?.reason ?? '', /WRITTEN but the undo record could not be saved/);
  assert.deepEqual(
    res.skipped.slice(1).map((s) => s.column),
    ['off_boarded_reason', 'Start Date'],
  );
});

// ── It refuses to start ─────────────────────────────────────────────────────

test('G7: no row id and no actor means NO write is attempted at all', async () => {
  const { applyTerminationWriteBack } = await writebackModule();

  for (const args of [
    { masterRowId: '   ', actorEmail: REP, expect: /row id/i },
    { masterRowId: ROW, actorEmail: '  ', expect: /actor/i },
  ]) {
    const fake = harness(master(() => 1));
    const { sink } = recordingSink(fake);
    const res = await applyTerminationWriteBack({
      masterRowId: args.masterRowId,
      values: { off_boarded_reason: 'resigned' },
      actorEmail: args.actorEmail,
      persistTrail: sink,
    });
    assert.match(res.error ?? '', args.expect);
    assert.deepEqual(fake.ops, [], 'an irreversible write ran without a row id or an actor');
  }
});

test('G7: every undo record is keyed on the master row id — never an email', async () => {
  // One work email owns several master rows and /api/hr/offboard stamps every
  // active one, so an email-keyed reverse can restore the wrong row.
  const fake = harness(master(() => 1));
  const { applyTerminationWriteBack } = await writebackModule();
  const { sink } = recordingSink(fake);

  const res = await applyTerminationWriteBack({
    masterRowId: ROW,
    values: { 'Start Date': '2024-01-08' },
    actorEmail: REP,
    persistTrail: sink,
  });

  const record: TerminationWritebackRecord | undefined = res.applied[0];
  assert.equal(record?.rowId, ROW);
  assert.equal(record?.table, 'global_master_list');
  assert.equal(/@/.test(record?.rowId ?? ''), false, 'an email reached the undo record');
  const column: TerminationWritebackColumn = record?.column ?? 'off_boarded_at';
  assert.equal(column, 'Start Date', 'the QUOTED capitalised column name did not survive');
});
