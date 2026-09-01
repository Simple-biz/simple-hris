/** [TERMINATION-DOCS]
 * `createTerminationDocument`, `auditTerminationWriteback`,
 * `listTerminationDocuments`, `getTerminationDocumentById` — the writes and the
 * reads, as operations.
 *
 * G8 (zero leak to the employee surface) rests on a LITERAL: `TABLE` is a module
 * const and every read and write names it as `TABLE`. Until now that was checked
 * by reading the file's text. Text cannot see what a function actually did with
 * a `.from()`, whether an uploaded object was cleaned up after a failed insert,
 * whether the audit row was awaited, or whether the log read follows a full
 * 1000-row page with another — and this table gains a row per letter.
 *
 * Everything runs against the recording double in `./test-support/`. No
 * database, no storage bucket, and the client factory itself is replaced, so the
 * PRODUCTION credentials in `.env.local` are unreachable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTerminationServerStubs } from './test-support/stub-server-modules';
import { setTestSupabaseClient } from './test-support/supabase-server-stub';
import {
  chainArgs,
  createFakeSupabase,
  type FakeSupabase,
  type FakeStorageFixture,
  type FakeTableFixture,
} from './test-support/fake-supabase';
import { ilikeTableFixture } from './test-support/ilike-fixture';
import { DOCUMENT_REQUESTS_BUCKET } from '@/lib/documents/types';
import type { TerminationFacts, TerminationWritebackRecord } from './types';

installTerminationServerStubs();

type LogModule = typeof import('./termination-log');
let loaded: LogModule | null = null;
/** Imported lazily so the resolution hook above is installed first. */
async function logModule(): Promise<LogModule> {
  if (!loaded) loaded = await import('./termination-log');
  return loaded;
}

const LEAVER = 'carlath@simple.biz';
const SHARED_GMAIL = 'carlathomas0112@gmail.com';
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const MASTER_ROW = '22222222-2222-4222-8222-222222222222';
const REP = 'kaner@simple.biz';

/** Minimal real PDF head — `looksLikePdf` refuses anything else, which is what
 *  keeps a renderer that silently produced HTML out of the log. */
function pdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.7\n% termination letter\n');
}

function facts(over: Partial<TerminationFacts> = {}): TerminationFacts {
  return {
    identity: {
      workEmail: LEAVER,
      personalEmail: SHARED_GMAIL,
      masterRowId: MASTER_ROW,
      onCurrentUpload: false,
      candidateRowIds: [MASTER_ROW],
      matchedColumn: 'Work Email',
      offDateSource: 'global_master_list',
    },
    workerName: 'Carla Thomas',
    terminationDate: '2026-06-03',
    terminationDateLabel: 'June 3, 2026',
    reasonKey: 'resigned',
    reasonLabel: 'Resigned',
    rawReason: 'resigned',
    endingDepartmentRaw: 'hsl:intake_specialist',
    endingDepartmentLabel: 'HSL — Intake Specialist',
    startDate: '2024-01-08',
    startDateLabel: 'January 8, 2024',
    startingRate: { amount: 225, currency: 'PHP', source: 'hr_pending', blankReason: null },
    endingRate: { amount: 262.5, currency: 'PHP', source: 'disbursement_record', blankReason: null },
    blanks: [],
    degraded: [],
    ...over,
  };
}

function storedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DOC_ID,
    work_email: LEAVER,
    personal_email: SHARED_GMAIL,
    worker_name: 'Carla Thomas',
    termination_date: '2026-06-03',
    reason_key: 'resigned',
    reason_label: 'Resigned',
    ending_department_label: 'HSL — Intake Specialist',
    generated_by: REP,
    generated_at: '2026-08-31T02:00:00.000Z',
    file_path: `termination/carlath_simple.biz/${DOC_ID}/termination.pdf`,
    file_name: 'termination-letter-carla-thomas-2026-06-03.pdf',
    field_writebacks: [],
    ...over,
  };
}

function harness(
  tables: Record<string, FakeTableFixture>,
  storage: Record<string, FakeStorageFixture> = {
    [DOCUMENT_REQUESTS_BUCKET]: { upload: () => ({ error: null }) },
  },
): FakeSupabase {
  const fake = createFakeSupabase({ tables, storage });
  setTestSupabaseClient(fake.client);
  return fake;
}

/** The healthy world: the insert echoes a row back, the audit lands, and
 *  `resolveUserRole` can read its table. */
function writableTables(over: Record<string, FakeTableFixture> = {}) {
  return {
    termination_documents: () => ({ data: [storedRow()], error: null }),
    audit_log: [] as Record<string, unknown>[],
    employee_roles: [] as Record<string, unknown>[],
    ...over,
  };
}

// ── G8: the table and the storage prefix, at runtime ────────────────────────

test('G8: the letter is written to termination_documents under the termination/ prefix — never a document_requests row', async () => {
  // `document_requests` is the table `GET /api/employee/documents` serves. The
  // separate table IS the leak proof, so what matters is which table the write
  // actually named, not which literal the source contains.
  const fake = harness(writableTables());
  const { createTerminationDocument } = await logModule();

  const res = await createTerminationDocument({
    facts: facts(),
    filled: [],
    bytes: pdfBytes(),
    generatedBy: REP,
    generatedByName: 'Kane R',
    generatedByTitle: 'Head of Accounting',
    generatedAtIso: '2026-08-31T02:00:00.000Z',
    documentId: DOC_ID,
    writebacks: [],
  });

  assert.equal(res.error, null);
  assert.equal(res.row?.id, DOC_ID);
  assert.deepEqual(
    [...new Set(fake.ops.map((op) => op.table))].sort(),
    ['audit_log', 'employee_roles', 'termination_documents'],
    'the log write reached a table nobody declared',
  );
  const insert = fake.opsFor('termination_documents')[0];
  assert.equal(insert.action, 'insert');
  assert.equal(insert.payload?.work_email, LEAVER);
  assert.equal(insert.payload?.master_row_id, MASTER_ROW);
  // The RAW `hsl:*` cell is stored for audit; only the formatted label is the
  // human-readable column, and the DDL forbids `hsl:%` there.
  assert.equal(insert.payload?.ending_department_raw, 'hsl:intake_specialist');
  assert.equal(insert.payload?.ending_department_label, 'HSL — Intake Specialist');

  const upload = fake.storageOps.find((op) => op.action === 'upload');
  assert.equal(upload?.bucket, DOCUMENT_REQUESTS_BUCKET);
  assert.ok(
    upload?.path.startsWith('termination/'),
    `the object landed outside the termination/ prefix: ${upload?.path}`,
  );
  assert.ok(upload?.path.includes(DOC_ID), 'the object path does not carry the document id');
});

test('the audit row is written AFTER the log row, and its failure fails the generation', async () => {
  // Deliberate departure from the Documents precedent's fire-and-forget audit
  // write: an unaudited irreversible act is exactly what this row exists to
  // explain later. The letter and its object STAY — deleting them to "clean up"
  // would destroy the only undo data.
  const failingAudit: FakeTableFixture = () => ({
    data: null,
    error: { message: 'audit_log check constraint violated' },
  });
  const fake = harness(writableTables({ audit_log: failingAudit }));
  const { createTerminationDocument } = await logModule();

  const res = await createTerminationDocument({
    facts: facts(),
    filled: [],
    bytes: pdfBytes(),
    generatedBy: REP,
    generatedByName: null,
    generatedByTitle: null,
    generatedAtIso: '2026-08-31T02:00:00.000Z',
    documentId: DOC_ID,
    writebacks: [],
  });

  assert.equal(res.row, null, 'a generation with no audit row reported success');
  assert.match(res.error ?? '', /Audit write failed/);
  assert.match(res.error ?? '', new RegExp(DOC_ID), 'the error does not name the logged document');
  const order = fake.ops.map((op) => op.table);
  assert.ok(
    order.indexOf('termination_documents') < order.lastIndexOf('audit_log'),
    'the audit row was written before the document row existed',
  );
  assert.deepEqual(
    fake.storageOps.filter((op) => op.action === 'remove'),
    [],
    'the stored letter was deleted after a failed AUDIT write — that is the undo data',
  );
});

test('a failed row insert removes the uploaded object instead of stranding PII in the bucket', async () => {
  const removed: string[] = [];
  const fake = harness(
    writableTables({
      termination_documents: () => ({
        data: null,
        error: { message: 'relation "termination_documents" does not exist' },
      }),
    }),
    {
      [DOCUMENT_REQUESTS_BUCKET]: {
        upload: () => ({ error: null }),
        remove: (paths) => {
          removed.push(...paths);
          return { error: null };
        },
      },
    },
  );
  const { createTerminationDocument } = await logModule();

  const res = await createTerminationDocument({
    facts: facts(),
    filled: [],
    bytes: pdfBytes(),
    generatedBy: REP,
    generatedByName: null,
    generatedByTitle: null,
    generatedAtIso: '2026-08-31T02:00:00.000Z',
    documentId: DOC_ID,
    writebacks: [],
  });

  assert.equal(res.row, null);
  assert.match(res.error ?? '', /termination_documents/);
  assert.equal(removed.length, 1, 'the uploaded letter was left in the bucket with no row');
  assert.ok(removed[0].startsWith('termination/'));
  assert.deepEqual(
    fake.opsFor('audit_log'),
    [],
    'an audit row claimed a document that was never inserted',
  );
});

// ── Nothing unrenderable or unloggable is ever uploaded ─────────────────────

test('every refusal happens BEFORE the upload — no object, no row, no audit', async () => {
  // `describeUnloggableFacts` restates the DDL's CHECKs in code so a violation
  // is a named error instead of an opaque 23514 arriving AFTER the object was
  // stored. The point of this test is the ORDER: a refusal that uploaded first
  // leaves a signed letter in the bucket with nothing pointing at it.
  const cases: Array<{ what: string; patch: Partial<TerminationFacts>; match: RegExp }> = [
    {
      what: 'no departure reason (G2: the allowlist, in code)',
      patch: { reasonKey: null, reasonLabel: null },
      match: /not a documentable departure reason/i,
    },
    {
      what: 'a raw hsl:* slug in the human-readable column (G6)',
      patch: { endingDepartmentLabel: 'hsl:intake_specialist' },
      match: /not formatted for display/i,
    },
    {
      what: 'termination on the start date (G4, restated as data by the DDL)',
      patch: { terminationDate: '2024-01-08' },
      match: /not after the start date/i,
    },
    {
      what: 'no worker name',
      patch: { workerName: '   ' },
      match: /missing worker name/i,
    },
    {
      what: 'a zero rate (G6: a zero rate is not a rate)',
      patch: {
        endingRate: { amount: 0, currency: 'PHP', source: 'disbursement_record', blankReason: null },
      },
      match: /greater than zero/i,
    },
  ];

  const { createTerminationDocument } = await logModule();
  for (const c of cases) {
    const fake = harness(writableTables());
    const res = await createTerminationDocument({
      facts: facts(c.patch),
      filled: [],
      bytes: pdfBytes(),
      generatedBy: REP,
      generatedByName: null,
      generatedByTitle: null,
      generatedAtIso: '2026-08-31T02:00:00.000Z',
      documentId: DOC_ID,
      writebacks: [],
    });
    assert.equal(res.row, null, `${c.what}: a row was written`);
    assert.match(res.error ?? '', c.match, c.what);
    assert.deepEqual(fake.storageOps, [], `${c.what}: an object was uploaded anyway`);
    assert.deepEqual(fake.ops, [], `${c.what}: the database was touched anyway`);
  }
});

test('bytes that are not a PDF are refused before the upload', async () => {
  const fake = harness(writableTables());
  const { createTerminationDocument } = await logModule();

  const res = await createTerminationDocument({
    facts: facts(),
    filled: [],
    bytes: new TextEncoder().encode('<!doctype html><p>not a letter</p>'),
    generatedBy: REP,
    generatedByName: null,
    generatedByTitle: null,
    generatedAtIso: '2026-08-31T02:00:00.000Z',
    documentId: DOC_ID,
    writebacks: [],
  });

  assert.equal(res.row, null);
  assert.match(res.error ?? '', /not a PDF/i);
  assert.deepEqual(fake.storageOps, []);
});

// ── The write-back's second audit copy ──────────────────────────────────────

test('G7: the write-back audit row carries the undo records with null and \'\' distinguishable', async () => {
  // `termination_documents.field_writebacks` is the primary undo data, but
  // `clearAuditLog()` truncates audit_log and a dropped table takes the other
  // copy with it. `before: null` (the cell did not exist) and `before: ''` (it
  // held an empty string) are DIFFERENT prior states; collapsing them is the
  // failure this record exists to prevent.
  const applied: TerminationWritebackRecord[] = [
    {
      table: 'global_master_list',
      rowId: MASTER_ROW,
      column: 'off_boarded_at',
      before: null,
      after: '2026-06-03',
      appliedAt: '2026-08-31T02:00:00.000Z',
    },
    {
      table: 'global_master_list',
      rowId: MASTER_ROW,
      column: 'Start Date',
      before: '',
      after: '2024-01-08',
      appliedAt: '2026-08-31T02:00:00.000Z',
    },
  ];
  const fake = harness(writableTables());
  const { auditTerminationWriteback } = await logModule();

  const res = await auditTerminationWriteback({
    documentId: DOC_ID,
    workEmail: LEAVER,
    masterRowId: MASTER_ROW,
    actorEmail: REP,
    applied,
    persistedTrail: [applied[0]],
    skipped: [],
    writebackError: null,
    trailError: null,
  });

  assert.equal(res.error, null);
  const audit = fake.opsFor('audit_log')[0];
  assert.ok(audit, 'the write-back was never audited');
  assert.equal(audit.payload?.action, 'documents.termination_writeback');
  assert.equal(audit.payload?.resource_id, DOC_ID);
  const details = audit.payload?.details as Record<string, unknown>;
  const records = details.field_writebacks as TerminationWritebackRecord[];
  assert.deepEqual(
    records.map((r) => r.before),
    [null, ''],
    "the audit copy collapsed null and '' into one value",
  );
  // The cell that was WRITTEN while its undo record failed to reach the document
  // row — the one state a rep must fix by hand — is named, not inferred.
  assert.deepEqual(
    (details.trail_not_persisted as TerminationWritebackRecord[]).map((r) => r.column),
    ['Start Date'],
  );
});

test('nothing written means no write-back audit row at all', async () => {
  const fake = harness(writableTables());
  const { auditTerminationWriteback } = await logModule();

  const res = await auditTerminationWriteback({
    documentId: DOC_ID,
    workEmail: LEAVER,
    masterRowId: MASTER_ROW,
    actorEmail: REP,
    applied: [],
    persistedTrail: [],
    skipped: [{ column: 'off_boarded_at', rowId: MASTER_ROW, reason: 'filled since selection' }],
    writebackError: null,
    trailError: null,
  });

  assert.equal(res.error, null);
  assert.deepEqual(fake.opsFor('audit_log'), [], 'an audit row claimed a write that never happened');
});

// ── The log read ────────────────────────────────────────────────────────────

test('the log read PAGES — the newest row past the 1000-row cap is still first', async () => {
  // This table gains a row per letter and PostgREST truncates at 1000 even with
  // an explicit `.range()`. A truncated log reads as "no letter was ever issued
  // for this person", which is the answer a rep acts on.
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 1001; i += 1) {
    rows.push(
      storedRow({
        id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
        // The NEWEST document is the last row, so it can only be found on page 2.
        generated_at: i === 1000 ? '2026-08-31T23:59:00.000Z' : '2026-01-01T00:00:00.000Z',
      }),
    );
  }
  const fake = harness({ termination_documents: rows });
  const { listTerminationDocuments } = await logModule();

  const res = await listTerminationDocuments({ limit: 10 });

  assert.equal(res.error, null);
  assert.deepEqual(
    fake.opsFor('termination_documents').map((op) => [op.from, op.to]),
    [
      [0, 999],
      [1000, 1999],
    ],
    'the log read stopped after one 1000-row page',
  );
  assert.equal(
    res.rows[0]?.id,
    '33333333-3333-4333-8333-000000001000',
    'the newest letter was past the cap and never arrived',
  );
  assert.equal(res.rows.length, 10);
  assert.equal(res.truncated, true, 'a capped page did not say so');
});

test('the log search escapes its pattern and names three columns, never .or()', async () => {
  const fake = harness({ termination_documents: ilikeTableFixture([storedRow()]) });
  const { listTerminationDocuments } = await logModule();

  await listTerminationDocuments({ query: 'a_b@simple.biz' });

  const patterns = fake
    .opsFor('termination_documents')
    .map((op) => (chainArgs(op, 'ilike') ?? []).join(' = '));
  assert.deepEqual(patterns.sort(), [
    'personal_email = %a\\_b@simple.biz%',
    'work_email = %a\\_b@simple.biz%',
    'worker_name = %a\\_b@simple.biz%',
  ]);
  assert.deepEqual(
    fake.allChainEntries().filter((c) => c.startsWith('or(')),
    [],
  );
});

test('a malformed keyset cursor is REFUSED, never silently dropped', async () => {
  // Ignoring it hands the caller page one again, so page two never arrives and
  // the log looks complete.
  const fake = harness({ termination_documents: [storedRow()] });
  const { listTerminationDocuments } = await logModule();

  const res = await listTerminationDocuments({ before: 'yesterday' });

  assert.equal(res.error, 'Invalid cursor');
  assert.deepEqual(res.rows, []);
  assert.deepEqual(fake.ops, [], 'a malformed cursor still ran a read');
});

test('a well-formed cursor becomes a keyset filter on generated_at', async () => {
  const fake = harness({ termination_documents: [storedRow()] });
  const { listTerminationDocuments } = await logModule();

  await listTerminationDocuments({ before: '2026-08-31T02:00:00.000Z' });

  assert.ok(
    fake.opsFor('termination_documents')[0].chain.includes('lt(generated_at,2026-08-31T02:00:00.000Z)'),
    fake.opsFor('termination_documents')[0].chain.join('.'),
  );
});

test('an unknown or malformed document id is NOT FOUND, with no read and no error', async () => {
  // The download route answers 404 rather than 403 so id-probing cannot tell an
  // existing letter from a missing one — the employee-documents precedent.
  const fake = harness({ termination_documents: [storedRow()] });
  const { getTerminationDocumentById } = await logModule();

  const malformed = await getTerminationDocumentById('not-a-uuid');
  assert.deepEqual(malformed, { row: null, error: null });
  assert.deepEqual(fake.ops, [], 'a malformed id still ran a read');

  // A well-formed id DOES read — the guard above is about shape, not existence.
  const existing = await getTerminationDocumentById('44444444-4444-4444-8444-444444444444');
  assert.equal(existing.error, null);
  assert.equal(existing.row?.id, DOC_ID);
  assert.equal(
    fake.opsFor('termination_documents')[0].chain.includes(
      'eq(id,44444444-4444-4444-8444-444444444444)',
    ),
    true,
  );
});
