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
  builtinSubOptionsWithPinned,
  isBuiltinSubTeamKey,
  pinnedSubDepartments,
  diffBuiltinSubs,
  placeableSubIndex,
  supportsDataSubDepartments,
  validateBuiltinSubsInput,
  type BuiltinSubMap,
} from './builtin-subs';
import { isPlaceableDeptLabel, formatDeptLabel } from './hsl-subdept';
import { validateBuiltinPeopleInput } from './registry';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

const MAP: BuiltinSubMap = {
  lead_gen: [
    { key: 'nurture', name: 'Nurture' },
    { key: 'outbound', name: 'Outbound' },
  ],
};

test('every built-in can carry DATA sub-departments, HSL included; registry keys cannot', () => {
  assert.equal(supportsDataSubDepartments('lead_gen'), true);
  assert.equal(supportsDataSubDepartments('qc'), true);
  // Changed 2026-09-21 (Kane: "LET US REFACTOR this for HSL if needed").
  assert.equal(supportsDataSubDepartments('hogan_smith_law'), true);
  assert.equal(supportsDataSubDepartments('executive_assistants'), false, 'registry keys are not built-ins');
});

test('HSL: the 16 code teams are PINNED, and a data team cannot shadow or resurrect one', () => {
  const pinned = pinnedSubDepartments('hogan_smith_law');
  assert.equal(pinned.length, 16, '14 KPI teams + 2 placement-only');
  assert.ok(pinned.some((p) => p.key === 'intake_specialist'));
  assert.ok(pinned.some((p) => p.key === 'simple_texting'));
  assert.deepEqual(pinnedSubDepartments('lead_gen'), [], 'only HSL has code teams');

  // Shadowing a code team would silently redirect its cells and rate row.
  assert.match(
    validateBuiltinSubsInput({
      builtinKey: 'hogan_smith_law',
      subDepartments: [{ key: 'intake_specialist', name: 'Intake' }],
    }).error ?? '',
    /defined in code/,
  );
  // lead_nurture was retired 2026-08-13; it must not come back through data.
  assert.match(
    validateBuiltinSubsInput({
      builtinKey: 'hogan_smith_law',
      subDepartments: [{ key: 'lead_nurture', name: 'Lead Nurture' }],
    }).error ?? '',
    /retired/,
  );
  // A genuinely new team is fine.
  assert.deepEqual(
    validateBuiltinSubsInput({
      builtinKey: 'hogan_smith_law',
      subDepartments: [{ key: 'spanish_intake', name: 'Spanish Intake' }],
    }),
    { ok: true },
  );
});

test('HSL: a data team is labelled hsl:<sub> so it STAYS in the HSL family', () => {
  // The whole point of the exception: hogan_smith_law:<sub> would drop the
  // person out of the Mon-Sun week model and the weekend premium.
  assert.equal(builtinSubLabel('hogan_smith_law', 'spanish_intake'), 'hsl:spanish_intake');
  assert.equal(normalizeDeptToKey('hsl:spanish_intake'), 'hogan_smith_law');
  assert.deepEqual(builtinSubOptions({ hogan_smith_law: [{ key: 'spanish_intake', name: 'Spanish Intake' }] }, 'hogan_smith_law'), [
    { value: 'hsl:spanish_intake', label: 'HSL — Spanish Intake' },
  ]);
  // Code teams first, then data, in the combined picker list.
  const all = builtinSubOptionsWithPinned({ hogan_smith_law: [{ key: 'spanish_intake', name: 'Spanish Intake' }] }, 'hogan_smith_law');
  assert.equal(all.length, 17);
  assert.equal(all[0]!.value, 'hsl:ssd_medical_records');
  assert.equal(all[16]!.value, 'hsl:spanish_intake');
  // Occupancy reads the hsl: prefix, not hogan_smith_law:.
  const occ = builtinSubOccupancy('hogan_smith_law', ['hsl:spanish_intake', 'HSL:Spanish_Intake', 'hsl:intake_specialist']);
  assert.equal(occ.get('spanish_intake'), 2);
});

test('HSL: a data team is PLACEABLE only when the map says it exists', () => {
  const withData = placeableSubIndex({ hogan_smith_law: [{ key: 'spanish_intake', name: 'Spanish Intake' }] });
  assert.equal(isPlaceableDeptLabel('hsl:spanish_intake', withData), true);
  assert.equal(isPlaceableDeptLabel('hsl:spanish_intake'), false, 'unknown to code and no map -> not a placement');
  assert.equal(isPlaceableDeptLabel('hsl:spanish_intake', placeableSubIndex({})), false);
  // Code teams and the bare label are unchanged either way.
  assert.equal(isPlaceableDeptLabel('hsl:intake_specialist', withData), true);
  assert.equal(isPlaceableDeptLabel('HSL', withData), false);
  assert.equal(formatDeptLabel('hsl:spanish_intake'), 'HSL — Spanish Intake');
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

test('a sub added and STAFFED in the same save works — subs are written first', () => {
  // The exact composition the route and the dialog both use: validate the move
  // against the map as it will be AFTER this save, not as it is stored now.
  const stored: BuiltinSubMap = {};
  const pending = [{ key: 'nurture', name: 'Nurture' }];
  const prospective = placeableSubIndex({ ...stored, lead_gen: pending });

  const move = {
    name: 'Someone',
    workEmail: 's@simple.biz',
    personalEmail: null,
    fromDepartment: 'QC',
    toDepartment: 'lead_gen:nurture',
  };

  // Against the STORED map the destination does not exist yet.
  assert.equal(
    validateBuiltinPeopleInput({ builtinKey: 'lead_gen', moves: [move] }, placeableSubIndex(stored)).ok,
    false,
    'a sub that has not been saved yet is not a destination',
  );
  // Against the PROSPECTIVE map it does — which is why the route writes subs
  // before it moves anybody.
  assert.deepEqual(
    validateBuiltinPeopleInput({ builtinKey: 'lead_gen', moves: [move] }, prospective),
    { ok: true },
  );
});

test('once a department has sub-teams, a bare placement into it is refused', () => {
  const prospective = placeableSubIndex(MAP);
  const bare = {
    name: 'Someone',
    workEmail: 's@simple.biz',
    personalEmail: null,
    fromDepartment: 'QC',
    toDepartment: 'Lead Gen',
  };
  const res = validateBuiltinPeopleInput({ builtinKey: 'lead_gen', moves: [bare] }, prospective);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /not a placement/);

  // ...and with no sub-teams, the same move is fine — existing flat departments
  // are completely unaffected by this feature.
  assert.deepEqual(
    validateBuiltinPeopleInput({ builtinKey: 'lead_gen', moves: [bare] }, placeableSubIndex({})),
    { ok: true },
  );
});

test('built-in sub-team keys are kept OFF the bonus target pickers', () => {
  // The calculator collapses an assignment key to its parent, so offering a
  // sub-team as a target offers a lie (bonus-catalog.md "Bare vs namespaced").
  assert.equal(isBuiltinSubTeamKey('lead_gen:nurture'), true);
  assert.equal(isBuiltinSubTeamKey('hsl:spanish_intake'), true);
  assert.equal(isBuiltinSubTeamKey('hsl:intake_specialist'), true, 'code HSL teams too -- same collapse');
  // Departments themselves and in-app registry entries are NOT filtered: they
  // were offered before 2026-09-21 and this fix must not narrow that.
  assert.equal(isBuiltinSubTeamKey('lead_gen'), false);
  assert.equal(isBuiltinSubTeamKey('Lead Gen'), false);
  assert.equal(isBuiltinSubTeamKey('executive_assistants'), false);
  assert.equal(isBuiltinSubTeamKey('executive_assistants:nurture'), false, 'registry sub: unknown prefix, untouched');
  assert.equal(isBuiltinSubTeamKey(''), false);
});
