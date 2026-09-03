/**
 * Pay Structure rail: a renamed in-app department's FORMER names ride the rail
 * entry as `aliases`, so a master cell written before the rename still lands
 * its person on the right entry (Edit Department, 2026-09-03).
 *
 * Run:  npx tsx --test src/lib/payment-catalog/dept-rail-aliases.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeptRail, deptCellMatchesEntry, railKeyForCell, assignRosterToRail, type DeptRailEntry } from './dept-rail';

const RAIL: DeptRailEntry[] = [
  { key: 'lead_gen', name: 'Lead Gen' },
  { key: 'executive_assistants', name: 'EA Team', aliases: ['Executive Assistants'] },
  { key: 'executive_assistants:ceo', name: 'EA Team — CEO' },
];

test('a cell carrying the former name matches the renamed entry', () => {
  const ea = RAIL[1]!;
  assert.ok(deptCellMatchesEntry('EA Team', ea));
  assert.ok(deptCellMatchesEntry('Executive Assistants', ea));
  assert.ok(deptCellMatchesEntry('executive assistants', ea));
  assert.ok(!deptCellMatchesEntry('Executive Assistants', RAIL[0]!));
});

test('railKeyForCell homes old-label and new-label people on the same entry', () => {
  const rail = buildDeptRail(RAIL);
  assert.equal(railKeyForCell('Executive Assistants', rail), 'executive_assistants');
  assert.equal(railKeyForCell('EA Team', rail), 'executive_assistants');
  const buckets = assignRosterToRail(
    [
      { email: 'a@simple.biz', department: 'Executive Assistants' },
      { email: 'b@simple.biz', department: 'EA Team' },
    ],
    rail,
  );
  assert.equal(buckets.get('executive_assistants')?.length, 2);
});

test('entries without aliases behave exactly as before', () => {
  assert.ok(deptCellMatchesEntry('Lead Gen', { key: 'lead_gen', name: 'Lead Gen' }));
  assert.ok(!deptCellMatchesEntry('EA Team', { key: 'lead_gen', name: 'Lead Gen' }));
});
