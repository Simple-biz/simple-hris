/** [TERMINATION-DOCS]
 * The panel's two judgements about a server response, and the source pins that
 * keep the panel using them.
 *
 * Both rules were client-side copies of a server decision once, and both went
 * wrong in the same way: the copy was weaker than the original and no test could
 * see the disagreement, because `npm test` is
 * `node --import tsx --test "src/**\/*.test.ts"` and nothing in a `.tsx` file
 * ever runs. So the rules live in `termination-panel-rules.ts`, the behaviour is
 * asserted here, and the panel is read off disk to prove it still calls them.
 *
 * Nothing here touches a database or a browser. `.env.local` holds PRODUCTION
 * service-role credentials.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  MANUAL_REPAIR_STORAGE_KEY,
  WRITEBACK_TRAIL_LOST_MARKER,
  buildManualRepairs,
  dropManualRepair,
  isWritebackTrailLost,
  manualRepairKey,
  mergeManualRepairs,
  readManualRepairs,
  serializeManualRepairs,
  viewTerminationCandidate,
  writtenValueForColumn,
  type TerminationManualRepair,
} from './termination-panel-rules';
import type {
  TerminationBlockedReason,
  TerminationDocumentRow,
  TerminationSearchCandidate,
} from './types';

const DIR = path.join(process.cwd(), 'src', 'lib', 'documents', 'termination');
const RULES_SRC = fs.readFileSync(path.join(DIR, 'termination-writeback-rules.ts'), 'utf8');
const PANEL_SRC = fs.readFileSync(
  path.join(
    process.cwd(),
    'src',
    'components',
    'accounting',
    'termination-docs',
    'TerminationDocsPanel.tsx',
  ),
  'utf8',
);

/** Source with comments removed. Every source assertion below is about CODE —
 *  the panel's own comments discuss `c.active` and the toast this replaced, and
 *  prose must neither satisfy nor trip a guard. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const PANEL_CODE = codeOnly(PANEL_SRC);

// ─── B8 · the server decides who is selectable ───────────────────────────────

function candidate(over: Partial<TerminationSearchCandidate> = {}): TerminationSearchCandidate {
  return {
    workEmail: 'jane@simple.biz',
    personalEmail: 'jane@gmail.com',
    name: 'Reyes, Jane',
    departmentLabel: 'Lead Gen',
    offDate: '2026-06-03',
    rawReason: 'resigned',
    reasonLabel: 'Resigned',
    matchedColumn: 'Work Email',
    active: false,
    blockedCode: null,
    ...over,
  };
}

test('B8: the 294 shape — ACTIVE flag, stamped departure, no server code — is SELECTABLE', () => {
  // The commonest leaver there is: HR keeps the person on the master sheet
  // through final pay, so a live unstamped row makes `fetchGmlStatusMap` call
  // them active, while the off-board stamp sits on a duplicate row. Measured
  // 2026-08-21 (offboard-evidence.ts:8-11): 1,287 active rows, ZERO carrying
  // off_boarded_at, while 294 of those people ARE offboarded.
  // `buildTerminationCandidates` deliberately leaves `blockedCode` null for this
  // shape; the panel used to refuse it anyway.
  const view = viewTerminationCandidate(candidate({ active: true, blockedCode: null }));
  assert.equal(view.selectable, true, 'the client contradicted the server again');
  assert.equal(view.refusalCode, null);
  assert.equal(view.showActiveChip, true, 'the roster flag is still reported — as a chip');
});

test('B8: a server `still_active` code greys the row and states that reason', () => {
  const view = viewTerminationCandidate(candidate({ active: true, blockedCode: 'still_active' }));
  assert.equal(view.selectable, false);
  assert.equal(view.refusalCode, 'still_active');
});

test('B8: a server refusal wins even when the roster flag says the person has gone', () => {
  for (const code of ['temporary_pause', 'not_a_departure', 'evidence_read_failed'] as const) {
    const view = viewTerminationCandidate(candidate({ active: false, blockedCode: code }));
    assert.equal(view.selectable, false, `${code} rendered as selectable`);
    assert.equal(view.refusalCode, code);
  }
});

test('B8: `active` never changes the verdict — only the chip', () => {
  const codes: (TerminationBlockedReason['code'] | null)[] = [
    null,
    'no_master',
    'ambiguous_identity',
    'still_active',
    'no_departure_evidence',
    'temporary_pause',
    'not_a_departure',
    'rehire_after_offboard',
    'bad_name',
    'evidence_read_failed',
  ];
  for (const blockedCode of codes) {
    const off = viewTerminationCandidate(candidate({ blockedCode, active: false }));
    const on = viewTerminationCandidate(candidate({ blockedCode, active: true }));
    assert.equal(off.selectable, blockedCode === null, `blockedCode ${blockedCode}`);
    assert.equal(
      on.selectable,
      off.selectable,
      `the active flag changed the verdict for blockedCode ${blockedCode}`,
    );
    assert.equal(on.refusalCode, off.refusalCode);
    assert.equal(on.showActiveChip, true);
    assert.equal(off.showActiveChip, false);
  }
});

test('B8: a candidate with no work email is never a reasonless dead end', () => {
  // The server stamps `no_master` on a bucket with no work email
  // (termination-arbitration.ts:396). If a response ever contradicts that, the
  // row still says WHY it cannot be used — and it can never turn an identified,
  // unblocked candidate into a refusal.
  const stamped = viewTerminationCandidate(candidate({ workEmail: null, blockedCode: 'no_master' }));
  assert.equal(stamped.selectable, false);
  assert.equal(stamped.refusalCode, 'no_master');

  const contradiction = viewTerminationCandidate(candidate({ workEmail: null, blockedCode: null }));
  assert.equal(contradiction.selectable, false);
  assert.equal(contradiction.refusalCode, 'no_master');
});

test('B8: the panel holds no second copy of the refusal', () => {
  assert.ok(
    PANEL_CODE.includes('viewTerminationCandidate(c)'),
    'the candidate list stopped asking the shared rule',
  );
  assert.equal(
    /REFUSAL_COPY\.still_active/.test(PANEL_CODE),
    false,
    'the panel names a refusal by hand again — the copy that greyed out 294 real leavers',
  );
  assert.equal(
    /:\s*c\.active\s*\n?\s*\?/.test(PANEL_CODE),
    false,
    'the panel branches on `c.active` to decide a refusal again',
  );
  // The refusal that renders is whatever code the server sent, looked up — never
  // a hand-picked member of the table.
  assert.ok(PANEL_CODE.includes('REFUSAL_COPY[view.refusalCode]'));
  assert.ok(PANEL_CODE.includes('const usable = view.selectable'));
});

// ─── B9 · the cell only a human can put back ─────────────────────────────────

/** The sentence `applyTerminationWriteBack` actually builds, for a real error. */
const REAL_TRAIL_LOST_REASON =
  'WRITTEN but the undo record could not be saved (the document row could not be found to attach the undo trail) — revert this cell by hand';

test('B9: the marker is the sentence the write-back really builds', () => {
  // The classification is a substring of prose written in another module. This
  // pin is what stops the banner going silent when that prose is reworded.
  assert.match(
    RULES_SRC,
    /reason: `WRITTEN but the undo record could not be saved \(\$\{persistErr\}\) — revert this cell by hand`/,
    'termination-writeback-rules.ts no longer builds the sentence the panel classifies on',
  );
  assert.ok(RULES_SRC.includes(WRITEBACK_TRAIL_LOST_MARKER));
  assert.equal(isWritebackTrailLost({ reason: REAL_TRAIL_LOST_REASON }), true);
});

test('B9: only the written-but-unrecorded skip is a hand repair', () => {
  const reversible = [
    'the cell already holds “resigned” — left as it is',
    'not attempted: the undo trail could not be saved for off_boarded_at, so nothing further was written',
    'no master row won the arbitration — there is nothing to write back safely',
    'guarded update failed: canceling statement due to statement timeout',
    'WRITTEN and undo-recorded on the document row, but the audit entry failed (boom) — the cell is reversible, the audit copy is not there',
  ];
  for (const reason of reversible) {
    assert.equal(isWritebackTrailLost({ reason }), false, reason);
  }
  assert.equal(isWritebackTrailLost(null), false);
  assert.equal(isWritebackTrailLost({}), false);
  assert.equal(isWritebackTrailLost({ reason: 42 }), false);
});

function row(over: Partial<TerminationDocumentRow> = {}): TerminationDocumentRow {
  return {
    id: 'doc-1',
    work_email: 'jane@simple.biz',
    personal_email: 'jane@gmail.com',
    master_row_id: 'gml-1',
    worker_name: 'Jane Reyes',
    termination_date: '2026-06-03',
    reason_key: 'resigned',
    reason_label: 'Resigned',
    ending_department_raw: 'Lead Gen',
    ending_department_label: 'Lead Gen',
    start_date: '2024-02-01',
    starting_rate: null,
    starting_rate_currency: null,
    starting_rate_source: null,
    ending_rate: null,
    ending_rate_currency: null,
    ending_rate_source: null,
    facts: {} as TerminationDocumentRow['facts'],
    filled_by_rep: [],
    field_writebacks: [],
    generated_by: 'rep@simple.biz',
    generated_by_name: 'A Rep',
    generated_by_title: null,
    generated_at: '2026-08-31T02:00:00.000Z',
    file_path: 'termination/doc-1.pdf',
    file_name: 'doc-1.pdf',
    file_size: 1024,
    created_at: '2026-08-31T02:00:00.000Z',
    ...over,
  };
}

test('B9: each write-back column reports the value the letter printed', () => {
  const r = row();
  assert.equal(writtenValueForColumn(r, 'off_boarded_at'), '2026-06-03');
  assert.equal(writtenValueForColumn(r, 'off_boarded_reason'), 'resigned');
  assert.equal(writtenValueForColumn(r, 'Start Date'), '2024-02-01');
  // A row that does not carry the value says so rather than inventing one.
  assert.equal(writtenValueForColumn(row({ start_date: null }), 'Start Date'), null);
});

test('B9: a trail-lost skip becomes an actionable repair — row, column, value', () => {
  const repairs = buildManualRepairs({
    row: row(),
    skipped: [
      { column: 'off_boarded_at', rowId: 'gml-1', reason: REAL_TRAIL_LOST_REASON },
      { column: 'off_boarded_reason', rowId: 'gml-1', reason: 'the cell already holds “ncns”' },
    ],
    detectedAt: '2026-08-31T02:00:01.000Z',
  });
  assert.equal(repairs.length, 1, 'a reversible skip was promoted to a hand repair');
  assert.deepEqual(repairs[0], {
    documentId: 'doc-1',
    workerName: 'Jane Reyes',
    workEmail: 'jane@simple.biz',
    masterRowId: 'gml-1',
    column: 'off_boarded_at',
    wroteValue: '2026-06-03',
    reason: REAL_TRAIL_LOST_REASON,
    detectedAt: '2026-08-31T02:00:01.000Z',
  });
});

test('B9: a repeat report never resets when the cell was changed', () => {
  const first: TerminationManualRepair = {
    documentId: 'doc-1',
    workerName: 'Jane Reyes',
    workEmail: 'jane@simple.biz',
    masterRowId: 'gml-1',
    column: 'off_boarded_at',
    wroteValue: '2026-06-03',
    reason: REAL_TRAIL_LOST_REASON,
    detectedAt: '2026-08-31T02:00:01.000Z',
  };
  const again = { ...first, detectedAt: '2026-09-02T09:00:00.000Z' };
  const other = { ...first, column: 'Start Date' as const, wroteValue: '2024-02-01' };

  const merged = mergeManualRepairs([first], [again, other]);
  assert.equal(merged.length, 2, 'the same cell was listed twice');
  const kept = merged.find((r) => r.column === 'off_boarded_at');
  assert.equal(kept?.detectedAt, '2026-08-31T02:00:01.000Z', 'an old unrepaired cell looked new');
  // Newest first.
  assert.equal(merged[0].detectedAt >= merged[1].detectedAt, true);

  const dropped = dropManualRepair(merged, manualRepairKey(first));
  assert.deepEqual(
    dropped.map((r) => r.column),
    ['Start Date'],
    'marking one cell restored cleared another',
  );
});

test('B9: the stored banner survives a reload and refuses to render a guess', () => {
  const repairs = buildManualRepairs({
    row: row(),
    skipped: [{ column: 'Start Date', rowId: 'gml-1', reason: REAL_TRAIL_LOST_REASON }],
    detectedAt: '2026-08-31T02:00:01.000Z',
  });
  assert.deepEqual(readManualRepairs(serializeManualRepairs(repairs)), repairs);

  // Nothing stored, unreadable storage, and the wrong shape all render an empty
  // banner instead of throwing: the panel has to paint.
  assert.deepEqual(readManualRepairs(null), []);
  assert.deepEqual(readManualRepairs(''), []);
  assert.deepEqual(readManualRepairs('{not json'), []);
  assert.deepEqual(readManualRepairs('{"documentId":"doc-1"}'), []);
  assert.deepEqual(readManualRepairs('[null, 3, "x", []]'), []);

  // An entry naming a column outside the write-back allowlist is DROPPED, not
  // repaired into something plausible — this banner states a fact about one
  // master-list cell, and a guessed cell is worse than none.
  assert.deepEqual(
    readManualRepairs(
      JSON.stringify([
        { documentId: 'doc-1', column: 'Department', masterRowId: 'gml-1' },
        { documentId: '', column: 'off_boarded_at', masterRowId: 'gml-1' },
        { documentId: 'doc-2', column: 'off_boarded_reason', masterRowId: 'gml-9' },
      ]),
    ).map((r) => `${r.documentId}:${r.column}`),
    ['doc-2:off_boarded_reason'],
  );
});

test('B9: the panel keeps the hand-repair off the toast layer and out of the way of focus', () => {
  // 1. It is not a toast. The toast loop runs over the OTHER skips.
  assert.ok(
    PANEL_CODE.includes('const trailLost = allSkips.filter(isWritebackTrailLost)'),
    'the panel stopped separating the hand-repair state',
  );
  assert.ok(PANEL_CODE.includes('for (const s of otherSkips)'), 'the toast loop is not narrowed');
  assert.equal(
    /toast\.(warning|error|success)\([^)]*trailLost/.test(PANEL_CODE),
    false,
    'the hand-repair is being toasted again',
  );

  // 2. The letter is not opened until the rep has acknowledged it.
  assert.match(
    PANEL_CODE,
    /if \(trailLost\.length > 0\) \{[\s\S]{0,900}\} else if \(json\.url\) \{\s*window\.open/,
    'window.open runs before the hand-repair has been acknowledged',
  );

  // 3. It is persistent: stored per browser, rendered as a banner, and marked on
  //    the log row it belongs to.
  assert.ok(PANEL_CODE.includes('MANUAL_REPAIR_STORAGE_KEY'));
  assert.ok(PANEL_CODE.includes('readManualRepairs('));
  assert.ok(PANEL_CODE.includes('serializeManualRepairs('));
  assert.ok(PANEL_CODE.includes('manualRepairs.length > 0'), 'no persistent banner is rendered');
  assert.ok(PANEL_CODE.includes('repairsByDocument.get(r.id)'), 'the log row carries no marker');
  // 4. The only way out is the rep saying the cell is blank again — never a
  //    bulk clear and never a timer.
  assert.ok(PANEL_CODE.includes('dropManualRepair(prev, key)'));
  assert.equal(
    /setManualRepairs\(\[\]\)/.test(PANEL_CODE),
    false,
    'something clears every hand repair at once',
  );
  assert.equal(
    /setTimeout\([^)]*setManualRepairs/.test(PANEL_CODE),
    false,
    'a hand repair expires on a timer',
  );
});

test('B9: the storage key is versioned, so a shape change cannot be read as the old shape', () => {
  assert.match(MANUAL_REPAIR_STORAGE_KEY, /\.v\d+$/);
});
