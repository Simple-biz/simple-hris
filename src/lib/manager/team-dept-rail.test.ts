import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTeamDeptRail,
  membersForRailKey,
  railKeyForDeptCell,
  flattenRail,
  slugifyRailKey,
} from './team-dept-rail';
import { RAIL_NO_DEPARTMENT_KEY, HSL_PARENT_KEY } from '@/lib/payment-catalog/dept-rail';

interface P {
  email: string;
  department: string;
}
const p = (email: string, department: string): P => ({ email, department });

/** The live department mix, measured 2026-09-14 against `active_employees`
 *  (1,320 active rows, 39 distinct departments, 16 of them `hsl:*`, 0 blank).
 *  Scaled down but shaped the same, so the ordering and folding assertions below
 *  are about production and not about a toy. */
const LIVE_MIX: P[] = [
  ...Array.from({ length: 5 }, (_, i) => p(`lg${i}@x.com`, 'Lead Gen')),
  ...Array.from({ length: 3 }, (_, i) => p(`is${i}@x.com`, 'hsl:intake_specialist')),
  ...Array.from({ length: 2 }, (_, i) => p(`fs${i}@x.com`, 'hsl:filing_specialist')),
  p('hsl@x.com', 'HSL'),
  ...Array.from({ length: 2 }, (_, i) => p(`cva${i}@x.com`, 'Client VA')),
  p('usee@x.com', 'USEE'),
  p('sb@x.com', 'Site Building (US - Freelance)'),
];

test('railKeyForDeptCell keeps a namespaced cell on its own sub-team', () => {
  // normalizeDeptToKey collapses this to hogan_smith_law; the rail exists to undo that.
  assert.equal(railKeyForDeptCell('hsl:intake_specialist'), 'hsl:intake_specialist');
  assert.equal(railKeyForDeptCell('HSL:Intake_Specialist'), 'hsl:intake_specialist');
});

test('railKeyForDeptCell folds label variants onto one payroll key', () => {
  assert.equal(railKeyForDeptCell('Accounting'), railKeyForDeptCell('Accounting Team'));
  assert.equal(railKeyForDeptCell('Lead Gen'), railKeyForDeptCell('Lead Generation'));
});

test('railKeyForDeptCell gives a no-payroll-key label its own entry', () => {
  // The catalog rail sweeps these into "No department" because it asks a payroll
  // question. A manager asking who is on my team must see USEE as USEE.
  assert.equal(railKeyForDeptCell('USEE'), 'usee');
  assert.equal(railKeyForDeptCell('Site Building (US - Freelance)'), 'site_building_us_freelance');
  assert.equal(railKeyForDeptCell('Orphan Ministry'), 'orphan_ministry');
});

test('railKeyForDeptCell returns null for a blank cell', () => {
  assert.equal(railKeyForDeptCell(''), null);
  assert.equal(railKeyForDeptCell('   '), null);
  assert.equal(railKeyForDeptCell(null), null);
  assert.equal(railKeyForDeptCell(undefined), null);
});

test('slugifyRailKey can never collide with the No-department sentinel', () => {
  assert.ok(!slugifyRailKey('@no_department').includes('@'));
  assert.notEqual(slugifyRailKey('No department'), RAIL_NO_DEPARTMENT_KEY);
});

test('the rail never loses anyone — bucket sizes sum to the roster', () => {
  const { byKey } = buildTeamDeptRail(LIVE_MIX);
  const total = [...byKey.values()].reduce((n, v) => n + v.length, 0);
  assert.equal(total, LIVE_MIX.length);
});

test('a blank cell lands in No department rather than vanishing', () => {
  const roster = [...LIVE_MIX, p('blank@x.com', ''), p('spaces@x.com', '   ')];
  const { rail, byKey, counts } = buildTeamDeptRail(roster);
  assert.equal(byKey.get(RAIL_NO_DEPARTMENT_KEY)?.length, 2);
  const sentinel = rail.find((g) => g.parent.key === RAIL_NO_DEPARTMENT_KEY);
  assert.ok(sentinel, 'the sentinel must render once it holds people');
  assert.equal(counts.get(RAIL_NO_DEPARTMENT_KEY), 2);
  // …and it is pinned last, whatever its size.
  assert.equal(rail[rail.length - 1]?.parent.key, RAIL_NO_DEPARTMENT_KEY);
});

test('No department is hidden while it is empty', () => {
  const { rail } = buildTeamDeptRail(LIVE_MIX);
  assert.ok(!rail.some((g) => g.parent.key === RAIL_NO_DEPARTMENT_KEY));
});

test('HSL folds into one parent that discloses its sub-teams', () => {
  const { rail } = buildTeamDeptRail(LIVE_MIX);
  const hsl = rail.find((g) => g.parent.key === HSL_PARENT_KEY);
  assert.ok(hsl, 'the HSL family must be one rail entry, not 16 siblings');
  assert.deepEqual(
    hsl.children.map((c) => c.key).sort(),
    ['hsl:filing_specialist', 'hsl:intake_specialist'],
  );
});

test('the HSL parent survives the last bare-HSL person leaving', () => {
  // Live today: exactly ONE person carries the bare "HSL" label. If the parent
  // entry depended on them, their departure would promote all 16 sub-teams to
  // top level — the flat shape Kane asked us to fold away on 2026-08-21.
  const noBare = LIVE_MIX.filter((m) => m.department !== 'HSL');
  const { rail } = buildTeamDeptRail(noBare);
  const hsl = rail.find((g) => g.parent.key === HSL_PARENT_KEY);
  assert.ok(hsl, 'the parent must be synthesised, not inherited from a person');
  assert.equal(hsl.children.length, 2);
  assert.ok(!rail.some((g) => g.parent.key === 'hsl:intake_specialist'));
});

test('the number on the rail equals the length of the list below it', () => {
  // The whole point of membersForRailKey: a parent reading 6 must not hand the
  // manager the 1 person left on the bare parent label.
  const { rail, byKey, counts } = buildTeamDeptRail(LIVE_MIX);
  for (const entry of flattenRail(rail)) {
    assert.equal(
      membersForRailKey(entry.key, rail, byKey).length,
      counts.get(entry.key) ?? 0,
      `rail count and member list disagree for ${entry.key}`,
    );
  }
});

test('selecting the HSL parent shows the whole family', () => {
  const { rail, byKey } = buildTeamDeptRail(LIVE_MIX);
  const family = membersForRailKey(HSL_PARENT_KEY, rail, byKey);
  assert.equal(family.length, 6); // 3 intake + 2 filing + 1 bare
  // …while a sub-team shows only its own, never the parent's leftovers.
  assert.equal(membersForRailKey('hsl:intake_specialist', rail, byKey).length, 3);
});

test('entries are ordered by rolled-up headcount, so HSL outranks its leftovers', () => {
  const { rail, defaultKey } = buildTeamDeptRail(LIVE_MIX);
  // HSL has 6 people across the family but only 1 on the bare parent label.
  // Sorting on its own count would bury it below Client VA (2).
  const order = rail.map((g) => g.parent.key);
  assert.equal(order[0], HSL_PARENT_KEY);
  assert.equal(order[1], 'lead_gen');
  assert.equal(defaultKey, HSL_PARENT_KEY, 'the default selection is the largest department');
});

test('a granted department with nobody in it still gets a tab', () => {
  // How a mis-scoped grant becomes visible instead of silently showing nothing.
  const { rail, counts } = buildTeamDeptRail(LIVE_MIX, ['Discovery']);
  const discovery = rail.find((g) => g.parent.key === 'discovery');
  assert.ok(discovery, 'an empty grant must not disappear off the rail');
  assert.equal(counts.get('discovery'), 0);
});

test('a granted department does not inflate a headcount', () => {
  const withGrant = buildTeamDeptRail(LIVE_MIX, ['Lead Gen']);
  const without = buildTeamDeptRail(LIVE_MIX);
  assert.equal(withGrant.counts.get('lead_gen'), without.counts.get('lead_gen'));
});

test('an empty roster produces an empty rail rather than throwing', () => {
  const { rail, defaultKey, byKey } = buildTeamDeptRail([]);
  assert.deepEqual(rail, []);
  assert.equal(defaultKey, '');
  assert.equal(membersForRailKey('anything', rail, byKey).length, 0);
});

test('flattenRail lists parents before their own children, in display order', () => {
  const { rail } = buildTeamDeptRail(LIVE_MIX);
  const flat = flattenRail(rail).map((e) => e.key);
  const parentAt = flat.indexOf(HSL_PARENT_KEY);
  assert.ok(parentAt >= 0);
  assert.ok(flat.indexOf('hsl:intake_specialist') > parentAt);
});
