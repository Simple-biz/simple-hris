import test from 'node:test';
import assert from 'node:assert/strict';
import { deptKeyForLabel, deptLabelForKey, leaverPayDepartment, pickLeaverStructure } from './leaver-pay-department';
import type { CatalogRateIndex } from '@/lib/payroll/resolve-rate';
import type { PayStructure } from '@/lib/payment-catalog/pay-structure';
import type { DepartmentRegistryEntry } from '@/lib/departments/registry';

const structure = (departmentKey: string, touched: string | null): { departmentKey: string; createdAt: string | null; updatedAt: string | null } => ({
  departmentKey,
  createdAt: touched,
  updatedAt: touched,
});

// ── the michaelsy@ case: an undated departure, a Hogan structure, a Lead Gen master cell ──

test('michaelsy@: a Hogan structure saved after he fell off the sheet moves his final pay to Hogan Smith Law', () => {
  const r = leaverPayDepartment({
    masterDepartment: 'Lead Gen',
    offBoardedAt: null,
    weekStart: '2026-09-06',
    structure: structure('hogan_smith_law', '2026-09-15T13:52:00Z'),
  });
  assert.deepEqual(r, { department: 'Hogan Smith Law', source: 'catalog' });
});

test('an UNDATED departure uses the pay week in view as its floor: a structure untouched since before the week does not relabel', () => {
  const r = leaverPayDepartment({
    masterDepartment: 'Lead Gen',
    offBoardedAt: null,
    weekStart: '2026-09-06',
    structure: structure('hogan_smith_law', '2026-08-17T19:00:00Z'),
  });
  assert.deepEqual(r, { department: 'Lead Gen', source: 'master' });
});

test('a structure with no readable date cannot prove it is a final-pay decision', () => {
  const r = leaverPayDepartment({
    masterDepartment: 'Lead Gen',
    offBoardedAt: '2026-09-14',
    structure: { departmentKey: 'hogan_smith_law', createdAt: null, updatedAt: null },
  });
  assert.deepEqual(r, { department: 'Lead Gen', source: 'master' });
});

test('with neither a departure date nor a week to anchor on, the structure speaks', () => {
  const r = leaverPayDepartment({
    masterDepartment: 'Lead Gen',
    offBoardedAt: null,
    structure: structure('hogan_smith_law', '2026-08-17'),
  });
  assert.equal(r.source, 'catalog');
});

// ── guard 1: no structure → master ──

test('no individual structure keeps the master label', () => {
  assert.deepEqual(leaverPayDepartment({ masterDepartment: 'Lead Gen', offBoardedAt: '2026-09-14', structure: null }), {
    department: 'Lead Gen',
    source: 'master',
  });
});

// ── guard 2: a structure touched BEFORE the departure is history ──

test('rebutasom@ before her 09-15 re-save: the 08-17 HSL bulk structure does not undo her HRIS move to Lead Gen', () => {
  const r = leaverPayDepartment({
    masterDepartment: 'Lead Gen',
    offBoardedAt: '2026-09-14T19:12:20.736+00:00',
    structure: structure('hogan_smith_law', '2026-08-17T19:06:00Z'),
  });
  assert.deepEqual(r, { department: 'Lead Gen', source: 'master' });
});

test('a structure touched ON the departure day counts as a final-pay decision', () => {
  const r = leaverPayDepartment({
    masterDepartment: 'Lead Gen',
    offBoardedAt: '2026-09-14',
    structure: structure('hogan_smith_law', '2026-09-14T23:00:00Z'),
  });
  assert.equal(r.source, 'catalog');
});

test('updatedAt outranks createdAt when deciding whether the structure was touched after the departure', () => {
  const r = leaverPayDepartment({
    masterDepartment: 'Lead Gen',
    offBoardedAt: '2026-09-11',
    structure: { departmentKey: 'hogan_smith_law', createdAt: '2026-08-17', updatedAt: '2026-09-11T14:40:00Z' },
  });
  assert.equal(r.source, 'catalog', 'markm@: aliviah re-touched the Hogan row on the day he left');
});

// ── guard 3: same department, different spelling → keep the master cell ──

test('an HSL sub-team cell is kept when the structure is the Hogan parent', () => {
  const r = leaverPayDepartment({
    masterDepartment: 'hsl:filing_specialist',
    offBoardedAt: '2026-09-08',
    structure: structure('hogan_smith_law', '2026-09-14'),
  });
  assert.deepEqual(r, { department: 'hsl:filing_specialist', source: 'master' }, 'marcell@ keeps his sub-team');
});

test('same built-in department under its display name stays master', () => {
  const r = leaverPayDepartment({
    masterDepartment: 'Lead Gen',
    offBoardedAt: '2026-09-14',
    structure: structure('lead_gen', '2026-09-15'),
  });
  assert.deepEqual(r, { department: 'Lead Gen', source: 'master' });
});

test('a different HSL sub-team key from the catalog replaces the master sub-team', () => {
  const r = leaverPayDepartment({
    masterDepartment: 'hsl:filing_specialist',
    offBoardedAt: '2026-09-08',
    structure: structure('hsl:intake_specialist', '2026-09-14'),
  });
  // Both are the Hogan family, so guard 3 keeps the master cell: an intra-HSL
  // reshuffle is not a pay-basis change (same week model, same premium).
  assert.deepEqual(r, { department: 'hsl:filing_specialist', source: 'master' });
});

test('a blank master label and a structure → the structure names the department', () => {
  const r = leaverPayDepartment({ masterDepartment: '', offBoardedAt: null, structure: structure('lead_gen', '2026-09-15') });
  assert.deepEqual(r, { department: 'Lead Gen', source: 'catalog' });
});

// ── key ⇄ label ──

test('deptLabelForKey: built-ins by name, hsl:* verbatim, registry by current name, unknown keys as-is', () => {
  const registry = [{ key: 'medical_billing', name: 'Medical Billing' } as unknown as DepartmentRegistryEntry];
  assert.equal(deptLabelForKey('hogan_smith_law'), 'Hogan Smith Law');
  assert.equal(deptLabelForKey('lead_gen'), 'Lead Gen');
  assert.equal(deptLabelForKey('hsl:intake_specialist'), 'hsl:intake_specialist');
  assert.equal(deptLabelForKey('medical_billing', registry), 'Medical Billing');
  assert.equal(deptLabelForKey('mystery_key'), 'mystery_key');
});

test('deptKeyForLabel resolves the way the wizard tiers do', () => {
  assert.equal(deptKeyForLabel('Hogan Smith Law'), 'hogan_smith_law');
  assert.equal(deptKeyForLabel('hsl:intake_specialist'), 'hogan_smith_law');
  assert.equal(deptKeyForLabel('Lead Gen'), 'lead_gen');
  assert.equal(deptKeyForLabel(null), null);
  assert.equal(deptKeyForLabel('   '), null);
});

// ── the structure the rate resolves to ──

test('pickLeaverStructure walks aliases Hubstaff-first and normalises case', () => {
  const hogan = { id: 'a', scope: 'employee', departmentKey: 'hogan_smith_law', employeeEmail: 'michaelsy@simple.biz', regularRate: 265, currency: 'PHP' } as PayStructure;
  const other = { id: 'b', scope: 'employee', departmentKey: 'lead_gen', employeeEmail: 'alias@simple.biz', regularRate: 175, currency: 'PHP' } as PayStructure;
  const index: CatalogRateIndex = {
    byEmail: new Map([
      ['michaelsy@simple.biz', hogan],
      ['alias@simple.biz', other],
    ]),
    byDeptKey: new Map(),
  };
  assert.equal(pickLeaverStructure(index, ['MichaelSy@simple.biz', 'alias@simple.biz'])?.id, 'a');
  assert.equal(pickLeaverStructure(index, [null, undefined, 'alias@simple.biz'])?.id, 'b');
  assert.equal(pickLeaverStructure(index, ['nobody@simple.biz']), null);
});
