import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parentOfDeptKey,
  buildDeptRail,
  deptCellMatchesEntry,
  assignRosterToRail,
  rollUpCounts,
  bucketSizes,
  RAIL_NO_DEPARTMENT_KEY,
  HSL_PARENT_KEY,
  homeKeyForStructure,
  type DeptRailEntry,
  type RailRosterPerson,
} from './dept-rail';
import type { PayStructure } from './pay-structure';

/** A rail shaped like the real one: built-ins, the 3 HSL subs we need, a custom
 *  parent with a sub, and a plain custom department. */
const RAIL: DeptRailEntry[] = [
  { key: 'lead_gen', name: 'Lead Gen' },
  { key: HSL_PARENT_KEY, name: 'Hogan Smith Law' },
  { key: 'edit', name: 'Edit Team' },
  { key: 'hsl:intake_specialist', name: 'HSL — Intake Specialist' },
  { key: 'hsl:case_managers', name: 'HSL — Case Managers' },
  { key: 'hsl:simple_texting', name: 'HSL — Simple Texting' },
  { key: 'executive_assistants', name: 'Executive Assistants' },
  { key: 'executive_assistants:ceo', name: 'Executive Assistants — CEO' },
];

const person = (email: string, department: string): RailRosterPerson => ({ email, department });

// ── parentOfDeptKey — the two opposite conventions ───────────────────────────

test('an hsl:* child maps to hogan_smith_law — the PREFIX IS NOT THE PARENT KEY', () => {
  assert.equal(parentOfDeptKey('hsl:intake_specialist'), HSL_PARENT_KEY);
  assert.equal(parentOfDeptKey('hsl:case_managers'), HSL_PARENT_KEY);
  // A split-on-colon would have produced "hsl", which is not a rail key at all.
  assert.notEqual(parentOfDeptKey('hsl:intake_specialist'), 'hsl');
});

test('an unknown or retired hsl:* key still nests under the parent', () => {
  assert.equal(parentOfDeptKey('hsl:lead_nurture'), HSL_PARENT_KEY);
  assert.equal(parentOfDeptKey('hsl:typo_team'), HSL_PARENT_KEY);
  assert.equal(parentOfDeptKey('HSL:Intake_Specialist'), HSL_PARENT_KEY);
});

test('a custom registry child maps to its prefix — there the prefix IS the parent', () => {
  const parents = new Set(['executive_assistants']);
  assert.equal(parentOfDeptKey('executive_assistants:ceo', parents), 'executive_assistants');
});

test('a custom child whose parent is absent is not nested', () => {
  assert.equal(parentOfDeptKey('ghost_dept:sub', new Set()), null);
});

test('top-level keys have no parent', () => {
  assert.equal(parentOfDeptKey('lead_gen'), null);
  assert.equal(parentOfDeptKey(HSL_PARENT_KEY), null);
  assert.equal(parentOfDeptKey(''), null);
  assert.equal(parentOfDeptKey(':leading'), null);
});

// ── buildDeptRail ───────────────────────────────────────────────────────────

test('the rail nests HSL subs under Hogan Smith Law and keeps parent order', () => {
  const rail = buildDeptRail(RAIL);
  assert.deepEqual(rail.map((g) => g.parent.key), [
    'lead_gen', HSL_PARENT_KEY, 'edit', 'executive_assistants',
  ]);
  const hsl = rail.find((g) => g.parent.key === HSL_PARENT_KEY)!;
  assert.deepEqual(hsl.children.map((c) => c.key), [
    'hsl:intake_specialist', 'hsl:case_managers', 'hsl:simple_texting',
  ]);
  const ea = rail.find((g) => g.parent.key === 'executive_assistants')!;
  assert.deepEqual(ea.children.map((c) => c.key), ['executive_assistants:ceo']);
});

test('every entry appears exactly once across the whole tree', () => {
  const rail = buildDeptRail(RAIL);
  const seen = rail.flatMap((g) => [g.parent.key, ...g.children.map((c) => c.key)]);
  assert.equal(seen.length, RAIL.length);
  assert.equal(new Set(seen).size, RAIL.length);
});

test('an orphan child is PROMOTED, never dropped', () => {
  // No hogan_smith_law entry in this rail at all.
  const rail = buildDeptRail([
    { key: 'lead_gen', name: 'Lead Gen' },
    { key: 'hsl:collections', name: 'HSL — Collections' },
  ]);
  assert.deepEqual(rail.map((g) => g.parent.key), ['lead_gen', 'hsl:collections']);
});

// ── deptCellMatchesEntry — deliberately loose ───────────────────────────────

test('a cell matches by alias map, raw key, or display name', () => {
  assert.ok(deptCellMatchesEntry('Lead Gen', { key: 'lead_gen', name: 'Lead Gen' }));
  assert.ok(deptCellMatchesEntry('hsl:case_managers', { key: 'hsl:case_managers', name: 'HSL — Case Managers' }));
  assert.ok(deptCellMatchesEntry('Executive Assistants', { key: 'executive_assistants', name: 'Executive Assistants' }));
  assert.ok(!deptCellMatchesEntry('', { key: 'lead_gen', name: 'Lead Gen' }));
});

test('a sub-team cell ALSO matches the parent entry — the trap assignRosterToRail closes', () => {
  // normalizeDeptToKey('hsl:case_managers') === 'hogan_smith_law', so the loose
  // matcher says yes to the parent too. This is why membership needs a resolver.
  assert.ok(deptCellMatchesEntry('hsl:case_managers', { key: HSL_PARENT_KEY, name: 'Hogan Smith Law' }));
});

// ── assignRosterToRail — one person, one home ──────────────────────────────

test('a sub-team person lands under the sub-team and NOT under the parent', () => {
  const rail = buildDeptRail(RAIL);
  const roster = [person('joy@hogansmith.com', 'hsl:case_managers')];
  const byKey = assignRosterToRail(roster, rail);
  assert.deepEqual(byKey.get('hsl:case_managers')?.map((p) => p.email), ['joy@hogansmith.com']);
  assert.equal(byKey.get(HSL_PARENT_KEY), undefined, 'the parent must not claim her');
});

test('bare HSL falls to the PARENT, not to No department', () => {
  const rail = buildDeptRail(RAIL);
  const byKey = assignRosterToRail([person('a@x.com', 'HSL'), person('b@x.com', 'Hogan Smith Law')], rail);
  assert.deepEqual(byKey.get(HSL_PARENT_KEY)?.map((p) => p.email).sort(), ['a@x.com', 'b@x.com']);
  assert.equal(byKey.get(RAIL_NO_DEPARTMENT_KEY), undefined);
});

test('a RETIRED or mistyped hsl:<key> is UNPLACED, not silently parked on the parent', () => {
  const rail = buildDeptRail(RAIL);
  // hsl:collections is a real sub-team but absent from THIS rail; hsl:typo_team is
  // not a sub-team at all. Neither should inherit the parent's collapse: the point
  // of the list is that these people have no home.
  const byKey = assignRosterToRail(
    [person('r@x.com', 'hsl:collections'), person('t@x.com', 'hsl:typo_team')],
    rail,
  );
  assert.deepEqual(byKey.get(RAIL_NO_DEPARTMENT_KEY)?.map((p) => p.email).sort(), ['r@x.com']);
  // hsl:typo_team is NOT a known sub-team label, so it takes the parent's collapse.
  assert.deepEqual(byKey.get(HSL_PARENT_KEY)?.map((p) => p.email), ['t@x.com']);
});

test('an unresolvable label reaches the No department bucket', () => {
  const rail = buildDeptRail(RAIL);
  const byKey = assignRosterToRail(
    [person('u@x.com', 'USEE'), person('s@x.com', 'Site Building (US - Freelance)'), person('n@x.com', '')],
    rail,
  );
  assert.deepEqual(
    byKey.get(RAIL_NO_DEPARTMENT_KEY)?.map((p) => p.email).sort(),
    ['n@x.com', 's@x.com', 'u@x.com'],
  );
});

test('NOBODY is lost — the buckets always sum to the roster', () => {
  const rail = buildDeptRail(RAIL);
  const roster = [
    person('1@x.com', 'hsl:intake_specialist'),
    person('2@x.com', 'hsl:case_managers'),
    person('3@x.com', 'HSL'),
    person('4@x.com', 'Lead Gen'),
    person('5@x.com', 'USEE'),
    person('6@x.com', 'Executive Assistants'),
    person('7@x.com', 'executive_assistants:ceo'),
    person('8@x.com', ''),
    person('9@x.com', 'hsl:typo_team'),
  ];
  const byKey = assignRosterToRail(roster, rail);
  const total = [...byKey.values()].reduce((n, arr) => n + arr.length, 0);
  assert.equal(total, roster.length);
});

test('a custom sub-department person lands on the sub, not the custom parent', () => {
  const rail = buildDeptRail(RAIL);
  const byKey = assignRosterToRail([person('c@x.com', 'executive_assistants:ceo')], rail);
  assert.deepEqual(byKey.get('executive_assistants:ceo')?.map((p) => p.email), ['c@x.com']);
  assert.equal(byKey.get('executive_assistants'), undefined);
});

// ── rollUpCounts ───────────────────────────────────────────────────────────

test('a parent count includes its children, children keep their own', () => {
  const rail = buildDeptRail(RAIL);
  const own = new Map([
    [HSL_PARENT_KEY, 2],
    ['hsl:intake_specialist', 186],
    ['hsl:case_managers', 55],
    ['lead_gen', 300],
  ]);
  const rolled = rollUpCounts(own, rail);
  assert.equal(rolled.get(HSL_PARENT_KEY), 2 + 186 + 55, 'collapsed parent must not read 2');
  assert.equal(rolled.get('hsl:intake_specialist'), 186);
  assert.equal(rolled.get('lead_gen'), 300);
  assert.equal(rolled.get('hsl:simple_texting'), 0);
});

test('bucketSizes feeds rollUpCounts', () => {
  const rail = buildDeptRail(RAIL);
  const byKey = assignRosterToRail(
    [person('1@x.com', 'hsl:intake_specialist'), person('2@x.com', 'hsl:intake_specialist'), person('3@x.com', 'HSL')],
    rail,
  );
  const rolled = rollUpCounts(bucketSizes(byKey), rail);
  assert.equal(rolled.get('hsl:intake_specialist'), 2);
  assert.equal(rolled.get(HSL_PARENT_KEY), 3);
});

// ── homeKeyForStructure — the Baldonebro fix ────────────────────────────────

const RAIL_KEYS = new Set(RAIL.map((e) => e.key));

const struct = (email: string, departmentKey: string): PayStructure => ({
  id: `id_${email}`,
  scope: 'employee',
  departmentKey,
  employeeEmail: email,
  employeeName: email,
  regularRate: 305,
  otRate: 457.5,
  currency: 'PHP',
});

test('a structure filed on the PARENT re-homes to the owner sub-team (Baldonebro)', () => {
  // Her live master row is joy@hogansmith.com / hsl:case_managers; the row Kane saw
  // is filed under hogan_smith_law because normalizeDeptToKey collapses her cell.
  const placement = new Map([['joy@hogansmith.com', 'hsl:case_managers']]);
  assert.equal(
    homeKeyForStructure(struct('joy@hogansmith.com', HSL_PARENT_KEY), placement, RAIL_KEYS),
    'hsl:case_managers',
  );
});

test('a structure whose owner is OFF the roster keeps its stored key — never vanishes', () => {
  // joyb@simple.biz is her stale duplicate identity: no live row at all. 50 of the
  // 124 rows on the parent are like this.
  assert.equal(
    homeKeyForStructure(struct('joyb@simple.biz', HSL_PARENT_KEY), new Map(), RAIL_KEYS),
    HSL_PARENT_KEY,
  );
});

test('someone transferred OUT of HSL re-homes to their new department', () => {
  const placement = new Map([['x@simple.biz', 'Lead Gen']]);
  assert.equal(homeKeyForStructure(struct('x@simple.biz', HSL_PARENT_KEY), placement, RAIL_KEYS), 'lead_gen');
});

test('a placement the rail cannot render keeps the stored key', () => {
  // USEE resolves to no rail entry; the row must still show somewhere.
  const placement = new Map([['u@simple.biz', 'USEE']]);
  assert.equal(homeKeyForStructure(struct('u@simple.biz', 'us_manager_bonus'), placement, RAIL_KEYS), 'us_manager_bonus');
});

test('a bare-HSL placement re-homes to the parent', () => {
  const placement = new Map([['b@simple.biz', 'HSL']]);
  assert.equal(homeKeyForStructure(struct('b@simple.biz', 'lead_gen'), placement, RAIL_KEYS), HSL_PARENT_KEY);
});

test('a namespaced cell wins over the alias-map collapse, casing included', () => {
  const placement = new Map([['c@simple.biz', 'HSL:Case_Managers']]);
  assert.equal(
    homeKeyForStructure(struct('c@simple.biz', HSL_PARENT_KEY), placement, RAIL_KEYS),
    'hsl:case_managers',
  );
});

test('a blank email falls back to the stored key', () => {
  const s0: PayStructure = { ...struct('x@x.com', 'lead_gen'), employeeEmail: undefined };
  assert.equal(homeKeyForStructure(s0, new Map(), RAIL_KEYS), 'lead_gen');
  const s1: PayStructure = { ...struct('x@x.com', 'lead_gen'), employeeEmail: '  ' };
  assert.equal(homeKeyForStructure(s1, new Map(), RAIL_KEYS), 'lead_gen');
});
