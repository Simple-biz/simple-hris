/**
 * "Edit" on a MASTER-LIST department card edits manager access only (Kane,
 * 2026-09-03). HSL is excluded because its grants are per-sub-team access keys.
 *
 * Run:  npx tsx --test src/lib/departments/registry-builtin-managers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffBuiltinManagers,
  isBuiltinManagersEditable,
  validateBuiltinManagersInput,
} from './registry';

test('built-ins are editable except HSL; registry keys are not built-ins', () => {
  assert.equal(isBuiltinManagersEditable('lead_gen'), true);
  assert.equal(isBuiltinManagersEditable('accounting'), true);
  assert.equal(isBuiltinManagersEditable('hogan_smith_law'), false);
  assert.equal(isBuiltinManagersEditable('executive_assistants'), false);
});

test('validate: needs a built-in key, at least one manager, valid unique emails', () => {
  const ok = validateBuiltinManagersInput({
    builtinKey: 'lead_gen',
    managers: [{ name: 'Vano', workEmail: 'vano@simple.biz' }],
  });
  assert.deepEqual(ok, { ok: true });
  assert.match(validateBuiltinManagersInput({ builtinKey: 'medical_billing', managers: [] }).error ?? '', /built-in/);
  assert.match(validateBuiltinManagersInput({ builtinKey: 'hogan_smith_law', managers: [{ name: 'X', workEmail: 'x@simple.biz' }] }).error ?? '', /sub-team/);
  assert.match(validateBuiltinManagersInput({ builtinKey: 'lead_gen', managers: [] }).error ?? '', /at least one Manager/);
  assert.match(
    validateBuiltinManagersInput({
      builtinKey: 'lead_gen',
      managers: [{ name: 'A', workEmail: 'a@simple.biz' }, { name: 'B', workEmail: 'A@simple.biz' }],
    }).error ?? '',
    /twice/,
  );
  assert.equal(validateBuiltinManagersInput({ builtinKey: 'lead_gen', managers: [{ name: 'A', workEmail: 'nope' }] }).ok, false);
});

test('diff: grants what is new, revokes what is gone, case-insensitive', () => {
  const d = diffBuiltinManagers(['Vano@simple.biz', 'old@simple.biz'], ['vano@simple.biz', 'new@simple.biz']);
  assert.deepEqual(d.granted, ['new@simple.biz']);
  assert.deepEqual(d.revoked, ['old@simple.biz']);
  assert.equal(d.changed, true);
  assert.equal(diffBuiltinManagers(['a@simple.biz'], ['A@simple.biz']).changed, false);
});
