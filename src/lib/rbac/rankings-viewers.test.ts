import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { TEAM_RANKINGS_VIEWERS, canViewTeamRankings } from './rankings-viewers';

/* Kane, 2026-08-29: the employee "My Team → Rankings" tab is hidden from everyone
 * except kaner@simple.biz — every department, and NOT bypassable by an elevated
 * role. These tests pin the four ways that could quietly stop being true. */

describe('team rankings — who may see them', () => {
  it('admits the one allow-listed reader', () => {
    assert.equal(canViewTeamRankings('kaner@simple.biz'), true);
  });

  it('normalizes case and surrounding whitespace, so a session email still matches', () => {
    assert.equal(canViewTeamRankings('  Kaner@Simple.Biz  '), true);
    assert.equal(canViewTeamRankings('KANER@SIMPLE.BIZ'), true);
  });

  it('refuses every other colleague, including the rest of the AI/API Team', () => {
    for (const email of ['benedict@simple.biz', 'karl@simple.biz', 'abby@simple.biz', 'carla@simple.biz']) {
      assert.equal(canViewTeamRankings(email), false, `${email} must not see rankings`);
    }
  });

  it('fails closed on an absent address', () => {
    assert.equal(canViewTeamRankings(null), false);
    assert.equal(canViewTeamRankings(undefined), false);
    assert.equal(canViewTeamRankings(''), false);
    assert.equal(canViewTeamRankings('   '), false);
  });

  it('matches the whole address, never a substring — a lookalike domain is not Kane', () => {
    for (const email of [
      'kaner@simple.biz.attacker.test',
      'xkaner@simple.biz',
      'kaner@simple.bizz',
      'kaner@notsimple.biz',
    ]) {
      assert.equal(canViewTeamRankings(email), false, `${email} must not match`);
    }
  });

  it('is a one-name list — widening it is a deliberate edit, not a side effect', () => {
    assert.deepEqual([...TEAM_RANKINGS_VIEWERS].sort(), ['kaner@simple.biz']);
  });
});

/* The gate is only worth anything if the ROUTE consults it before it consults
 * anything else. `hasElevatedRole` is the specific thing it has to beat: admin,
 * payroll, finance, hr and viewer sessions skip the department scoping entirely,
 * so a gate placed after them would leak every department to exactly the people
 * this change is meant to exclude. */
describe('team rankings — the route applies the gate first', () => {
  const routeSrc = readFileSync(
    path.join(__dirname, '..', '..', '..', 'app', 'api', 'team-rankings', 'route.ts'),
    'utf8',
  );
  const body = routeSrc.slice(routeSrc.indexOf('export async function GET'));

  it('calls canViewTeamRankings inside the handler', () => {
    assert.ok(
      body.includes('canViewTeamRankings(sessionEmail)'),
      'GET must gate on the session email, not on a ?email= subject',
    );
  });

  it('runs the gate before the elevated-role bypass and before any query', () => {
    const gate = body.indexOf('canViewTeamRankings(');
    const elevated = body.indexOf('hasElevatedRole(');
    const query = body.indexOf('getTeamRankings(');
    assert.ok(gate > -1 && elevated > -1 && query > -1, 'all three call sites must be present');
    assert.ok(gate < elevated, 'an elevated role must not reach rankings ahead of the gate');
    assert.ok(gate < query, 'a denied caller must cost no database query');
  });

  it('denies rather than admits — the guard stays negated', () => {
    assert.match(
      body,
      /if \(!canViewTeamRankings\(sessionEmail\)\) \{\s*return NextResponse\.json\(\{ weeks: \[\], error: null \}\);/,
      'denial must return the empty-week shape so the tab drops its pill instead of erroring',
    );
  });
});
