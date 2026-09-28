import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADDITIONS_AUDIT_MAX_CHANGES,
  ADDITIONS_AUDIT_MAX_PEOPLE,
  describeAdditionsSave,
} from './wizard-additions-audit';

const blob = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    bonusOverrides: {},
    bonusOverrideNotes: {},
    orphanageAmounts: {},
    employeeMetrics: {},
    deptMetrics: {},
    employeeDepts: {},
    employeeDeptsManual: {},
    employeeBonuses: {},
    techBonusManualGrants: [],
    techBonusManualRevokes: [],
    pabStatusSnapshot: {},
    ...over,
  });

test('an identical re-save is not an event', () => {
  const v = blob({ bonusOverrides: { 'a@simple.biz': { adjustment: 500 } } });
  assert.equal(describeAdditionsSave(v, v), null);
  // byte-different but semantically identical (key order) is also not an event
  const parsed = JSON.parse(v) as Record<string, unknown>;
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
  assert.notEqual(reordered, v);
  assert.equal(describeAdditionsSave(v, reordered), null);
});

test('a KPI metric typed in a modal (never client-logged) is recorded', () => {
  const before = blob({ deptMetrics: { lead_gen: { appointmentsSet: 10 } } });
  const after = blob({ deptMetrics: { lead_gen: { appointmentsSet: 14 } } });
  const d = describeAdditionsSave(before, after);
  assert.ok(d);
  assert.deepEqual(d.changes, [{ path: 'deptMetrics/lead_gen/appointmentsSet', op: 'changed', before: 10, after: 14 }]);
  assert.equal(d.changes_total, 1);
});

test('Adj. note text, a removed orphanage amount and a bonus toggle all land, and name the people', () => {
  const before = blob({
    orphanageAmounts: { 'b@simple.biz': 1200 },
    employeeBonuses: { 'c@simple.biz': { perfect_attendance: true } },
  });
  const after = blob({
    bonusOverrideNotes: { 'a@simple.biz': 'refund for 09-22' },
    employeeBonuses: { 'c@simple.biz': { perfect_attendance: false } },
  });
  const d = describeAdditionsSave(before, after);
  assert.ok(d);
  assert.deepEqual(d.changes, [
    { path: 'bonusOverrideNotes/a@simple.biz', op: 'added', after: 'refund for 09-22' },
    { path: 'employeeBonuses/c@simple.biz/perfect_attendance', op: 'changed', before: true, after: false },
    { path: 'orphanageAmounts/b@simple.biz', op: 'removed', before: 1200 },
  ]);
  assert.deepEqual(d.people, ['a@simple.biz', 'b@simple.biz', 'c@simple.biz']);
  assert.equal(d.people_total, 3);
});

test('Tech revoke/restore chips are recorded as set membership, with the person', () => {
  const before = blob({ techBonusManualRevokes: ['x@simple.biz'] });
  const after = blob({ techBonusManualRevokes: ['y@simple.biz'] });
  const d = describeAdditionsSave(before, after);
  assert.ok(d);
  assert.deepEqual(d.changes, [
    { path: 'techBonusManualRevokes', op: 'members', added: ['y@simple.biz'], removed: ['x@simple.biz'] },
  ]);
  assert.deepEqual(d.people, ['x@simple.biz', 'y@simple.biz']);
});

test('the derived PAB snapshot is counted, not itemised, so it cannot bury real edits', () => {
  const snap = (n: number, v: string) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}@simple.biz`, v]));
  const before = blob({ pabStatusSnapshot: snap(500, 'eligible') });
  const after = blob({ pabStatusSnapshot: snap(500, 'ineligible'), bonusOverrides: { 'a@simple.biz': { adjustment: 1 } } });
  const d = describeAdditionsSave(before, after);
  assert.ok(d);
  assert.deepEqual(d.changes, [
    { path: 'bonusOverrides/a@simple.biz/adjustment', op: 'added', after: 1 },
    { path: 'pabStatusSnapshot', op: 'summarised', changed_entries: 500 },
  ]);
  assert.deepEqual(d.people, ['a@simple.biz']);
});

test('a first save is recorded as created even when it carries no amounts', () => {
  const d = describeAdditionsSave(null, blob());
  assert.ok(d);
  assert.equal(d.created, true);
  assert.equal(d.changes_total, 0);
});

test('a first save itemises every amount it brings, per person', () => {
  const d = describeAdditionsSave(null, blob({ orphanageAmounts: { 'a@simple.biz': 800, 'b@simple.biz': 950 } }));
  assert.ok(d);
  assert.deepEqual(d.changes, [
    { path: 'orphanageAmounts/a@simple.biz', op: 'added', after: 800 },
    { path: 'orphanageAmounts/b@simple.biz', op: 'added', after: 950 },
  ]);
  assert.deepEqual(d.people, ['a@simple.biz', 'b@simple.biz']);
});

test('a failed pre-read is still an event, flagged, never a silent skip', () => {
  const d = describeAdditionsSave(null, blob(), { beforeUnavailable: true });
  assert.ok(d);
  assert.equal(d.before_unavailable, true);
  assert.equal(d.created, false);
});

test('an unparseable side reports sizes instead of pretending there was no change', () => {
  const d = describeAdditionsSave('{not json', blob());
  assert.ok(d);
  assert.equal(d.unparseable, true);
  assert.equal(d.before_length, '{not json'.length);
});

test('the change list and the people list are capped; the totals are not', () => {
  const many = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`p${i}@simple.biz`, { adjustment: i + 1 }]),
  );
  const d = describeAdditionsSave(blob(), blob({ bonusOverrides: many }));
  assert.ok(d);
  assert.equal(d.changes.length, ADDITIONS_AUDIT_MAX_CHANGES);
  assert.equal(d.changes_total, 300);
  assert.equal(d.truncated, true);
  assert.equal(d.people.length, ADDITIONS_AUDIT_MAX_PEOPLE);
  assert.equal(d.people_total, 300);
});
