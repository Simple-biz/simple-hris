import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cycleFxSettingKey,
  deriveWizardSetupSteps,
  orphanageConfirmedSettingKey,
  parseCycleFxRecord,
  parseDispatchLockValue,
  parseOrphanageNoneMarker,
  type WizardSetupInput,
} from './wizard-setup-steps';

/** A fully-set-up week — every row must read done. */
const ALL_DONE: WizardSetupInput = {
  expectedWeekStart: '2026-07-26',
  weekLabel: 'Jul 26 – Aug 1',
  awaitingWeekStart: null,
  awaitingWeekLabel: null,
  csvUpload: { sourceFile: 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv', uploadedAt: '2026-08-02T05:10:00Z', rowCount: 412 },
  newestUploadUnparseable: false,
  fx: { php: 58.9, cop: 4050, by: 'lenny@simple.biz', at: '2026-08-02T06:00:00Z' },
  orphanageRowCount: 4,
  orphanageNoneMarker: false,
  kpi: { due: 9, submitted: 9, pendingDepts: [] },
  notes: { total: 3, applied: 3 },
  contractorsPending: 0,
  dispatchLock: { locked: true, lockedBy: 'lenny@simple.biz', lockedAt: '2026-08-03T09:00:00Z' },
  degradedKeys: new Set(),
};

function step(setup: ReturnType<typeof deriveWizardSetupSteps>, key: string) {
  const s = setup.steps.find((s) => s.key === key);
  assert.ok(s, `step ${key} missing`);
  return s;
}

test('all set up → 7/7 done, nothing newer awaiting an upload', () => {
  const setup = deriveWizardSetupSteps(ALL_DONE);
  assert.equal(setup.totalCount, 7);
  assert.equal(setup.doneCount, 7);
  assert.equal(setup.awaitingWeekStart, null);
  assert.equal(setup.awaitingWeekLabel, null);
  assert.equal(setup.matchedSourceFile, ALL_DONE.csvUpload!.sourceFile);
  for (const s of setup.steps) assert.equal(s.status, 'done', `${s.key} should be done`);
});

test('missing CSV → blocked', () => {
  const setup = deriveWizardSetupSteps({ ...ALL_DONE, csvUpload: null });
  const csv = step(setup, 'csv');
  assert.equal(csv.status, 'blocked');
  assert.match(csv.detail, /Not uploaded/);
  assert.equal(setup.matchedSourceFile, null);
});

// The checklist never re-points itself at the newer week — it stays on the week
// in view (the selector's) and carries the newer one as a separate nudge.
test('a closed newer week with no CSV rides along as awaiting, not as the week in view', () => {
  const setup = deriveWizardSetupSteps({
    ...ALL_DONE,
    awaitingWeekStart: '2026-08-02',
    awaitingWeekLabel: 'Aug 2 – Aug 8',
  });
  assert.equal(setup.expectedWeekStart, '2026-07-26');
  assert.equal(setup.weekLabel, 'Jul 26 – Aug 1');
  assert.equal(setup.awaitingWeekLabel, 'Aug 2 – Aug 8');
  // The rows still describe the week in view — all still done.
  assert.equal(setup.doneCount, 7);
});

test('missing CSV with unparseable newest upload → attention, not blocked', () => {
  const setup = deriveWizardSetupSteps({ ...ALL_DONE, csvUpload: null, newestUploadUnparseable: true });
  assert.equal(step(setup, 'csv').status, 'attention');
});

test('fx: absent record or both zero → "Rates at 0"; single zero names the missing leg; both set → done', () => {
  const absent = step(deriveWizardSetupSteps({ ...ALL_DONE, fx: null }), 'fx');
  assert.equal(absent.status, 'attention');
  assert.match(absent.detail, /Rates at 0/);
  const bothZero = step(
    deriveWizardSetupSteps({ ...ALL_DONE, fx: { php: 0, cop: 0, by: null, at: null } }),
    'fx',
  );
  assert.equal(bothZero.status, 'attention');
  assert.match(bothZero.detail, /Rates at 0/);
  const phpZero = step(
    deriveWizardSetupSteps({ ...ALL_DONE, fx: { php: 0, cop: 4050, by: null, at: null } }),
    'fx',
  );
  assert.equal(phpZero.status, 'attention');
  assert.match(phpZero.detail, /PHP still 0/);
  const copZero = step(
    deriveWizardSetupSteps({ ...ALL_DONE, fx: { php: 58.9, cop: 0, by: null, at: null } }),
    'fx',
  );
  assert.equal(copZero.status, 'attention');
  assert.match(copZero.detail, /COP still 0/);
  const done = step(deriveWizardSetupSteps(ALL_DONE), 'fx');
  assert.equal(done.status, 'done');
  assert.match(done.detail, /58\.9/);
  assert.match(done.detail, /4,050/);
});

test('fx: no matched CSV → waiting for the CSV (not a zero complaint)', () => {
  const s = step(deriveWizardSetupSteps({ ...ALL_DONE, csvUpload: null, fx: null }), 'fx');
  assert.equal(s.status, 'attention');
  assert.match(s.detail, /CSV/);
});

test('cycleFxSettingKey + parseCycleFxRecord', () => {
  assert.equal(cycleFxSettingKey('a.csv'), 'payroll.wizard.fx.a.csv');
  assert.deepEqual(
    parseCycleFxRecord('{"php":58.9,"cop":4050,"by":"a@b.c","at":"2026-08-09T02:11:00Z"}'),
    { php: 58.9, cop: 4050, by: 'a@b.c', at: '2026-08-09T02:11:00Z' },
  );
  // partial / sloppy records normalize: missing or invalid legs read 0, extra fields drop
  assert.deepEqual(parseCycleFxRecord('{"php":58.9}'), { php: 58.9, cop: 0, by: null, at: null });
  assert.deepEqual(parseCycleFxRecord('{"php":-1,"cop":"x"}'), { php: 0, cop: 0, by: null, at: null });
  assert.equal(parseCycleFxRecord('not json'), null);
  assert.equal(parseCycleFxRecord(null), null);
});

test('orphanage: rows outrank the none-marker; none-marker alone is done; neither is attention', () => {
  const rows = step(deriveWizardSetupSteps({ ...ALL_DONE, orphanageNoneMarker: true }), 'orphanage');
  assert.equal(rows.status, 'done');
  assert.match(rows.detail, /4/);
  const marker = step(deriveWizardSetupSteps({ ...ALL_DONE, orphanageRowCount: 0, orphanageNoneMarker: true }), 'orphanage');
  assert.equal(marker.status, 'done');
  assert.match(marker.detail, /none/i);
  const neither = step(deriveWizardSetupSteps({ ...ALL_DONE, orphanageRowCount: 0 }), 'orphanage');
  assert.equal(neither.status, 'attention');
});

test('kpi: partial → attention listing pending depts (capped at 3), none due → pending', () => {
  const partial = step(
    deriveWizardSetupSteps({
      ...ALL_DONE,
      kpi: { due: 9, submitted: 7, pendingDepts: ['SSD', 'NPD', 'CS', 'Sales'] },
    }),
    'kpi',
  );
  assert.equal(partial.status, 'attention');
  assert.match(partial.detail, /7\/9/);
  assert.match(partial.detail, /SSD, NPD, CS \+1 more/);
  const none = step(deriveWizardSetupSteps({ ...ALL_DONE, kpi: { due: 0, submitted: 0, pendingDepts: [] } }), 'kpi');
  assert.equal(none.status, 'pending');
});

test('notes: zero rows → done "None"; partial applied → attention with counts', () => {
  const noneRow = step(deriveWizardSetupSteps({ ...ALL_DONE, notes: { total: 0, applied: 0 } }), 'notes');
  assert.equal(noneRow.status, 'done');
  const partial = step(deriveWizardSetupSteps({ ...ALL_DONE, notes: { total: 3, applied: 1 } }), 'notes');
  assert.equal(partial.status, 'attention');
  assert.match(partial.detail, /2 of 3/);
});

test('contractors pending → attention; dispatch unlocked → pending (neutral end-state)', () => {
  const c = step(deriveWizardSetupSteps({ ...ALL_DONE, contractorsPending: 2 }), 'contractors');
  assert.equal(c.status, 'attention');
  assert.match(c.detail, /2/);
  const d = step(
    deriveWizardSetupSteps({ ...ALL_DONE, dispatchLock: { locked: false, lockedBy: null, lockedAt: null } }),
    'dispatch',
  );
  assert.equal(d.status, 'pending');
});

test('a degraded read → pending "couldn\'t read", never done or blocked', () => {
  const setup = deriveWizardSetupSteps({ ...ALL_DONE, fx: null, degradedKeys: new Set(['fx']) });
  const fx = step(setup, 'fx');
  assert.equal(fx.status, 'pending');
  assert.match(fx.detail, /read/i);
});

test('setting keys + marker/lock parsers', () => {
  assert.equal(orphanageConfirmedSettingKey('2026-07-26'), 'payroll.wizard.orphanage_confirmed.2026-07-26');
  assert.deepEqual(parseOrphanageNoneMarker('{"none":true,"by":"a@b.c","at":"x"}'), { by: 'a@b.c', at: 'x' });
  assert.equal(parseOrphanageNoneMarker('{"none":false}'), null);
  assert.deepEqual(parseDispatchLockValue('{"locked":true,"lockedAt":"t","lockedBy":"a@b.c"}'), {
    locked: true,
    lockedAt: 't',
    lockedBy: 'a@b.c',
  });
  assert.deepEqual(parseDispatchLockValue('true'), { locked: true, lockedAt: null, lockedBy: null });
  assert.deepEqual(parseDispatchLockValue(null), { locked: false, lockedAt: null, lockedBy: null });
});
