import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHslRoster, type HslRosterRow, type GmlRosterCandidate } from './roster-merge';

const hslRow = (overrides: Partial<HslRosterRow> = {}): HslRosterRow => ({
  email: 'sheet@simple.biz',
  full_name: 'Sheet Person',
  hsl_name: 'Sheety',
  role_raw: 'Case Manager',
  dept_key: 'case_managers',
  sub_team: null,
  is_manager: false,
  ...overrides,
});

const gmlPerson = (overrides: Partial<GmlRosterCandidate> = {}): GmlRosterCandidate => ({
  name: 'GML Person',
  department: 'Case Managers',
  work_email: 'gml@simple.biz',
  ...overrides,
});

test('a GML-only person with a resolvable branch name is included', () => {
  const merged = mergeHslRoster([], [gmlPerson()], null);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.email, 'gml@simple.biz');
  assert.equal(merged[0]!.dept_key, 'case_managers');
  assert.equal(merged[0]!.is_manager, false);
  assert.equal(merged[0]!.sub_team, null);
});

test('a GML person is excluded when deptFilter does not match their branch', () => {
  const merged = mergeHslRoster([], [gmlPerson({ department: 'Case Managers' })], 'attestation');
  assert.equal(merged.length, 0);
});

test('a GML person with no work_email is excluded even if department resolves', () => {
  const merged = mergeHslRoster([], [gmlPerson({ work_email: null })], null);
  assert.equal(merged.length, 0);
});

test('a GML person with an unresolvable department (generic "HSL") is excluded', () => {
  const merged = mergeHslRoster([], [gmlPerson({ department: 'HSL' })], null);
  assert.equal(merged.length, 0);
});

test('hsl_team_members wins on is_manager/sub_team/dept_key even when GML resolves a genuinely different branch', () => {
  // Regression: an earlier version of this test used 'SSD Medical Records' on
  // both sides, which coincidentally agree — it couldn't distinguish "hsl wins"
  // from "there was nothing to disagree about". Use different resolvable
  // departments on each side so a passing assertion actually proves precedence.
  const merged = mergeHslRoster(
    [hslRow({ email: 'both@simple.biz', is_manager: true, sub_team: 'BLUE' as never, dept_key: 'attestation' })],
    [gmlPerson({ work_email: 'both@simple.biz', department: 'Case Managers' })],
    null,
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.is_manager, true);
  assert.equal(merged[0]!.sub_team, 'BLUE');
  assert.equal(merged[0]!.dept_key, 'attestation');
});

test('a GML person tagged with a department name that collides with a pre-existing top-level department is rejected', () => {
  // "Callback Team" is BOTH HSL_DEPTS.callback_team.name AND normalize-dept-key.ts's
  // hand-curated map['callback team'] === 'callback' (an unrelated, real top-level
  // department). matchHslSubDeptKey alone would resolve this to the HSL branch;
  // the normalizeDeptToKey guard must reject it so real Callback-department
  // employees don't land on the HSL callback_team roster too.
  const merged = mergeHslRoster([], [gmlPerson({ department: 'Callback Team' })], null);
  assert.equal(merged.length, 0);
});

test('the namespaced hsl:callback_team form still resolves despite the plain-name collision', () => {
  // The namespaced form is a genuine, intentional grant written by Department
  // Transfers — normalizeDeptToKey's unconditional `hsl:` prefix check makes it
  // resolve to 'hogan_smith_law' regardless of the map, so the guard lets it
  // through even though the plain display name for the same branch is rejected.
  const merged = mergeHslRoster([], [gmlPerson({ department: 'hsl:callback_team' })], null);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.dept_key, 'callback_team');
});

test('an unclassified hsl_team_members row (dept_key null) keeps the GML-resolved dept_key', () => {
  const merged = mergeHslRoster(
    [hslRow({ email: 'both@simple.biz', dept_key: null })],
    [gmlPerson({ work_email: 'both@simple.biz', department: 'hsl:filing_specialist' })],
    null,
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.dept_key, 'filing_specialist');
});

test('email de-dup is case-insensitive', () => {
  const merged = mergeHslRoster(
    [hslRow({ email: 'foo@simple.biz' })],
    [gmlPerson({ work_email: 'FOO@SIMPLE.BIZ', department: 'Case Managers' })],
    null,
  );
  assert.equal(merged.length, 1);
});
