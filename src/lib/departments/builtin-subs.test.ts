/**
 * Sub-departments on a MASTER-LIST department (Kane, 2026-09-21: "I want us to
 * make sure that if we edit these departments we can add sub departments in
 * it!").
 *
 * Two of these tests guard functions the WHOLE payroll stack leans on:
 * `normalizeDeptToKey` (the HSL Mon-Sun week model, the +P15/h weekend premium,
 * dept-scoped bonus matching, every wizard grouping) and `isPlaceableDeptLabel`.
 * Both were widened here, so both are pinned against widening any further.
 *
 * Run:  npx tsx --test src/lib/departments/builtin-subs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allBuiltinSubOptions,
  builtinSubLabel,
  builtinSubOccupancy,
  builtinSubOptions,
  diffBuiltinSubs,
  placeableSubIndex,
  supportsDataSubDepartments,
  validateBuiltinSubsInput,
  type BuiltinSubMap,
} from './builtin-subs';
import { isPlaceableDeptLabel, formatDeptLabel } from './hsl-subdept';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

const MAP: BuiltinSubMap = {
  lead_gen: [
    { key: 'nurture', name: 'Nurture' },
    { key: 'outbound', name: 'Outbound' },
  ],
};

test('HSL is excluded from DATA sub-departments; other built-ins are not', () => {
  assert.equal(supportsDataSubDepartments('lead_gen'), true);
  assert.equal(supportsDataSubDepartments('qc'), true);
  // HSL sub-teams are code: they carry KPI calculators and a Readiness row.
  assert.equal(supportsDataSubDepartments('hogan_smith_law'), false);
  assert.equal(supportsDataSubDepartments('executive_assistants'), false, 'registry keys are not built-ins');
  assert.match(
    validateBuiltinSubsInput({ builtinKey: 'hogan_smith_law', subDepartments: [{ key: 'x', name: 'X' }] }).error ?? '',
    /code/,
  );
});

test('normalizeDeptToKey resolves <parent>:<sub> for any real parent — and NOTHING else', () => {
  // The new branch.
  assert.equal(normalizeDeptToKey('lead_gen:nurture'), 'lead_gen');
  assert.equal(normalizeDeptToKey('Lead Gen:Nurture'), 'lead_gen', 'a label prefix works too');
  assert.equal(normalizeDeptToKey('QC:overflow'), 'qc');

  // HSL is unchanged — its prefix is NOT its key, which is why it is special-cased.
  assert.equal(normalizeDeptToKey('hsl:intake_specialist'), 'hogan_smith_law');
  assert.equal(normalizeDeptToKey('HSL'), 'hogan_smith_law');

  // Deliberately narrow: an unknown parent stays null, and a bare sub-team
  // display name is still NOT inferred (the rule that keeps "Callback Team" and
  // "Executive Assistants" out of the HSL cohort).
  assert.equal(normalizeDeptToKey('not_a_department:thing'), null);
  assert.equal(normalizeDeptToKey('Case Managers'), null);
  assert.equal(normalizeDeptToKey('Executive Assistants'), null);
  assert.equal(normalizeDeptToKey(':orphan'), null);
  assert.equal(normalizeDeptToKey(''), null);
  assert.equal(normalizeDeptToKey(null), null);
});

test('isPlaceableDeptLabel: unchanged with no map, sub-aware with one', () => {
  // No map -> exactly the pre-2026-09-21 behaviour.
  assert.equal(isPlaceableDeptLabel('Lead Gen'), true);
  assert.equal(isPlaceableDeptLabel('HSL'), false);
  assert.equal(isPlaceableDeptLabel('hsl:intake_specialist'), true);

  const subs = placeableSubIndex(MAP);
  // Lead Gen now HAS sub-teams, so a bare placement is no longer one.
  assert.equal(isPlaceableDeptLabel('Lead Gen', subs), false);
  assert.equal(isPlaceableDeptLabel('lead_gen:nurture', subs), true);
  assert.equal(isPlaceableDeptLabel('lead_gen:ghost', subs), false, 'a sub that does not exist is not a placement');
  // A department with no sub-teams is placeable exactly as before.
  assert.equal(isPlaceableDeptLabel('QC', subs), true);
  // HSL is untouched by the map.
  assert.equal(isPlaceableDeptLabel('HSL', subs), false);
  assert.equal(isPlaceableDeptLabel('hsl:filing_specialist', subs), true);
});

test('formatDeptLabel never shows a human a bare slug', () => {
  assert.equal(formatDeptLabel('hsl:intake_specialist'), 'HSL — Intake Specialist');
  assert.equal(formatDeptLabel('lead_gen:nurture'), 'Lead Gen — Nurture');
  assert.equal(formatDeptLabel('lead_gen:medical_intake'), 'Lead Gen — Medical Intake');
  assert.equal(formatDeptLabel('Lead Gen'), 'Lead Gen');
  assert.equal(formatDeptLabel('unknown:thing'), 'unknown:thing', 'an unknown parent passes through');
});

test('labels and options use the <parentKey>:<subKey> convention', () => {
  assert.equal(builtinSubLabel('lead_gen', 'nurture'), 'lead_gen:nurture');
  assert.deepEqual(builtinSubOptions(MAP, 'lead_gen'), [
    { value: 'lead_gen:nurture', label: 'Lead Gen — Nurture' },
    { value: 'lead_gen:outbound', label: 'Lead Gen — Outbound' },
  ]);
  assert.equal(builtinSubOptions(MAP, 'qc').length, 0);
  assert.equal(allBuiltinSubOptions(MAP).length, 2);
  assert.deepEqual(placeableSubIndex({}), {}, 'a department with no subs is absent from the index');
});

test('validate: names required, bounded, unique by key, and NO colons', () => {
  assert.deepEqual(validateBuiltinSubsInput({ builtinKey: 'lead_gen', subDepartments: MAP.lead_gen! }), { ok: true });
  assert.deepEqual(validateBuiltinSubsInput({ builtinKey: 'lead_gen', subDepartments: [] }), { ok: true });
  assert.match(
    validateBuiltinSubsInput({ builtinKey: 'lead_gen', subDepartments: [{ key: 'a', name: '  ' }] }).error ?? '',
    /needs a name/,
  );
  // A colon would make `<parent>:<a>:<b>`, and parentOfDeptKey splits at the
  // FIRST colon — the rail and the rate row would disagree about the parent.
  assert.match(
    validateBuiltinSubsInput({ builtinKey: 'lead_gen', subDepartments: [{ key: 'a:b', name: 'X' }] }).error ?? '',
    /colon/,
  );
  assert.match(
    validateBuiltinSubsInput({
      builtinKey: 'lead_gen',
      subDepartments: [
        { key: 'nurture', name: 'Nurture' },
        { key: 'nurture', name: 'Nurture Again' },
      ],
    }).error ?? '',
    /resolve to/,
  );
  assert.match(validateBuiltinSubsInput({ builtinKey: 'nope', subDepartments: [] }).error ?? '', /built-in/);
});

test('diff: the KEY is pinned, so a rename is a rename and not a remove+add', () => {
  const before = [{ key: 'nurture', name: 'Nurture' }];
  const after = [{ key: 'nurture', name: 'Lead Nurture' }];
  const d = diffBuiltinSubs(before, after);
  assert.deepEqual(d.renamed, [{ key: 'nurture', from: 'Nurture', to: 'Lead Nurture' }]);
  assert.deepEqual(d.added, [], 'a rename must not read as an add — the rate row would be orphaned');
  assert.deepEqual(d.removed, []);
  assert.equal(d.changed, true);

  assert.equal(diffBuiltinSubs(before, before).changed, false);
  assert.deepEqual(diffBuiltinSubs(before, []).removed, before);
  assert.deepEqual(diffBuiltinSubs([], before).added, before);
});

test('occupancy counts the people a removal would strand', () => {
  const cells = [
    'lead_gen:nurture',
    'Lead_Gen:Nurture',
    'lead_gen:outbound',
    'Lead Gen',
    'hsl:intake_specialist',
    '',
  ];
  const occ = builtinSubOccupancy('lead_gen', cells);
  assert.equal(occ.get('nurture'), 2, 'case-insensitive on the whole cell');
  assert.equal(occ.get('outbound'), 1);
  assert.equal(occ.get('ghost'), undefined);
});
