/**
 * The master-list card's People step WRITES (Kane, 2026-09-21) — as a REAL
 * department transfer, never as a registry member record.
 *
 * The rules these tests exist to hold:
 *  - a bare family label is NOT a placement (`isPlaceableDeptLabel`), so an HSL
 *    arrival must name a sub-team. Accepting "HSL" would put a new arrival on a
 *    parent base rate that was DELETED in the 2026-08-14 cutover, so they would
 *    resolve no department base at all;
 *  - a move must touch the edited department on one side or the other, so this
 *    dialog cannot become a general-purpose transfer tool;
 *  - an HSL sub-team reshuffle is `within`, which matters beyond bookkeeping:
 *    `buildHslTransferEffectiveMap` skips rows whose `from_department` is
 *    already HSL-family, so a reshuffle must NOT reset the +P15/h weekend
 *    premium day-scoping.
 *
 * Run:  npx tsx --test src/lib/departments/registry-builtin-people.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBuiltinPersonMove,
  diffBuiltinPeople,
  validateBuiltinPeopleInput,
  type BuiltinPersonMove,
} from './registry';

const move = (over: Partial<BuiltinPersonMove> = {}): BuiltinPersonMove => ({
  name: 'Person',
  workEmail: 'p@simple.biz',
  personalEmail: null,
  fromDepartment: 'Lead Gen',
  toDepartment: 'QC',
  ...over,
});

test('classify: in / out / within / unrelated', () => {
  assert.equal(classifyBuiltinPersonMove('qc', move()), 'in');
  assert.equal(classifyBuiltinPersonMove('lead_gen', move()), 'out');
  assert.equal(
    classifyBuiltinPersonMove('hogan_smith_law', move({ fromDepartment: 'hsl:intake_specialist', toDepartment: 'hsl:filing_specialist' })),
    'within',
    'an HSL sub-team reshuffle stays inside the family',
  );
  assert.equal(classifyBuiltinPersonMove('accounting', move()), 'unrelated');
});

test('validate: a move must touch the edited department', () => {
  assert.deepEqual(validateBuiltinPeopleInput({ builtinKey: 'qc', moves: [move()] }), { ok: true });
  assert.match(
    validateBuiltinPeopleInput({ builtinKey: 'accounting', moves: [move()] }).error ?? '',
    /neither side/,
  );
});

test('validate: a bare HSL target is REFUSED — the sub-team carries the rate', () => {
  for (const bare of ['HSL', 'Hogan Smith Law', 'hogan_smith_law']) {
    const res = validateBuiltinPeopleInput({
      builtinKey: 'hogan_smith_law',
      moves: [move({ toDepartment: bare })],
    });
    assert.equal(res.ok, false, `${bare} must not be placeable`);
    assert.match(res.error ?? '', /not a placement/);
  }
  assert.deepEqual(
    validateBuiltinPeopleInput({
      builtinKey: 'hogan_smith_law',
      moves: [move({ toDepartment: 'hsl:intake_specialist' })],
    }),
    { ok: true },
  );
});

test('validate: placement-only sub-teams are real destinations', () => {
  assert.deepEqual(
    validateBuiltinPeopleInput({
      builtinKey: 'hogan_smith_law',
      moves: [move({ toDepartment: 'hsl:simple_texting' })],
    }),
    { ok: true },
  );
});

test('validate: no no-ops, no duplicates, no bad emails, no empty sides', () => {
  assert.match(
    validateBuiltinPeopleInput({ builtinKey: 'qc', moves: [move({ fromDepartment: 'QC', toDepartment: 'qc' })] }).error ?? '',
    /already in/,
  );
  assert.match(
    validateBuiltinPeopleInput({
      builtinKey: 'qc',
      moves: [move(), move({ workEmail: 'P@simple.biz', toDepartment: 'QC' })],
    }).error ?? '',
    /twice/,
  );
  assert.equal(validateBuiltinPeopleInput({ builtinKey: 'qc', moves: [move({ workEmail: 'nope' })] }).ok, false);
  assert.match(
    validateBuiltinPeopleInput({ builtinKey: 'qc', moves: [move({ fromDepartment: '' })] }).error ?? '',
    /no current department/,
  );
  assert.match(
    validateBuiltinPeopleInput({ builtinKey: 'qc', moves: [move({ toDepartment: '' })] }).error ?? '',
    /destination/,
  );
});

test('validate: only built-in keys, and the batch is bounded', () => {
  assert.match(validateBuiltinPeopleInput({ builtinKey: 'executive_assistants', moves: [] }).error ?? '', /built-in/);
  const many = Array.from({ length: 101 }, (_, i) => move({ workEmail: `p${i}@simple.biz` }));
  assert.match(validateBuiltinPeopleInput({ builtinKey: 'qc', moves: many }).error ?? '', /at most/);
});

test('diff: buckets the moves and reports change', () => {
  const d = diffBuiltinPeople('hogan_smith_law', {
    builtinKey: 'hogan_smith_law',
    moves: [
      move({ workEmail: 'a@simple.biz', fromDepartment: 'Lead Gen', toDepartment: 'hsl:intake_specialist' }),
      move({ workEmail: 'b@simple.biz', fromDepartment: 'hsl:care_team', toDepartment: 'QC' }),
      move({ workEmail: 'c@simple.biz', fromDepartment: 'hsl:care_team', toDepartment: 'hsl:collections' }),
    ],
  });
  assert.deepEqual(d.added.map((m) => m.workEmail), ['a@simple.biz']);
  assert.deepEqual(d.removed.map((m) => m.workEmail), ['b@simple.biz']);
  assert.deepEqual(d.reshuffled.map((m) => m.workEmail), ['c@simple.biz']);
  assert.equal(d.changed, true);
  assert.equal(diffBuiltinPeople('qc', { builtinKey: 'qc', moves: [] }).changed, false);
});
