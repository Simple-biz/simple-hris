/**
 * "Edit" on a MASTER-LIST department card edits manager access only (Kane,
 * 2026-09-03), through one SCOPE per grant label (Kane, 2026-09-21).
 *
 * HSL was excluded outright until 2026-09-21 because its grants are per-sub-team
 * access keys that `normalizeDeptToKey` collapses onto the parent. It is editable
 * now because the editor stopped collapsing them: one list per `hsl:<sub>`, so a
 * revoke lands on the team it was made under and nowhere else. The tests below
 * pin exactly that — a family-wide revoke is the regression they exist to catch.
 *
 * Run:  npx tsx --test src/lib/departments/registry-builtin-managers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  builtinManagerScopes,
  diffBuiltinManagers,
  diffBuiltinManagerScopes,
  isBuiltinManagersEditable,
  partitionBuiltinGrants,
  validateBuiltinManagersInput,
  type BuiltinGrantRow,
  type BuiltinManagersInput,
} from './registry';

const scopeInput = (builtinKey: string, managersByLabel: Record<string, [string, string][]>): BuiltinManagersInput => ({
  builtinKey,
  scopes: builtinManagerScopes(builtinKey).map((s) => ({
    grantLabel: s.grantLabel,
    managers: (managersByLabel[s.grantLabel] ?? []).map(([name, workEmail]) => ({ name, workEmail })),
  })),
});

test('every built-in is editable now, INCLUDING HSL; registry keys are not built-ins', () => {
  assert.equal(isBuiltinManagersEditable('lead_gen'), true);
  assert.equal(isBuiltinManagersEditable('accounting'), true);
  // Changed 2026-09-21 by Kane's ruling. Was false; the per-sub-team scopes are
  // what made the exclusion unnecessary rather than merely inconvenient.
  assert.equal(isBuiltinManagersEditable('hogan_smith_law'), true);
  assert.equal(isBuiltinManagersEditable('executive_assistants'), false);
});

test('scopes: a flat built-in has exactly one; HSL has one per sub-team', () => {
  const flat = builtinManagerScopes('lead_gen');
  assert.equal(flat.length, 1);
  assert.deepEqual(flat[0], { grantLabel: 'Lead Gen', displayName: 'Lead Gen' });

  const hsl = builtinManagerScopes('hogan_smith_law');
  assert.ok(hsl.length > 1, 'HSL must expose a scope per sub-team');
  assert.ok(
    hsl.every((s) => s.grantLabel.startsWith('hsl:')),
    'every HSL scope writes a raw hsl:<sub> access key',
  );
  assert.ok(hsl.some((s) => s.grantLabel === 'hsl:intake_specialist'));
  // Placement-only teams are real places to manage, not just to sit.
  assert.ok(hsl.some((s) => s.grantLabel === 'hsl:simple_texting'));
  assert.equal(builtinManagerScopes('not_a_department').length, 0);
});

test('partition (flat): every alias spelling lands in the one scope, nothing unscoped', () => {
  const rows: BuiltinGrantRow[] = [
    { department: 'Lead Gen', managerEmail: 'A@simple.biz' },
    { department: 'Lead Generation', managerEmail: 'b@simple.biz' },
    { department: 'Accounting', managerEmail: 'c@simple.biz' },
  ];
  const p = partitionBuiltinGrants('lead_gen', rows);
  assert.deepEqual(p.byScope.get('lead gen'), ['a@simple.biz', 'b@simple.biz']);
  assert.deepEqual(p.unscoped, []);
});

test('partition (HSL): sub-teams stay SEPARATE and family-level grants are unscoped', () => {
  const rows: BuiltinGrantRow[] = [
    { department: 'hsl:intake_specialist', managerEmail: 'intake@simple.biz' },
    { department: 'hsl:filing_specialist', managerEmail: 'filing@simple.biz' },
    { department: 'HSL', managerEmail: 'family@simple.biz' },
    { department: 'Hogan Smith Law', managerEmail: 'family2@simple.biz' },
    { department: 'hsl:lead_nurture', managerEmail: 'retired@simple.biz' },
    { department: 'Lead Gen', managerEmail: 'other@simple.biz' },
  ];
  const p = partitionBuiltinGrants('hogan_smith_law', rows);

  assert.deepEqual(p.byScope.get('hsl:intake_specialist'), ['intake@simple.biz']);
  assert.deepEqual(p.byScope.get('hsl:filing_specialist'), ['filing@simple.biz']);
  // The collapse is exactly what must NOT happen.
  assert.ok(!p.byScope.get('hsl:intake_specialist')?.includes('filing@simple.biz'));
  assert.ok(!p.byScope.get('hsl:intake_specialist')?.includes('family@simple.biz'));

  // Bare family labels and a retired sub-key are surfaced, never silently dropped.
  const unscoped = p.unscoped.map((u) => u.label).sort();
  assert.deepEqual(unscoped, ['HSL', 'Hogan Smith Law', 'hsl:lead_nurture']);
  // A different department never leaks in.
  assert.ok(!p.unscoped.some((u) => u.managerEmail === 'other@simple.biz'));
});

test('validate: built-in key, exact scope set, unique valid emails, >=1 manager on the DEPARTMENT', () => {
  assert.deepEqual(scopeValidate('lead_gen', { 'Lead Gen': [['Vano', 'vano@simple.biz']] }), { ok: true });

  assert.match(
    validateBuiltinManagersInput({ builtinKey: 'medical_billing', scopes: [] }).error ?? '',
    /built-in/,
  );
  assert.match(scopeValidate('lead_gen', {}).error ?? '', /at least one Manager/);
  assert.match(
    scopeValidate('lead_gen', {
      'Lead Gen': [
        ['A', 'a@simple.biz'],
        ['B', 'A@simple.biz'],
      ],
    }).error ?? '',
    /twice/,
  );
  assert.equal(scopeValidate('lead_gen', { 'Lead Gen': [['A', 'nope']] }).ok, false);

  // A client may not invent, drop or duplicate a grant label.
  assert.match(
    validateBuiltinManagersInput({
      builtinKey: 'lead_gen',
      scopes: [{ grantLabel: 'Something Else', managers: [{ name: 'A', workEmail: 'a@simple.biz' }] }],
    }).error ?? '',
    /not a manager scope/,
  );
  assert.match(
    validateBuiltinManagersInput({ builtinKey: 'lead_gen', scopes: [] }).error ?? '',
    /manager scopes/,
  );
});

test('validate (HSL): one manager on ONE sub-team satisfies the department', () => {
  const res = scopeValidate('hogan_smith_law', { 'hsl:intake_specialist': [['I', 'i@simple.biz']] });
  assert.deepEqual(res, { ok: true }, 'empty sub-teams are legal; the department just needs a manager');
  assert.match(scopeValidate('hogan_smith_law', {}).error ?? '', /at least one Manager/);
});

test('diff (HSL): removing a manager from ONE sub-team leaves their other teams alone', () => {
  const rows: BuiltinGrantRow[] = [
    { department: 'hsl:intake_specialist', managerEmail: 'gyd@simple.biz' },
    { department: 'hsl:filing_specialist', managerEmail: 'gyd@simple.biz' },
  ];
  const p = partitionBuiltinGrants('hogan_smith_law', rows);
  // Drop gyd@ from Intake only; Filing keeps her.
  const input = scopeInput('hogan_smith_law', {
    'hsl:filing_specialist': [['Gyd', 'gyd@simple.biz']],
  });
  const d = diffBuiltinManagerScopes('hogan_smith_law', p, input);

  const intake = d.scopes.find((s) => s.grantLabel === 'hsl:intake_specialist');
  const filing = d.scopes.find((s) => s.grantLabel === 'hsl:filing_specialist');
  assert.deepEqual(intake?.revoked, ['gyd@simple.biz']);
  assert.deepEqual(filing?.revoked, [], 'the untouched sub-team must not revoke');
  assert.deepEqual(filing?.granted, [], 'the untouched sub-team must not re-grant');
  assert.equal(d.changed, true);
  // Intake held her and now holds nobody -> named, so Review can warn.
  assert.ok(d.emptied.some((n) => n.includes('Intake')));
});

test('diff (flat): unchanged behaviour for a one-scope department', () => {
  const rows: BuiltinGrantRow[] = [
    { department: 'Lead Gen', managerEmail: 'old@simple.biz' },
    { department: 'Lead Generation', managerEmail: 'keep@simple.biz' },
  ];
  const p = partitionBuiltinGrants('lead_gen', rows);
  const d = diffBuiltinManagerScopes(
    'lead_gen',
    p,
    scopeInput('lead_gen', {
      'Lead Gen': [
        ['Keep', 'keep@simple.biz'],
        ['New', 'new@simple.biz'],
      ],
    }),
  );
  assert.deepEqual(d.granted, ['new@simple.biz']);
  assert.deepEqual(d.revoked, ['old@simple.biz']);
  assert.deepEqual(d.emptied, []);
});

test('diff: no change is no change', () => {
  const rows: BuiltinGrantRow[] = [{ department: 'Lead Gen', managerEmail: 'A@simple.biz' }];
  const p = partitionBuiltinGrants('lead_gen', rows);
  const d = diffBuiltinManagerScopes('lead_gen', p, scopeInput('lead_gen', { 'Lead Gen': [['A', 'a@simple.biz']] }));
  assert.equal(d.changed, false);
});

test('diff primitive: grants what is new, revokes what is gone, case-insensitive', () => {
  const d = diffBuiltinManagers(['Vano@simple.biz', 'old@simple.biz'], ['vano@simple.biz', 'new@simple.biz']);
  assert.deepEqual(d.granted, ['new@simple.biz']);
  assert.deepEqual(d.revoked, ['old@simple.biz']);
  assert.equal(d.changed, true);
  assert.equal(diffBuiltinManagers(['a@simple.biz'], ['A@simple.biz']).changed, false);
});

/**
 * Every `hsl:*` grant label LIVE in `department_managers` on 2026-09-21, measured
 * read-only by `scripts/audit-department-manager-grants.mts` (113 HSL-family grant
 * rows across 14 sub-team labels + 2 family-level ones).
 *
 * This is the regression guard for the scoped editor: a sub-team label with no
 * scope would fall into `unscoped` and become invisible AND uneditable in the
 * dialog, which is how a manager quietly loses a team. Retiring a key from
 * HSL_DEPT_KEYS while grants still point at it fires this test.
 */
const LIVE_HSL_GRANT_LABELS = [
  'hsl:attestation',
  'hsl:callback_team',
  'hsl:care_team',
  'hsl:case_managers',
  'hsl:collections',
  'hsl:executive_assistants',
  'hsl:executive_guest_services',
  'hsl:filing_specialist',
  'hsl:healthcare_team_lead',
  'hsl:hsl_managers',
  'hsl:intake_specialist',
  'hsl:medical_records',
  'hsl:post_hearing_prep',
  'hsl:ssd_medical_records',
] as const;

test('every LIVE hsl:* grant label has a scope; only the family labels are unscoped', () => {
  const rows: BuiltinGrantRow[] = [
    ...LIVE_HSL_GRANT_LABELS.map((department) => ({ department, managerEmail: 'someone@simple.biz' })),
    { department: 'HSL', managerEmail: 'family@simple.biz' },
    { department: 'Hogan Smith Law', managerEmail: 'family2@simple.biz' },
  ];
  const p = partitionBuiltinGrants('hogan_smith_law', rows);

  for (const label of LIVE_HSL_GRANT_LABELS) {
    assert.deepEqual(
      p.byScope.get(label),
      ['someone@simple.biz'],
      `${label} is a live grant label with no scope — it would be uneditable`,
    );
  }
  assert.deepEqual(
    p.unscoped.map((u) => u.label).sort(),
    ['HSL', 'Hogan Smith Law'],
    'only the two family-level labels may be unscoped',
  );
});

function scopeValidate(key: string, managersByLabel: Record<string, [string, string][]>) {
  return validateBuiltinManagersInput(scopeInput(key, managersByLabel));
}
