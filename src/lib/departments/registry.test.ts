/**
 * Coverage for the custom-department registry helpers behind the Payment
 * Catalog "Department" tab: slug keys, raw-string resolution, and the
 * create-department validation the wizard and API both run.
 *
 * Run:  npx tsx --test src/lib/departments/registry.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugifyDeptKey,
  subDeptStructureKey,
  resolveDeptKeyWithRegistry,
  rawDeptMatchesEntry,
  validateCreateDepartmentInput,
  type CreateDepartmentInput,
  type DepartmentRegistryEntry,
  type NewDepartmentMember,
  type NewSubDepartment,
} from './registry';

const entry: DepartmentRegistryEntry = {
  key: 'medical_billing',
  name: 'Medical Billing',
  subDepartments: [{ key: 'intake_team', name: 'Intake Team' }],
  members: [],
  createdBy: 'kaner@simple.biz',
  createdAt: '2026-07-24T00:00:00.000Z',
};

function member(overrides: Partial<NewDepartmentMember> = {}): NewDepartmentMember {
  return {
    name: 'Juan Dela Cruz',
    workEmail: 'juan@simple.biz',
    isManager: true,
    ...overrides,
  };
}

function input(overrides: Partial<CreateDepartmentInput> = {}): CreateDepartmentInput {
  return {
    name: 'Medical Billing',
    subDepartments: [],
    members: [member()],
    payStructure: null,
    ...overrides,
  };
}

function sub(name: string, overrides: Partial<NewSubDepartment> = {}): NewSubDepartment {
  return { name, payStructure: null, ...overrides };
}

test('slugifyDeptKey normalizes labels to stable keys', () => {
  assert.equal(slugifyDeptKey('Medical Billing'), 'medical_billing');
  assert.equal(slugifyDeptKey('  AI & Research / Ops  '), 'ai_research_ops');
  assert.equal(slugifyDeptKey('---'), '');
});

test('resolveDeptKeyWithRegistry prefers the built-in alias map', () => {
  assert.equal(resolveDeptKeyWithRegistry('Callback Team', [entry]), 'callback');
  assert.equal(resolveDeptKeyWithRegistry('HSL', [entry]), 'hogan_smith_law');
});

test('resolveDeptKeyWithRegistry falls back to registry name or slug', () => {
  assert.equal(resolveDeptKeyWithRegistry('Medical Billing', [entry]), 'medical_billing');
  assert.equal(resolveDeptKeyWithRegistry('  medical billing ', [entry]), 'medical_billing');
  assert.equal(resolveDeptKeyWithRegistry('Unknown Dept', [entry]), null);
  assert.equal(resolveDeptKeyWithRegistry(null, [entry]), null);
});

test('rawDeptMatchesEntry matches by label or slug, not others', () => {
  assert.ok(rawDeptMatchesEntry('Medical Billing', entry));
  assert.ok(rawDeptMatchesEntry('medical billing', entry));
  assert.ok(!rawDeptMatchesEntry('Accounting', entry));
  assert.ok(!rawDeptMatchesEntry(null, entry));
});

test('validate: happy path', () => {
  assert.deepEqual(validateCreateDepartmentInput(input()), { ok: true });
});

test('validate: rejects empty and built-in names', () => {
  assert.equal(validateCreateDepartmentInput(input({ name: '  ' })).ok, false);
  // "Callbacks" aliases to the built-in callback department.
  assert.match(
    validateCreateDepartmentInput(input({ name: 'Callbacks' })).error ?? '',
    /built-in/,
  );
  // Slug collision with a built-in key is also a conflict.
  assert.match(
    validateCreateDepartmentInput(input({ name: 'Lead-Gen' })).error ?? '',
    /built-in/,
  );
});

test('validate: requires at least one manager', () => {
  const res = validateCreateDepartmentInput(input({ members: [member({ isManager: false })] }));
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /Manager/i);
  assert.equal(validateCreateDepartmentInput(input({ members: [] })).ok, false);
});

test('validate: catches duplicate and malformed emails', () => {
  const dup = validateCreateDepartmentInput(
    input({ members: [member(), member({ isManager: false, name: 'B', workEmail: 'JUAN@simple.biz' })] }),
  );
  assert.equal(dup.ok, false);
  assert.match(dup.error ?? '', /twice/);
  assert.equal(
    validateCreateDepartmentInput(input({ members: [member({ workEmail: 'not-an-email' })] })).ok,
    false,
  );
});

test('validate: sub-departments must be unique and assigned subs must exist', () => {
  assert.equal(
    validateCreateDepartmentInput(
      input({ subDepartments: [sub('Intake Team'), sub('intake  team')] }),
    ).ok,
    false,
  );
  const orphan = validateCreateDepartmentInput(
    input({ subDepartments: [sub('Intake Team')], members: [member({ subDepartment: 'other_team' })] }),
  );
  assert.equal(orphan.ok, false);
  const ok = validateCreateDepartmentInput(
    input({ subDepartments: [sub('Intake Team')], members: [member({ subDepartment: 'intake_team' })] }),
  );
  assert.equal(ok.ok, true);
});

test('validate: per-sub-department base rates', () => {
  // A valid rate on one sub, none on the other — both fine.
  assert.equal(
    validateCreateDepartmentInput(
      input({
        subDepartments: [
          sub('Intake Team', { payStructure: { regularRate: 150, otRate: 225, currency: 'PHP' } }),
          sub('Filing Team'),
        ],
      }),
    ).ok,
    true,
  );
  // Bad numbers are named per sub-department.
  const bad = validateCreateDepartmentInput(
    input({
      subDepartments: [sub('Intake Team', { payStructure: { regularRate: -5, currency: 'PHP' } })],
    }),
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /Intake Team/);
  const badOt = validateCreateDepartmentInput(
    input({
      subDepartments: [
        sub('Intake Team', { payStructure: { regularRate: 100, otRate: -1, currency: 'PHP' } }),
      ],
    }),
  );
  assert.equal(badOt.ok, false);
});

test('validate: a department with sub-departments carries NO department-wide rate', () => {
  const res = validateCreateDepartmentInput(
    input({
      subDepartments: [sub('Intake Team')],
      payStructure: { regularRate: 120, currency: 'PHP' },
    }),
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /sub-department/i);
});

test('subDeptStructureKey namespaces like the HSL convention', () => {
  assert.equal(subDeptStructureKey('medical_billing', 'intake_team'), 'medical_billing:intake_team');
});

test('validate: pay structure bounds', () => {
  assert.equal(
    validateCreateDepartmentInput(
      input({ payStructure: { regularRate: 120, otRate: 180, currency: 'PHP' } }),
    ).ok,
    true,
  );
  assert.equal(
    validateCreateDepartmentInput(
      input({ payStructure: { regularRate: -1, currency: 'PHP' } }),
    ).ok,
    false,
  );
  assert.equal(
    validateCreateDepartmentInput(
      input({ payStructure: { regularRate: 100, otRate: -5, currency: 'PHP' } }),
    ).ok,
    false,
  );
});
