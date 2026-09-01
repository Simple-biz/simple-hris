/** [TERMINATION-DOCS]
 * G7 — the write-back fills blanks only, and is reversible.
 *
 * These tests RUN THE SHIPPED LOOP. `applyTerminationWriteBackWith` is the
 * function `applyTerminationWriteBack` calls; the only thing injected is the
 * port, a two-method seam whose fake records the exact guard every UPDATE
 * carried. There is no mirror of the loop in this file: a mirror is how a
 * deleted skip branch stays green — the previous version of this file folded
 * `decideWriteback` by hand, so removing the module's `if (decision.kind ===
 * 'skip')` left all 1846 tests passing.
 *
 * This file deliberately does NOT import `./termination-writeback`. That module
 * opens `import 'server-only'`, which Node cannot resolve — it is a build-time
 * alias Next supplies, and there is no top-level `node_modules/server-only`, so
 * importing it here would fail to load and take the whole `npm test` run down.
 * It is therefore reduced to the Supabase adapter and pinned by reading its
 * SOURCE; everything that decides anything lives in
 * `./termination-writeback-rules`, which is what runs below. Same split as
 * `src/lib/anthropic/employee-tools.ts` / `employee-tool-defs.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  TERMINATION_WRITEBACK_COLUMNS,
  type TerminationWritebackColumn,
  type TerminationWritebackRecord,
} from './types';
import {
  applyTerminationWriteBackWith,
  canHoldEmptyString,
  decideWriteback,
  isBlankCell,
  readStoredWritebackRecord,
  reverseValueForRecord,
  TERMINATION_EMPTY_STRING_COLUMNS,
  TERMINATION_WRITEBACK_TABLE,
  type TerminationWritebackGuard,
  type TerminationWritebackPort,
  type TerminationWritebackTrailSink,
} from './termination-writeback-rules';

const DIR = path.resolve(process.cwd(), 'src/lib/documents/termination');
const WRITEBACK_SRC = fs.readFileSync(path.join(DIR, 'termination-writeback.ts'), 'utf8');
const CORE_SRC = fs.readFileSync(path.join(DIR, 'termination-writeback-rules.ts'), 'utf8');
const LOG_SRC = fs.readFileSync(path.join(DIR, 'termination-log.ts'), 'utf8');
const REVERT_SRC = fs.readFileSync(
  path.resolve(process.cwd(), 'scripts/revert-termination-doc-writebacks.mts'),
  'utf8',
);
const MIGRATE_SRC = fs.readFileSync(
  path.resolve(process.cwd(), 'scripts/apply-termination-docs-migration.mts'),
  'utf8',
);

/** Source with comments removed, so a rule quoted in prose cannot satisfy — or
 *  break — an assertion about the code. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const ROW_ID = '11111111-1111-4111-8111-111111111111';

/** One call the loop made through the port, with everything it carried. */
interface PortCall {
  op: 'update' | 'read';
  column: TerminationWritebackColumn;
  value?: string;
  guard?: TerminationWritebackGuard;
}

/**
 * What the DATABASE would answer for one column.
 * `nullRows` / `emptyRows` are the row counts the two guarded UPDATEs match —
 * i.e. whether Postgres found the cell NULL, or found it '', at write time.
 * `cell` is what a read finds, and is used ONLY for skip wording.
 */
interface CellState {
  nullRows?: number;
  emptyRows?: number;
  cell?: unknown;
  rowMissing?: boolean;
  updateError?: string;
  readError?: string;
}

function fakePort(cells: Partial<Record<TerminationWritebackColumn, CellState>>): {
  port: TerminationWritebackPort;
  calls: PortCall[];
} {
  const calls: PortCall[] = [];
  const port: TerminationWritebackPort = {
    async updateBlankCell({ column, value, guard }) {
      calls.push({ op: 'update', column, value, guard });
      const state = cells[column] ?? {};
      if (state.updateError) return { rows: 0, error: state.updateError };
      const rows = guard === 'null' ? (state.nullRows ?? 0) : (state.emptyRows ?? 0);
      return { rows, error: null };
    },
    async readCell(column) {
      calls.push({ op: 'read', column });
      const state = cells[column] ?? {};
      if (state.readError) return { found: false, value: undefined, error: state.readError };
      if (state.rowMissing) return { found: false, value: undefined, error: null };
      return { found: true, value: state.cell, error: null };
    },
  };
  return { port, calls };
}

/** Records the trail as the loop persists it, and can fail on the Nth save. */
function fakeSink(failOnSave?: number): {
  sink: TerminationWritebackTrailSink;
  saves: TerminationWritebackRecord[][];
} {
  const saves: TerminationWritebackRecord[][] = [];
  const sink: TerminationWritebackTrailSink = async (records) => {
    saves.push(records.map((r) => ({ ...r })));
    if (failOnSave !== undefined && saves.length === failOnSave) {
      return 'the document row could not be found to attach the undo trail';
    }
    return null;
  };
  return { sink, saves };
}

const NOW = '2026-08-31T02:00:00.000Z';

function run(
  cells: Partial<Record<TerminationWritebackColumn, CellState>>,
  /** Deliberately a bare Record, so a test can hand the loop a key that is NOT
   *  on the allowlist and prove it never reaches the database. */
  values: Record<string, string>,
  opts?: { failSinkOn?: number; rowId?: string },
) {
  const { port, calls } = fakePort(cells);
  const { sink, saves } = fakeSink(opts?.failSinkOn);
  return applyTerminationWriteBackWith(port, {
    rowId: opts?.rowId ?? ROW_ID,
    values: values as Partial<Record<TerminationWritebackColumn, string>>,
    persistTrail: sink,
    nowIso: () => NOW,
  }).then((outcome) => ({ outcome, calls, saves }));
}

const updatesIn = (calls: PortCall[]) => calls.filter((c) => c.op === 'update');

// ── The blank predicate ─────────────────────────────────────────────────────

test('G7: isBlankCell over the documented eight-value table', () => {
  // The guard decides whether a master cell may be OVERWRITTEN, so every false
  // positive here is a destroyed value. `0` is a VALUE, not a blank.
  const inputs: unknown[] = [null, undefined, '', '   ', '\t', 0, 'x', ' x '];
  const expected = [true, true, true, true, true, false, false, false];
  assert.deepEqual(inputs.map(isBlankCell), expected);
});

test('G7: the write-back reaches isBlankCell through the same module the tests do', () => {
  // A second, drifting copy of the predicate inside the server-only module is
  // exactly the CoePreviewFacts failure this feature was designed against.
  assert.match(code(WRITEBACK_SRC), /from '\.\/termination-writeback-rules'/);
  assert.equal(
    /function isBlankCell/.test(code(WRITEBACK_SRC)),
    false,
    'termination-writeback.ts redefined isBlankCell instead of using the shared one',
  );
});

// ── The allowlist pin ───────────────────────────────────────────────────────

test('G7: the write-back allowlist is EXACTLY the three columns', () => {
  // THE POINT: this fails if anyone appends "Department" (the most-clobbered
  // cell in the system — the next master sync reverts a DB-only edit) or any
  // rate column (employee_rate_history / employee_hourly_rates are live pay
  // paths, so a filled-in historical rate silently re-prices paid weeks).
  assert.deepEqual(
    [...TERMINATION_WRITEBACK_COLUMNS],
    ['off_boarded_at', 'off_boarded_reason', 'Start Date'],
  );
  assert.equal(TERMINATION_WRITEBACK_COLUMNS.length, 3);
  for (const forbidden of [
    'Department',
    'Regular Rate',
    'OT Rate',
    'regular_rate',
    'starting_rate',
    'ending_rate',
    'Work Email',
    'Name',
    'start_date',
  ]) {
    assert.equal(
      (TERMINATION_WRITEBACK_COLUMNS as readonly string[]).includes(forbidden),
      false,
      `${forbidden} entered the write-back allowlist`,
    );
  }
  // `Start Date` is a QUOTED capitalised column. A "tidied" snake_case spelling
  // would write to a column that does not exist.
  assert.ok((TERMINATION_WRITEBACK_COLUMNS as readonly string[]).includes('Start Date'));
});

test('G7: only allowlisted columns can be written, whatever the caller sends', async () => {
  // The loop iterates the ALLOWLIST, not the caller's keys — pinned in source
  // because a `for (const col of Object.keys(args.values))` would let a
  // hand-built payload name any column in global_master_list.
  assert.match(code(CORE_SRC), /for \(const column of TERMINATION_WRITEBACK_COLUMNS\)/);
  for (const [name, src] of [
    ['termination-writeback-rules.ts', CORE_SRC],
    ['termination-writeback.ts', WRITEBACK_SRC],
  ] as const) {
    assert.equal(
      /Object\.keys\(args\.values\)|Object\.entries\(args\.values\)/.test(code(src)),
      false,
      `${name} iterated the caller keys instead of the allowlist`,
    );
  }

  // And behaviourally: a key outside the allowlist never reaches the database.
  const withStrayKey: Record<string, string> = {
    off_boarded_reason: 'resigned',
    Department: 'Sales',
    'Regular Rate': '225',
  };
  const { outcome, calls } = await run({ off_boarded_reason: { nullRows: 1 } }, withStrayKey);
  assert.deepEqual(
    updatesIn(calls).map((c) => c.column),
    ['off_boarded_reason'],
  );
  assert.deepEqual(
    outcome.applied.map((r) => r.column),
    ['off_boarded_reason'],
  );
});

test('G7: columns are attempted in allowlist order, not caller order', async () => {
  const { calls } = await run(
    {
      off_boarded_at: { nullRows: 1 },
      off_boarded_reason: { nullRows: 1 },
      'Start Date': { nullRows: 1 },
    },
    { 'Start Date': '2024-01-08', off_boarded_reason: 'resigned', off_boarded_at: '2026-08-18' },
  );
  assert.deepEqual(
    updatesIn(calls).map((c) => c.column),
    ['off_boarded_at', 'off_boarded_reason', 'Start Date'],
  );
});

// ── Blank-ness is proved by the DATABASE, in the filter chain ───────────────

test('G7: a NULL cell is filled by the NULL-guarded UPDATE, and records before: null', async () => {
  const { outcome, calls } = await run(
    { off_boarded_reason: { nullRows: 1 } },
    { off_boarded_reason: 'resigned' },
  );
  assert.deepEqual(updatesIn(calls), [
    { op: 'update', column: 'off_boarded_reason', value: 'resigned', guard: 'null' },
  ]);
  // No read at all: nothing about this decision came from reading the cell.
  assert.equal(
    calls.some((c) => c.op === 'read'),
    false,
    'the write-back read the cell on a path that did not need it',
  );
  assert.deepEqual(outcome.applied, [
    {
      table: 'global_master_list',
      rowId: ROW_ID,
      column: 'off_boarded_reason',
      before: null,
      after: 'resigned',
      appliedAt: NOW,
    },
  ]);
  assert.deepEqual(outcome.skipped, []);
});

test("G7: an '' cell is filled by the SECOND GUARDED update, never by a read-then-write", async () => {
  // THE POINT of this test: the empty-string case used to be an UNGUARDED
  // `.update().eq('id', rowId)` fired after re-reading the cell. A concurrent
  // writer (POST /api/update-employee-profile, or the master sheet sync) landing
  // in that window was silently clobbered, and because the undo record then said
  // `before: ''` the reverse DESTROYED their value permanently. It is now a
  // second guarded UPDATE with `.eq(column, '')` in the filter chain.
  const { outcome, calls } = await run(
    { 'Start Date': { nullRows: 0, emptyRows: 1 } },
    { 'Start Date': '2024-01-08' },
  );
  assert.deepEqual(updatesIn(calls), [
    { op: 'update', column: 'Start Date', value: '2024-01-08', guard: 'null' },
    { op: 'update', column: 'Start Date', value: '2024-01-08', guard: 'empty_string' },
  ]);
  assert.equal(outcome.applied.length, 1);
  assert.equal(outcome.applied[0].before, '');
  assert.deepEqual(outcome.skipped, []);
});

test('G7: a cell neither NULL nor \'\' is NEVER overwritten — no third write exists', async () => {
  // The cell was filled by someone else between selection and generate.
  const { outcome, calls } = await run(
    { off_boarded_reason: { nullRows: 0, emptyRows: 0, cell: 'ncns' } },
    { off_boarded_reason: 'resigned' },
  );
  assert.deepEqual(outcome.applied, [], 'a skipped write produced an undo record it cannot honour');
  assert.equal(outcome.skipped.length, 1);
  assert.equal(outcome.skipped[0].column, 'off_boarded_reason');
  assert.equal(outcome.skipped[0].rowId, ROW_ID);
  // The reason names the value that won, so the rep can see whose it was.
  assert.match(outcome.skipped[0].reason, /filled since selection \('ncns'\)/);
  // Exactly two attempts, both guarded. There is no unguarded fallback to reach.
  assert.equal(updatesIn(calls).length, 2);
  assert.deepEqual(
    updatesIn(calls).map((c) => c.guard),
    ['null', 'empty_string'],
  );
});

test('G7: zero rows from BOTH guards is a SKIP even when the cell then reads blank', async () => {
  // A racing writer blanked the cell after the guards ran. The read exists only
  // to word the skip; it can never cause a write. This is the assertion that
  // fails if anyone reintroduces "re-read, and write if it looks blank".
  const { outcome, calls } = await run(
    { 'Start Date': { nullRows: 0, emptyRows: 0, cell: '' } },
    { 'Start Date': '2024-01-08' },
  );
  assert.deepEqual(outcome.applied, []);
  assert.equal(updatesIn(calls).length, 2);
  assert.match(outcome.skipped[0].reason, /not provably blank at write time/);
});

test('G7: a whitespace-only cell is left alone, and says so', async () => {
  // `before` can express only null and '', so rewriting '   ' as `before: ''`
  // would make "the reverse restores the exact prior state" untrue. Refusing is
  // the honest answer, and it is reported rather than silent.
  const { outcome } = await run(
    { off_boarded_reason: { nullRows: 0, emptyRows: 0, cell: '   ' } },
    { off_boarded_reason: 'resigned' },
  );
  assert.deepEqual(outcome.applied, []);
  assert.match(outcome.skipped[0].reason, /whitespace-only cell is never overwritten/);
  assert.match(outcome.skipped[0].reason, /"   "/);
});

test("G7: off_boarded_at never gets an ''-guarded write — it is TIMESTAMPTZ", async () => {
  // `''` is not a value a timestamp column can hold, and `.eq(col, '')` against
  // it raises 22007. Excluding it is also what makes `before: ''` unreachable
  // there, so the reverse can never write '' into a timestamp.
  assert.deepEqual([...TERMINATION_EMPTY_STRING_COLUMNS], ['off_boarded_reason', 'Start Date']);
  assert.equal(canHoldEmptyString('off_boarded_at'), false);
  assert.equal(canHoldEmptyString('off_boarded_reason'), true);
  assert.equal(canHoldEmptyString('Start Date'), true);

  const { outcome, calls } = await run(
    { off_boarded_at: { nullRows: 0, cell: '2026-07-01T00:00:00+00:00' } },
    { off_boarded_at: '2026-08-18' },
  );
  assert.deepEqual(updatesIn(calls), [
    { op: 'update', column: 'off_boarded_at', value: '2026-08-18', guard: 'null' },
  ]);
  assert.deepEqual(outcome.applied, []);
  assert.equal(outcome.skipped.length, 1);
});

test('G7: a blank supplied value writes nothing at all', async () => {
  const { outcome, calls } = await run(
    { off_boarded_reason: { nullRows: 1 }, 'Start Date': { nullRows: 1 } },
    { off_boarded_reason: '   ', 'Start Date': '' },
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(outcome.applied, []);
  assert.deepEqual(outcome.skipped, []);
});

test('G7: a DB error on a guarded write is a skip, and is surfaced', async () => {
  const { outcome } = await run(
    { off_boarded_reason: { updateError: 'statement timeout' } },
    { off_boarded_reason: 'resigned' },
  );
  assert.deepEqual(outcome.applied, []);
  assert.match(outcome.skipped[0].reason, /guarded update failed: statement timeout/);
  assert.equal(outcome.error, 'statement timeout');
});

test('G7: a master row that is gone is a skip, not an invented write', async () => {
  const { outcome } = await run(
    { off_boarded_reason: { nullRows: 0, emptyRows: 0, rowMissing: true } },
    { off_boarded_reason: 'resigned' },
  );
  assert.deepEqual(outcome.applied, []);
  assert.equal(outcome.skipped[0].reason, 'master row not found');
});

test('G7: the decision table — one guarded UPDATE, one answer', () => {
  // guardedRowCount 1 under the NULL guard ⇒ the cell WAS null.
  assert.deepEqual(decideWriteback({ guardedRowCount: 1, guard: 'null' }), {
    kind: 'apply',
    before: null,
  });
  // 1 under the EMPTY-STRING guard ⇒ the cell WAS ''. The two never collapse,
  // and neither is inferred from a read.
  assert.deepEqual(decideWriteback({ guardedRowCount: 1, guard: 'empty_string' }), {
    kind: 'apply',
    before: '',
  });

  // 0 rows ⇒ SKIP, for either guard. A guard-filtered UPDATE that matches
  // nothing returns `{ data: [], error: null }` — success-shaped, writing nothing.
  for (const guard of ['null', 'empty_string'] as const) {
    assert.equal(decideWriteback({ guardedRowCount: 0, guard }).kind, 'skip');
  }

  // `id` is the primary key, so >1 is impossible; if PostgREST ever says
  // otherwise the write is not attributable to one row and no record may claim
  // it.
  assert.deepEqual(decideWriteback({ guardedRowCount: 2, guard: 'null' }), {
    kind: 'skip',
    reason: 'guarded update matched 2 rows',
  });
});

// ── The undo trail is written as the cells land ─────────────────────────────

test('G7: the trail is persisted after EVERY cell, before the next one is touched', async () => {
  // THE POINT: one trailing UPDATE after all three writes meant a crash, timeout
  // or recycled process in between lost every undo record with no trace — the
  // cells stayed changed and the reverse script reported "nothing to reverse".
  const { outcome, saves } = await run(
    {
      off_boarded_at: { nullRows: 1 },
      off_boarded_reason: { nullRows: 1 },
      'Start Date': { nullRows: 0, emptyRows: 1 },
    },
    {
      off_boarded_at: '2026-08-18',
      off_boarded_reason: 'resigned',
      'Start Date': '2024-01-08',
    },
  );
  assert.equal(outcome.applied.length, 3);
  assert.equal(saves.length, 3, 'the trail was not saved once per applied cell');
  assert.deepEqual(
    saves.map((s) => s.length),
    [1, 2, 3],
    'each save must carry the whole accumulated trail, so a repeat can never shrink it',
  );
  assert.deepEqual(saves[2], outcome.applied);
  assert.deepEqual(outcome.persistedTrail, outcome.applied);
  assert.equal(outcome.trailError, null);
});

test('G7: a trail that cannot be saved STOPS the write-back — one cell, not three', async () => {
  const { outcome, calls, saves } = await run(
    {
      off_boarded_at: { nullRows: 1 },
      off_boarded_reason: { nullRows: 1 },
      'Start Date': { nullRows: 1 },
    },
    {
      off_boarded_at: '2026-08-18',
      off_boarded_reason: 'resigned',
      'Start Date': '2024-01-08',
    },
    { failSinkOn: 1 },
  );
  // The first cell was written; the other two were never attempted.
  assert.deepEqual(
    outcome.applied.map((r) => r.column),
    ['off_boarded_at'],
  );
  assert.deepEqual(
    updatesIn(calls).map((c) => c.column),
    ['off_boarded_at'],
  );
  assert.equal(saves.length, 1);
  // Nothing is claimed as reversible: the record never reached the document row.
  assert.deepEqual(outcome.persistedTrail, []);
  assert.ok(outcome.trailError);
  const reasons = outcome.skipped.map((s) => s.reason);
  assert.match(reasons[0], /WRITTEN but the undo record could not be saved/);
  assert.equal(outcome.skipped.length, 3);
  for (const reason of reasons.slice(1)) {
    assert.match(reason, /not attempted: the undo trail could not be saved/);
  }
});

test('G7: the undo trail is keyed on the master row id, never an email', async () => {
  // One work email owns several global_master_list rows and /api/hr/offboard
  // stamps every active one, so an email-keyed reverse can restore the wrong row.
  const rowId = '33333333-3333-4333-8333-333333333333';
  const { outcome } = await run({ 'Start Date': { nullRows: 1 } }, { 'Start Date': '2024-01-08' }, {
    rowId,
  });
  assert.equal(outcome.applied.length, 1);
  assert.equal(outcome.applied[0].rowId, rowId);
  assert.equal(outcome.applied[0].table, 'global_master_list');
  assert.equal(
    /@/.test(outcome.applied[0].rowId),
    false,
    'an email reached the undo record where a row id belongs',
  );
  assert.equal(TERMINATION_WRITEBACK_TABLE, 'global_master_list');
  assert.match(code(WRITEBACK_SRC), /\.eq\('id', rowId\)/);
});

// ── The reverse round trip ──────────────────────────────────────────────────

test('G7: {before: null} restores null and {before: \'\'} restores \'\' — the two never collapse', () => {
  const rowId = '22222222-2222-4222-8222-222222222222';
  const wasNull: TerminationWritebackRecord = {
    table: 'global_master_list',
    rowId,
    column: 'off_boarded_reason',
    before: null,
    after: 'resigned',
    appliedAt: '2026-08-31T02:00:00.000Z',
  };
  const wasEmpty: TerminationWritebackRecord = { ...wasNull, column: 'Start Date', before: '' };

  assert.equal(reverseValueForRecord(wasNull), null);
  assert.equal(reverseValueForRecord(wasEmpty), '');

  // The records live in `termination_documents.field_writebacks` (jsonb) — the
  // ONLY undo data that exists, since clearAuditLog() truncates audit_log. The
  // distinction has to survive the JSON trip.
  const rehydrated = JSON.parse(JSON.stringify([wasNull, wasEmpty])) as TerminationWritebackRecord[];
  assert.equal(reverseValueForRecord(rehydrated[0]), null);
  assert.equal(reverseValueForRecord(rehydrated[1]), '');
  assert.notEqual(reverseValueForRecord(rehydrated[0]), reverseValueForRecord(rehydrated[1]));

  // The trap this function exists to prevent: `before || null` reports null for
  // both, so a cell that held '' would come back as NULL.
  const collapsed = rehydrated.map((r) => (r.before || null) as null | '');
  assert.deepEqual(collapsed, [null, null], 'control: the naive reverse really does collapse');
  assert.notDeepEqual(rehydrated.map(reverseValueForRecord), collapsed);

  // And through the function the SCRIPT actually calls, on the same data.
  const parsed = rehydrated.map(readStoredWritebackRecord);
  assert.deepEqual(
    parsed.map((p) => (typeof p === 'string' ? p : p.before)),
    [null, ''],
  );
});

test('G7: a record whose `before` was lost in transit restores null, never a guess', () => {
  assert.equal(reverseValueForRecord({}), null);
  assert.equal(reverseValueForRecord({ before: undefined }), null);
  // Anything that is not exactly '' is treated as "the cell did not exist".
  assert.equal(reverseValueForRecord({ before: '  ' }), null);
  assert.equal(reverseValueForRecord({ before: 0 }), null);
});

test('G7: readStoredWritebackRecord is the ONE validator, and it refuses what it cannot honour', () => {
  // The reverse script imports this. When it carried its own copy the two
  // disagreed about the same stored data — the copy refused `before: '  '` while
  // reverseValueForRecord answered `null` — and only the unused one had tests.
  const good = {
    table: 'global_master_list',
    rowId: ROW_ID,
    column: 'off_boarded_reason',
    before: null,
    after: 'resigned',
    appliedAt: NOW,
  };
  assert.deepEqual(readStoredWritebackRecord(good), {
    rowId: ROW_ID,
    column: 'off_boarded_reason',
    before: null,
    after: 'resigned',
  });

  // Extra keys are ignored, which is what lets the script annotate an
  // unreversible record in place with `revert_skipped` and still re-read it.
  assert.deepEqual(
    readStoredWritebackRecord({ ...good, revert_skipped: { why: 'changed since generation' } }),
    { rowId: ROW_ID, column: 'off_boarded_reason', before: null, after: 'resigned' },
  );

  for (const [raw, pattern] of [
    ['not an object', /not an object/],
    [null, /not an object/],
    [[good], /not an object/],
    [{ ...good, table: 'employee_hourly_rates' }, /expected 'global_master_list'/],
    [{ ...good, rowId: '' }, /keyed on global_master_list\.id/],
    // An email where a row id belongs is refused, not guessed at: one work email
    // owns several master rows and the reverse would restore the wrong one.
    [{ ...good, rowId: 'kaner@simple.biz' }, /keyed on global_master_list\.id/],
    [{ ...good, rowId: ROW_ID.slice(0, -1) }, /keyed on global_master_list\.id/],
    [{ ...good, column: 'Department' }, /not in the write-back allowlist/],
    [{ ...good, column: 'Regular Rate' }, /not in the write-back allowlist/],
    [{ ...good, after: '' }, /cannot verify the cell without it/],
    [{ ...good, after: 42 }, /cannot verify the cell without it/],
    [{ ...good, before: '  ' }, /expected null or an empty string/],
    [{ ...good, before: 'resigned' }, /expected null or an empty string/],
  ] as const) {
    const parsed = readStoredWritebackRecord(raw);
    assert.equal(typeof parsed, 'string', `accepted a record it cannot honour: ${JSON.stringify(raw)}`);
    assert.match(parsed as string, pattern);
  }

});

// ── Source pins on the server-only adapter ─────────────────────────────────

test('G7: every UPDATE in the write-back ends in .select() — zero rows must be observable', () => {
  const body = code(WRITEBACK_SRC);
  const chains = body.split('.update(').slice(1);
  assert.ok(chains.length >= 2, 'expected the two guarded updates');
  for (const chain of chains) {
    const statement = chain.split(';')[0];
    assert.match(
      statement,
      /\.select\(/,
      'an UPDATE without .select() reports success while writing nothing',
    );
  }
});

test('G7: BOTH updates carry a guard in the FILTER CHAIN — there is no read-then-write', () => {
  const chains = code(WRITEBACK_SRC).split('.update(').slice(1);
  // The FIRST update proves the cell was NULL. `.is(column, null)` in the chain
  // is what makes the write race-safe against the master sync and every other
  // session on this shared surface; a read-then-write loses that.
  assert.match(
    chains[0].split(';')[0],
    /\.is\(column, null\)/,
    'the first UPDATE lost its blank-only guard',
  );
  assert.equal(chains.length, 2, 'a third UPDATE appeared — every write must be accounted for');
  // The SECOND update proves the cell was ''. It used to be an UNGUARDED write
  // fired after a re-read, which could clobber a value written in between and
  // then record `before: ''` — so the reverse destroyed it permanently. It must
  // carry `.eq(column, '')` and must NOT be an `.is()` (that would be the first
  // guard again, making it dead code).
  const second = chains[1].split(';')[0];
  assert.equal(/\.is\(/.test(second), false, 'the second UPDATE re-used the NULL guard');
  assert.match(
    second,
    /\.eq\(column, ''\)/,
    'the empty-string write lost its guard — it can now overwrite another writer\'s value',
  );
  assert.match(second, /\.eq\('id', rowId\)/);
});

test('G7: the loop lives in the PURE module, so the tested function is the executed one', () => {
  // The adapter must not contain a second copy of the decision loop, and the
  // core must not talk to Supabase. That split is what lets these tests run the
  // real function instead of a mirror.
  assert.match(code(WRITEBACK_SRC), /applyTerminationWriteBackWith\(port, \{/);
  assert.equal(
    /decideWriteback\(\{/.test(code(WRITEBACK_SRC)),
    false,
    'the adapter re-implemented the decision instead of delegating to the core',
  );
  assert.equal(
    /\.update\(|\.from\(MASTER_TABLE\)|supabase/.test(code(CORE_SRC)),
    false,
    'the pure core reached for a database client',
  );
  assert.equal(
    /server-only/.test(code(CORE_SRC)),
    false,
    'the pure core declared server-only, which would make it untestable',
  );
});

test('G7: the write-back names global_master_list and nothing else', () => {
  const body = code(WRITEBACK_SRC);
  const tables = [...body.matchAll(/\.from\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ['MASTER_TABLE'], 'the write-back reached a second table');
  assert.match(body, /const MASTER_TABLE = 'global_master_list'/);
  for (const forbidden of [
    'employee_rate_history',
    'employee_hourly_rates',
    'payment_catalog_pay_structures',
    'paystub_dispatch_queue',
    'disbursement_records',
    'app_settings',
    'offboarded_sheet',
    'offboarding_queue',
    'updateMasterListProfile',
  ]) {
    assert.equal(body.includes(forbidden), false, `the write-back referenced ${forbidden}`);
    assert.equal(code(CORE_SRC).includes(forbidden), false, `the core referenced ${forbidden}`);
  }
});

test('G1: no .or() on an email value anywhere in the two modules', () => {
  // PostgREST parses an .or() argument as `column.op.value`; the dots in an
  // email mis-split the filter into a bogus "column does not exist".
  for (const [name, src] of [
    ['termination-writeback.ts', WRITEBACK_SRC],
    ['termination-writeback-rules.ts', CORE_SRC],
    ['termination-log.ts', LOG_SRC],
    ['revert-termination-doc-writebacks.mts', REVERT_SRC],
  ] as const) {
    assert.equal(/\.or\(/.test(code(src)), false, `${name} used .or()`);
  }
  // Every ILIKE pattern in the log is escaped: `_` is an ILIKE single-char
  // wildcard and is legal in an email local-part, so `a_b@x.com` would match
  // `axb@x.com` — a DIFFERENT person.
  assert.match(code(LOG_SRC), /escapeLikePattern\(/);
});

test('G8: the log names its table with a module-const LITERAL and no other table', () => {
  const body = code(LOG_SRC);
  assert.match(body, /const TABLE = 'termination_documents';/);
  const named = [...body.matchAll(/\.from\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(named)].sort(),
    ['DOCUMENT_REQUESTS_BUCKET', 'TABLE'],
    'a table or bucket other than the two literals was named',
  );
  // A table-name parameter would make the leak proof an assertion again.
  assert.equal(/table\s*[?:]\s*string/.test(body), false, 'the log accepted a table name');
  assert.equal(body.includes('document_requests'), false, 'the log named the employee table');
});

test('G8: log objects live under the termination/ prefix so the revert cannot touch a request', () => {
  const body = code(LOG_SRC);
  assert.match(body, /TERMINATION_STORAGE_PREFIX = 'termination'/);
  assert.match(body, /\$\{TERMINATION_STORAGE_PREFIX\}\//);
});

test('the log read PAGES — PostgREST truncates at 1000 rows even with .range()', () => {
  const body = code(LOG_SRC);
  assert.match(body, /selectAllPaged</);
  assert.equal(
    /\.limit\(/.test(body),
    false,
    'a .limit() in the log read is silently capped at 1000 rows',
  );
});

test('the irreversible write is AUDITED after it runs, not before', () => {
  // The generation audit row is inserted BEFORE the write-back, so its
  // field_writebacks is always [] — for three days that was the only audit of an
  // irreversible master-list write, and it recorded nothing.
  const log = code(LOG_SRC);
  assert.match(log, /export async function auditTerminationWriteback\(/);
  assert.match(log, /'documents\.termination_writeback'/);
  assert.match(log, /field_writebacks: params\.applied/);

  const route = code(
    fs.readFileSync(
      path.resolve(process.cwd(), 'app/api/accounting/documents/termination/route.ts'),
      'utf8',
    ),
  );
  assert.match(route, /auditTerminationWriteback\(\{/);
  // The audit call must come AFTER the write-back call.
  assert.ok(
    route.indexOf('applyTerminationWriteBack({') < route.indexOf('auditTerminationWriteback({'),
    'the write-back was audited before it ran',
  );
  // And the trail is persisted incrementally, as the sink, not once at the end.
  assert.match(route, /persistTrail: \(records\) => persistWritebackTrail\(row\.id, records\)/);
  assert.match(route, /writebacks\.push\(\.\.\.wb\.persistedTrail\)/);
});

test('both server modules declare server-only, which is why this file reads them instead', () => {
  // If either loses the marker it becomes importable from a client component,
  // and the service-role client would be bundled toward the browser.
  assert.match(WRITEBACK_SRC, /^import 'server-only';$/m);
  assert.match(LOG_SRC, /^import 'server-only';$/m);
});

// ── Source pins on the two scripts (outside `src/**`, so `npm test` cannot run
//    them — a grep is the only executable proof) ─────────────────────────────

test('the reverse script IMPORTS the shared rule instead of reimplementing it', () => {
  const body = code(REVERT_SRC);
  assert.match(body, /from '\.\.\/src\/lib\/documents\/termination\/termination-writeback-rules'/);
  assert.match(body, /readStoredWritebackRecord\(/);
  assert.match(body, /TERMINATION_WRITEBACK_COLUMNS/);
  // Its own copies are what diverged from the tested rule.
  assert.equal(
    /function readRecord\(/.test(body),
    false,
    'the script re-declared the record validator',
  );
  assert.equal(
    /const WRITEBACK_COLUMNS = \[/.test(body),
    false,
    'the script re-declared the column allowlist',
  );
  assert.equal(
    /t\.before \|\| null|record\.before \|\| null/.test(body),
    false,
    "the script collapsed '' into null on the restore",
  );
  // Every UPDATE it makes is observable and filtered.
  for (const chain of body.split('.update(').slice(1)) {
    const statement = chain.split(';')[0];
    assert.match(statement, /\.select\(/, 'an UPDATE without .select() reports a phantom success');
  }
});

test('the reverse DRY RUN performs the same verification as --apply', () => {
  const body = code(REVERT_SRC);
  // The `.eq(column, after)` filter — the only trustworthy equality test, since
  // off_boarded_at is TIMESTAMPTZ and a client-side string compare would skip
  // every date record — appears on the read-only probe AND on the UPDATE.
  assert.ok(
    (body.match(/\.eq\(t\.column, t\.after\)/g) ?? []).length >= 2,
    'the dry run does not run the verification the write relies on',
  );
  assert.match(body, /WOULD-SKIP/);
  assert.match(body, /WOULD-RESTORE/);
  // Dry run stays the default, for --accept-skipped too.
  assert.match(body, /const APPLY = args\.includes\('--apply'\)/);
});

test('the prune is a COMPARE-AND-SET, never a blind whole-array overwrite', () => {
  // `next` is planned from the array read at SCAN START, and generation appends
  // undo records to the same column while this script runs (route.ts persists
  // the trail incrementally). Writing the planned array back on `.eq('id', …)`
  // alone destroyed any record created in between — silently, while the run
  // still reported a clean teardown.
  const body = code(REVERT_SRC);
  assert.match(body, /async function readWritebackArray\(/);
  assert.match(body, /const fresh = await readWritebackArray\(doc\.id\)/);
  assert.match(body, /sameStoredValue\(scanned, fresh\.value\)/);

  const prune = body.split('update({ field_writebacks: next })')[1]?.split(';')[0] ?? '';
  assert.ok(prune, 'the prune UPDATE is no longer recognisable');
  assert.match(prune, /\.eq\('id', doc\.id\)/);
  assert.match(
    prune,
    /\.eq\('field_writebacks', JSON\.stringify\(fresh\.value\)\)/,
    'the prune UPDATE does not carry the observed array as a filter',
  );
  assert.match(prune, /\.select\('id'\)/);

  // A row that moved under the run is SKIPPED and the run exits non-zero.
  assert.match(body, /concurrent\+\+/);
  assert.match(body, /const failures = errors \+ clearFailed \+ concurrent;/);
});

test('a skipped record can be retired, and the drop script says how', () => {
  const body = code(REVERT_SRC);
  assert.match(body, /--accept-skipped/);
  assert.match(body, /revert_skipped/);
  // The pruned array keeps ONLY what could not be reversed, annotated — a whole
  // row's array is no longer held hostage by one unverifiable record.
  assert.match(body, /remainingRecordsFor\(/);

  const drop = fs.readFileSync(
    path.resolve(process.cwd(), 'references/sql/fix/drop_termination_docs.sql'),
    'utf8',
  );
  assert.match(drop, /--accept-skipped/);
  assert.match(drop, /revert_skipped/);
  assert.match(drop, /jsonb_array_length\(field_writebacks\) > 0/);
});

test('both scripts resolve their paths from the module, never from cwd', () => {
  // .gitignore's `references/backups/` is anchored to the repo root, so a
  // relative literal run from `scripts/` wrote whole global_master_list rows —
  // names, addresses, employee ids — to a path git would offer for commit.
  for (const [name, src] of [
    ['revert-termination-doc-writebacks.mts', REVERT_SRC],
    ['apply-termination-docs-migration.mts', MIGRATE_SRC],
  ] as const) {
    const body = code(src);
    assert.match(body, /fileURLToPath\(import\.meta\.url\)/, `${name} still trusts cwd`);
    assert.match(body, /const REPO_ROOT = path\.resolve\(/, `${name} has no repo root`);
    assert.match(body, /dotenv\.config\(\{ path: path\.join\(REPO_ROOT, '\.env\.local'\) \}\)/);
  }
  const revert = code(REVERT_SRC);
  assert.equal(
    /path\.join\('references', 'backups'\)/.test(revert),
    false,
    'the backup directory is a relative literal again',
  );
  assert.match(revert, /const BACKUP_DIR = path\.join\(REPO_ROOT, 'references', 'backups'\)/);
  // And it refuses to run unless that directory is the gitignored one.
  assert.match(revert, /assertBackupDirIsGitignored\(\)/);
  assert.match(revert, /GITIGNORE_PATH/);

  const migrate = code(MIGRATE_SRC);
  assert.equal(
    /const SQL_PATH = 'references/.test(migrate),
    false,
    'the migration SQL path is a relative literal again',
  );
  assert.match(migrate, /const SQL_PATH = path\.join\(REPO_ROOT/);
});
