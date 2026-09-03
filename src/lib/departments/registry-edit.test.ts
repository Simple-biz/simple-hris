/**
 * Edit Department (Payment Catalog → Departments → Edit): the rename/alias
 * rules, the edit validator, the diff the Review step and the PATCH route share,
 * and the pure "next entry" the route writes.
 *
 * Run:  npx tsx --test src/lib/departments/registry-edit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDepartmentEdit,
  deptEntryLabels,
  deptKeyAliasSlugs,
  diffDepartmentEdit,
  managerGrantLabel,
  rawDeptMatchesEntry,
  resolveDeptKeyWithRegistry,
  validateEditDepartmentInput,
  type DepartmentRegistryEntry,
  type EditDepartmentInput,
  type NewDepartmentMember,
} from './registry';

const mgr: NewDepartmentMember = { name: 'Jame C', workEmail: 'jamec@simple.biz', isManager: true };
const cj: NewDepartmentMember = { name: 'CJ M', workEmail: 'cjm@simple.biz', isManager: false, subDepartment: 'intake_team' };

const existing: DepartmentRegistryEntry = {
  key: 'medical_billing',
  name: 'Medical Billing',
  subDepartments: [
    { key: 'intake_team', name: 'Intake Team' },
    { key: 'filing_team', name: 'Filing Team' },
  ],
  members: [
    { ...mgr, workEmail: 'jamec@simple.biz', addedBy: 'kaner@simple.biz', addedAt: '2026-07-24T00:00:00.000Z' },
    { ...cj, addedBy: 'kaner@simple.biz', addedAt: '2026-07-24T00:00:00.000Z' },
  ],
  createdBy: 'kaner@simple.biz',
  createdAt: '2026-07-24T00:00:00.000Z',
};

const other: DepartmentRegistryEntry = {
  key: 'executive_assistants',
  name: 'EA Team',
  previousNames: ['Executive Assistants'],
  subDepartments: [],
  members: [],
  createdBy: null,
  createdAt: '2026-07-24T00:00:00.000Z',
};

const registry = [existing, other];

function edit(overrides: Partial<EditDepartmentInput> = {}): EditDepartmentInput {
  return {
    key: 'medical_billing',
    expectedRevision: '2026-09-03T00:00:00.000Z',
    name: 'Medical Billing',
    subDepartments: [
      { key: 'intake_team', name: 'Intake Team', payStructure: null },
      { key: 'filing_team', name: 'Filing Team', payStructure: null },
    ],
    members: [mgr, cj],
    ...overrides,
  };
}

// ── rename keeps the key; the old label keeps resolving ─────────────────────

test('a renamed department answers to its current AND former names', () => {
  assert.deepEqual(deptEntryLabels(other), ['EA Team', 'Executive Assistants']);
  assert.equal(resolveDeptKeyWithRegistry('Executive Assistants', registry), 'executive_assistants');
  assert.equal(resolveDeptKeyWithRegistry('EA Team', registry), 'executive_assistants');
  assert.equal(resolveDeptKeyWithRegistry('ea team', registry), 'executive_assistants');
  assert.ok(rawDeptMatchesEntry('EA Team', other));
  assert.ok(rawDeptMatchesEntry('Executive Assistants', other));
  assert.ok(!rawDeptMatchesEntry('EA Team', existing));
});

test('the manager grant label is the label whose slug IS the key — never the new name', () => {
  assert.equal(managerGrantLabel(other), 'Executive Assistants');
  assert.equal(managerGrantLabel(existing), 'Medical Billing');
});

test('alias slugs map a renamed label to the key and never shadow a built-in', () => {
  const aliases = deptKeyAliasSlugs(registry);
  assert.equal(aliases.get('ea_team'), 'executive_assistants');
  // The current label of an un-renamed department slugs TO its key — no alias needed.
  assert.equal(aliases.has('medical_billing'), false);
  // A label that would slug to a built-in key is skipped.
  const shady: DepartmentRegistryEntry = { ...other, previousNames: ['Accounting'] };
  assert.equal(deptKeyAliasSlugs([shady]).has('accounting'), false);
});

// ── validator ───────────────────────────────────────────────────────────────

test('validate edit: unchanged input is fine', () => {
  assert.deepEqual(validateEditDepartmentInput(edit(), existing, registry), { ok: true });
});

test('validate edit: rename cannot take a built-in or another registry label (current OR former)', () => {
  assert.match(validateEditDepartmentInput(edit({ name: 'Callbacks' }), existing, registry).error ?? '', /built-in/);
  assert.match(validateEditDepartmentInput(edit({ name: 'EA Team' }), existing, registry).error ?? '', /already used/);
  assert.match(
    validateEditDepartmentInput(edit({ name: 'Executive Assistants' }), existing, registry).error ?? '',
    /already used/,
  );
  // Renaming to a fresh label is allowed.
  assert.equal(validateEditDepartmentInput(edit({ name: 'Billing Ops' }), existing, registry).ok, true);
});

test('validate edit: the last manager cannot be removed or demoted', () => {
  const demoted = validateEditDepartmentInput(edit({ members: [{ ...mgr, isManager: false }, cj] }), existing, registry);
  assert.equal(demoted.ok, false);
  assert.match(demoted.error ?? '', /Manager/);
  const removed = validateEditDepartmentInput(edit({ members: [cj] }), existing, registry);
  assert.equal(removed.ok, false);
});

test('validate edit: a member cannot point at a removed sub-department', () => {
  const res = validateEditDepartmentInput(
    edit({ subDepartments: [{ key: 'filing_team', name: 'Filing Team', payStructure: null }] }),
    existing,
    registry,
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /sub-department that isn't defined/);
});

test('validate edit: existing sub keys are pinned; unknown keys and rates on existing subs are refused', () => {
  assert.match(
    validateEditDepartmentInput(
      edit({ subDepartments: [{ key: 'ghost', name: 'Ghost', payStructure: null }], members: [mgr] }),
      existing,
      registry,
    ).error ?? '',
    /doesn't have/,
  );
  assert.match(
    validateEditDepartmentInput(
      edit({
        subDepartments: [
          { key: 'intake_team', name: 'Intake Team', payStructure: { regularRate: 100, currency: 'PHP' } },
          { key: 'filing_team', name: 'Filing Team', payStructure: null },
        ],
      }),
      existing,
      registry,
    ).error ?? '',
    /managed in Pay Structure/,
  );
});

test('validate edit: a new sub-department may carry a rate and may not collide with a kept key', () => {
  const ok = validateEditDepartmentInput(
    edit({
      subDepartments: [
        { key: 'intake_team', name: 'Intake Team', payStructure: null },
        { key: 'filing_team', name: 'Filing Team', payStructure: null },
        { key: null, name: 'QA Team', payStructure: { regularRate: 180, otRate: 270, currency: 'PHP' } },
      ],
    }),
    existing,
    registry,
  );
  assert.equal(ok.ok, true);
  const dup = validateEditDepartmentInput(
    edit({
      subDepartments: [
        { key: 'intake_team', name: 'Intake Team', payStructure: null },
        { key: 'filing_team', name: 'Filing Team', payStructure: null },
        { key: null, name: 'intake  team', payStructure: null },
      ],
    }),
    existing,
    registry,
  );
  assert.match(dup.error ?? '', /listed twice/);
});

// ── diff + apply ────────────────────────────────────────────────────────────

test('diff: no-op edit reports nothing changed', () => {
  const d = diffDepartmentEdit(existing, edit());
  assert.equal(d.changed, false);
  assert.equal(d.renamed, null);
  assert.deepEqual(d.subsRemoved, []);
});

test('diff: rename, sub rename/add/remove, member add/remove, manager grant/revoke', () => {
  const d = diffDepartmentEdit(
    existing,
    edit({
      name: 'Billing Ops',
      subDepartments: [
        { key: 'intake_team', name: 'Intake', payStructure: null },
        { key: null, name: 'QA Team', payStructure: { regularRate: 180, currency: 'PHP' } },
      ],
      members: [
        { ...mgr, isManager: false },
        { ...cj, isManager: true },
        { name: 'New Hire', workEmail: 'NEW@simple.biz', isManager: true },
      ],
    }),
  );
  assert.deepEqual(d.renamed, { from: 'Medical Billing', to: 'Billing Ops' });
  assert.deepEqual(d.subsRenamed, [{ key: 'intake_team', from: 'Intake Team', to: 'Intake' }]);
  assert.deepEqual(d.subsAdded, [{ key: 'qa_team', name: 'QA Team', rated: true }]);
  assert.deepEqual(d.subsRemoved, [{ key: 'filing_team', name: 'Filing Team' }]);
  assert.deepEqual(d.membersAdded, ['new@simple.biz']);
  assert.deepEqual(d.membersRemoved, []);
  assert.deepEqual(d.managersGranted, ['cjm@simple.biz', 'new@simple.biz']);
  assert.deepEqual(d.managersRevoked, ['jamec@simple.biz']);
  assert.equal(d.changed, true);
});

test('diff: removing a manager revokes; re-adding a removed sub as new counts as removed AND added', () => {
  const d = diffDepartmentEdit(
    existing,
    edit({
      subDepartments: [
        { key: 'intake_team', name: 'Intake Team', payStructure: null },
        { key: null, name: 'Filing Team', payStructure: null },
      ],
      members: [{ ...cj, isManager: true }],
    }),
  );
  assert.deepEqual(d.membersRemoved, ['jamec@simple.biz']);
  assert.deepEqual(d.managersRevoked, ['jamec@simple.biz']);
  assert.deepEqual(d.subsRemoved, [{ key: 'filing_team', name: 'Filing Team' }]);
  assert.deepEqual(d.subsAdded, [{ key: 'filing_team', name: 'Filing Team', rated: false }]);
});

test('apply: key/createdBy/createdAt never move; rename files the old name; kept members keep attribution', () => {
  const next = applyDepartmentEdit(
    existing,
    edit({
      name: 'Billing Ops',
      members: [mgr, { name: 'New Hire', workEmail: 'new@simple.biz', isManager: false, subDepartment: 'filing_team' }],
    }),
    'lenny@simple.biz',
    '2026-09-03T10:00:00.000Z',
  );
  assert.equal(next.key, 'medical_billing');
  assert.equal(next.name, 'Billing Ops');
  assert.deepEqual(next.previousNames, ['Medical Billing']);
  assert.equal(next.createdBy, 'kaner@simple.biz');
  assert.equal(next.createdAt, '2026-07-24T00:00:00.000Z');
  assert.equal(next.updatedBy, 'lenny@simple.biz');
  assert.equal(next.updatedAt, '2026-09-03T10:00:00.000Z');
  const kept = next.members.find((m) => m.workEmail === 'jamec@simple.biz')!;
  assert.equal(kept.addedBy, 'kaner@simple.biz');
  assert.equal(kept.addedAt, '2026-07-24T00:00:00.000Z');
  const added = next.members.find((m) => m.workEmail === 'new@simple.biz')!;
  assert.equal(added.addedBy, 'lenny@simple.biz');
  assert.equal(added.subDepartment, 'filing_team');
  // The grant label still resolves to the original name after the rename.
  assert.equal(managerGrantLabel(next), 'Medical Billing');
  assert.equal(resolveDeptKeyWithRegistry('Billing Ops', [next]), 'medical_billing');
  assert.equal(resolveDeptKeyWithRegistry('Medical Billing', [next]), 'medical_billing');
});

test('apply: renaming BACK to a former name drops it from previousNames', () => {
  const back = applyDepartmentEdit(
    { ...other },
    {
      key: 'executive_assistants',
      expectedRevision: null,
      name: 'Executive Assistants',
      subDepartments: [],
      members: [mgr],
    },
    'kaner@simple.biz',
    '2026-09-03T10:00:00.000Z',
  );
  assert.equal(back.name, 'Executive Assistants');
  assert.deepEqual(back.previousNames, ['EA Team']);
  assert.equal(managerGrantLabel(back), 'Executive Assistants');
});
