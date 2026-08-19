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

// The fixture uses the CANONICAL placement form `hsl:<key>` (hsl-subdepartments.md
// §1) — which is also what all live HSL people actually carry. A plain branch
// display name is deliberately NOT a placement and is rejected by the guard; see
// the "a plain HSL branch display name is rejected" test below. Do not switch this
// fixture back to a plain name: several tests here would keep passing while
// silently exercising nothing (an asserted 0 becomes 0 for the wrong reason).
const gmlPerson = (overrides: Partial<GmlRosterCandidate> = {}): GmlRosterCandidate => ({
  name: 'GML Person',
  department: 'hsl:case_managers',
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
  const merged = mergeHslRoster([], [gmlPerson({ department: 'hsl:case_managers' })], 'attestation');
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
    [gmlPerson({ work_email: 'both@simple.biz', department: 'hsl:case_managers' })],
    null,
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.is_manager, true);
  assert.equal(merged[0]!.sub_team, 'BLUE');
  assert.equal(merged[0]!.dept_key, 'attestation');
});

test('a plain HSL branch display name is rejected — membership is never inferred from a bare label', () => {
  // Kane's ruling, 2026-08-19: normalizeDeptToKey IS the HSL family key (week model,
  // +P15/h weekend premium, dept-scoped bonus matching), so it does NOT recognize
  // plain sub-team display names — which makes this guard reject them all, not just
  // the map-colliding ones. Measured live the same day: "Executive Assistants" x3
  // (cjm@, jamec@, ellyt@) are NOT HSL people, and would have been merged onto the
  // executive_assistants roster had the plain-name form been trusted here.
  assert.equal(mergeHslRoster([], [gmlPerson({ department: 'Executive Assistants' })], null).length, 0);
  assert.equal(mergeHslRoster([], [gmlPerson({ department: 'Case Managers' })], null).length, 0);
  assert.equal(mergeHslRoster([], [gmlPerson({ department: 'SSD Medical Records' })], null).length, 0);
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

test('a dept-filtered request includes an unclassified hsl_team_members row that GML resolves, with sheet metadata intact (Finding 2 fix)', () => {
  // Previously, the route's SQL query pre-filtered hsl_team_members via
  // `.eq('dept_key', dept)`, which never returns a `dept_key: null` row for a
  // dept-scoped request — so mergeHslRoster never even saw this row, and the
  // person appeared (if at all) only via the GML-synthesized default (losing
  // is_manager/sub_team/hsl_name/role_raw from the sheet). Now that the route
  // always passes the full hsl_team_members table, and filtering happens here
  // AFTER the dept_key-null-fallback merge, this row must be included with
  // its real sheet metadata.
  const merged = mergeHslRoster(
    [hslRow({
      email: 'both@simple.biz',
      dept_key: null,
      is_manager: true,
      sub_team: 'GREEN' as never,
      hsl_name: 'Sheety Name',
      role_raw: 'Filer',
    })],
    [gmlPerson({ work_email: 'both@simple.biz', department: 'hsl:filing_specialist' })],
    'filing_specialist',
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.dept_key, 'filing_specialist');
  assert.equal(merged[0]!.is_manager, true);
  assert.equal(merged[0]!.sub_team, 'GREEN');
  assert.equal(merged[0]!.hsl_name, 'Sheety Name');
  assert.equal(merged[0]!.role_raw, 'Filer');
});

test('an hsl_team_members-only row not matching deptFilter is excluded under post-merge filtering', () => {
  // With the route no longer pre-scoping hsl_team_members by dept via SQL,
  // mergeHslRoster itself is now the only thing standing between a dept-scoped
  // request and getting every department's sheet rows back. This confirms an
  // hsl-sourced row (no GML involvement at all) with a non-matching dept_key
  // is still correctly excluded.
  const merged = mergeHslRoster(
    [hslRow({ email: 'sheet@simple.biz', dept_key: 'case_managers' })],
    [],
    'attestation',
  );
  assert.equal(merged.length, 0);
});

test('email de-dup is case-insensitive', () => {
  const merged = mergeHslRoster(
    [hslRow({ email: 'foo@simple.biz' })],
    [gmlPerson({ work_email: 'FOO@SIMPLE.BIZ', department: 'hsl:case_managers' })],
    null,
  );
  assert.equal(merged.length, 1);
});
