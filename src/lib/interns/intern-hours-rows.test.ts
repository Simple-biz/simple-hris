import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { partitionInternRows } from './intern-hours-rows';

const simple = { email: 'kaner@simple.biz', name: 'Kane' };
const intern = { email: 'maria@pathway.ph', name: 'Maria' };
const blank = { email: null, name: 'No email' };

test('one of each domain in → exactly one out per rail', () => {
  const { payroll, interns } = partitionInternRows([simple, intern]);
  assert.deepEqual(payroll, [simple]);
  assert.deepEqual(interns, [intern]);
});

test('a row with no email stays on the payroll rail (existing behaviour, never an intern)', () => {
  const { payroll, interns } = partitionInternRows([blank]);
  assert.deepEqual(payroll, [blank]);
  assert.deepEqual(interns, []);
});

test('order within each rail is preserved and nothing is duplicated or lost', () => {
  const rows = [intern, simple, { ...intern, email: 'JUAN@PATHWAY.PH' }, blank];
  const { payroll, interns } = partitionInternRows(rows);
  assert.equal(payroll.length + interns.length, rows.length);
  assert.deepEqual(interns.map((r) => r.email), ['maria@pathway.ph', 'JUAN@PATHWAY.PH']);
  assert.deepEqual(payroll.map((r) => r.email), ['kaner@simple.biz', null]);
});
