import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePayStructureWriteTargetId, type PayStructureSlot } from './pay-structure';

/**
 * Regression tests for the "Set rate" duplicate-key bug (2026-08-04).
 *
 * The DB enforces ONE employee-scoped structure per (department_key,
 * lower(employee_email)) and ONE department-scoped structure per
 * department_key. `id` is only a surrogate. The Payroll Wizard's inline "Set
 * rate" editor (Readiness → No Pay Rate, and the Offboarded tab) mints a FRESH
 * id every time it opens, because it never loads the structures list — so a
 * save for someone who already has a structure used to become a plain INSERT
 * and blow up with:
 *
 *   duplicate key value violates unique constraint
 *   "payment_catalog_pay_structures_emp_uniq"
 *
 * These tests pin the rule that makes the write land on the row that already
 * occupies the natural-key slot, whatever id the caller invented.
 */

const slot = (o: Partial<PayStructureSlot> & { id: string }): PayStructureSlot => ({
  scope: 'employee',
  departmentKey: 'hogan_smith_law',
  employeeEmail: 'zigfredoa@simple.biz',
  ...o,
});

test('a fresh id for a person who ALREADY has a structure resolves to the existing row', () => {
  // The exact live case: Ziggy had pay_mrz6ao7lsnkm111u under hogan_smith_law.
  const existing = [slot({ id: 'pay_mrz6ao7lsnkm111u' })];
  const id = resolvePayStructureWriteTargetId(slot({ id: 'pay_brandnew0000' }), existing);
  assert.equal(id, 'pay_mrz6ao7lsnkm111u');
});

test('a fresh id for a person with NO structure keeps the new id (a real insert)', () => {
  const id = resolvePayStructureWriteTargetId(slot({ id: 'pay_brandnew0000' }), []);
  assert.equal(id, 'pay_brandnew0000');
});

test('email match is case- and whitespace-insensitive', () => {
  const existing = [slot({ id: 'pay_existing', employeeEmail: '  ZigfredoA@Simple.BIZ ' })];
  const id = resolvePayStructureWriteTargetId(
    slot({ id: 'pay_new', employeeEmail: 'zigfredoa@simple.biz' }),
    existing,
  );
  assert.equal(id, 'pay_existing');
});

test('the same person in a DIFFERENT department is a different slot — new id kept', () => {
  const existing = [slot({ id: 'pay_hsl' })];
  const id = resolvePayStructureWriteTargetId(
    slot({ id: 'pay_new', departmentKey: 'callbacks' }),
    existing,
  );
  assert.equal(id, 'pay_new');
});

test('a DIFFERENT person in the same department is a different slot — new id kept', () => {
  const existing = [slot({ id: 'pay_ziggy' })];
  const id = resolvePayStructureWriteTargetId(
    slot({ id: 'pay_new', employeeEmail: 'someoneelse@simple.biz' }),
    existing,
  );
  assert.equal(id, 'pay_new');
});

test('editing an existing structure by its OWN id is unchanged (the Payment Catalog path)', () => {
  const existing = [slot({ id: 'pay_existing' })];
  const id = resolvePayStructureWriteTargetId(slot({ id: 'pay_existing' }), existing);
  assert.equal(id, 'pay_existing');
});

test('a department-scoped save resolves to the department s existing row', () => {
  const existing = [
    { id: 'pay_dept_hsl', scope: 'department' as const, departmentKey: 'hogan_smith_law' },
    // An employee row in the same dept must NOT be mistaken for the dept slot.
    slot({ id: 'pay_emp_ziggy' }),
  ];
  const id = resolvePayStructureWriteTargetId(
    { id: 'pay_new', scope: 'department', departmentKey: 'hogan_smith_law' },
    existing,
  );
  assert.equal(id, 'pay_dept_hsl');
});

test('an employee save is never captured by the department row in the same dept', () => {
  const existing = [
    { id: 'pay_dept_hsl', scope: 'department' as const, departmentKey: 'hogan_smith_law' },
  ];
  const id = resolvePayStructureWriteTargetId(slot({ id: 'pay_new' }), existing);
  assert.equal(id, 'pay_new');
});

test('an employee save with no email keeps its id (the DB slot needs an email)', () => {
  // scope=employee with a null email is outside the partial unique index, so
  // there is no slot to collide with — validatePayStructure rejects it anyway.
  const existing = [slot({ id: 'pay_existing', employeeEmail: undefined })];
  const id = resolvePayStructureWriteTargetId(
    slot({ id: 'pay_new', employeeEmail: undefined }),
    existing,
  );
  assert.equal(id, 'pay_new');
});

test('the FIRST occupant wins when the data already holds duplicates', () => {
  // Shouldn't exist (the unique index forbids it), but if the index were ever
  // missing we must pick deterministically rather than at random.
  const existing = [slot({ id: 'pay_a' }), slot({ id: 'pay_b' })];
  const id = resolvePayStructureWriteTargetId(slot({ id: 'pay_new' }), existing);
  assert.equal(id, 'pay_a');
});
