import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  TEAM_RANKINGS_VIEWERS,
  canViewTeamRankings,
  managerMayReadRankings,
  parseRankingsView,
} from './rankings-viewers';

/* Kane, 2026-08-29: the employee "My Team → Rankings" tab is hidden from everyone
 * except kaner@simple.biz — every department, and NOT bypassable by an elevated
 * role. These tests pin the four ways that could quietly stop being true.
 *
 * Kane, 2026-09-26, resolution (b): Manager → My Team gains a second door — a
 * department's own managers read its rankings THERE, and only there. The allow-list
 * is untouched ("do not change it for kaner"); the later blocks pin the new door's
 * edges. */

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

describe('team rankings — which surface is asking', () => {
  it('only the exact string "manager" selects the manager surface', () => {
    assert.equal(parseRankingsView('manager'), 'manager');
  });

  it('everything else is the employee surface, so a typo can only narrow', () => {
    for (const raw of [null, undefined, '', ' ', 'Manager', 'MANAGER', 'manager ', ' manager', 'managers', 'employee', 'admin']) {
      assert.equal(parseRankingsView(raw), 'employee', `${JSON.stringify(raw)} must not open the manager door`);
    }
  });
});

/* The live shape, measured 2026-09-26: 9 grants on "AI/API Team". */
describe('team rankings — the manager door (Kane, 2026-09-26)', () => {
  const aiApi = ['AI/API Team'];

  it('admits a manager on the manager surface for a department they are granted', () => {
    assert.equal(managerMayReadRankings('manager', 'AI/API Team', aiApi), true);
  });

  it('matches the label trimmed and case-insensitive, like the route always has', () => {
    assert.equal(managerMayReadRankings('manager', '  ai/api team ', aiApi), true);
    assert.equal(managerMayReadRankings('manager', 'AI/API Team', ['  AI/API TEAM  ']), true);
  });

  it('refuses the SAME manager on the employee surface — the ranking is not on the Employee Dashboard', () => {
    assert.equal(managerMayReadRankings('employee', 'AI/API Team', aiApi), false);
  });

  it('refuses a department the manager is not granted, even with other grants', () => {
    assert.equal(managerMayReadRankings('manager', 'AI/API Team', ['QC', 'Lead Gen', 'hsl:intake_specialist']), false);
  });

  it('is an exact label, never a payroll-key match — a differently spelled grant fails closed', () => {
    // normalizeDeptToKey maps all three to `devs`; this door does not.
    assert.equal(managerMayReadRankings('manager', 'AI/API Team', ['devs']), false);
    assert.equal(managerMayReadRankings('manager', 'AI/API Team', ['AI/Automation']), false);
    assert.equal(managerMayReadRankings('manager', 'AI/API', aiApi), false);
  });

  it('fails closed with no grants, a blank department, or blank grant cells', () => {
    assert.equal(managerMayReadRankings('manager', 'AI/API Team', []), false);
    assert.equal(managerMayReadRankings('manager', '', aiApi), false);
    assert.equal(managerMayReadRankings('manager', '   ', aiApi), false);
    assert.equal(managerMayReadRankings('manager', null, aiApi), false);
    assert.equal(managerMayReadRankings('manager', undefined, aiApi), false);
    assert.equal(managerMayReadRankings('manager', '', ['', '  ', null, undefined]), false);
  });

  it('takes no role argument at all — an elevated session with no grant has no way in', () => {
    assert.equal(managerMayReadRankings.length, 3);
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

  /* 2026-09-26: the negated block no longer returns empty unconditionally — it now
   * holds the manager door. What it must still guarantee is pinned instead: the
   * employee view is refused FIRST and costs no query, the only admission is
   * `managerMayReadRankings`, and nothing in the block consults a role. */
  const open = 'if (!canViewTeamRankings(sessionEmail)) {';
  const blockStart = body.indexOf(open);
  const blockEnd = body.indexOf('const roles = user?.roles', blockStart);
  const block = body.slice(blockStart, blockEnd);

  it('denies rather than admits — the guard stays negated', () => {
    assert.ok(blockStart > -1, 'the allow-list guard must stay negated');
    assert.ok(blockEnd > blockStart, 'the elevated-role branch must follow the allow-list block');
  });

  it('refuses the employee view first, with the empty shape and before any query', () => {
    assert.match(
      block,
      /^if \(!canViewTeamRankings\(sessionEmail\)\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(view !== 'manager' \|\| !department\) \{\s*return NextResponse\.json\(\{ weeks: \[\], error: null \}\);/,
      'a non-allow-listed employee-view caller must get the empty-week shape before anything runs',
    );
  });

  it('admits a non-allow-listed caller only through managerMayReadRankings', () => {
    const gate = block.indexOf('managerMayReadRankings(view, department,');
    const grants = block.indexOf('listDepartmentsForManager(sessionEmail)');
    const query = block.indexOf('getTeamRankings(');
    assert.ok(gate > -1 && grants > -1 && query > -1, 'grant lookup, gate and read must all be in the block');
    assert.ok(grants < gate && gate < query, 'grants are read, then checked, then — only then — rankings');
    assert.match(
      block,
      /if \(!managerMayReadRankings\(view, department, .*\)\) \{\s*return NextResponse\.json\(\{ weeks: \[\], error: null \}\);/,
      'a failed manager check must return the empty-week shape',
    );
  });

  it('never consults a role on the manager door', () => {
    for (const word of ['elevated', 'hasElevatedRole', 'roles']) {
      assert.ok(!block.includes(word), `the manager door must not read \`${word}\``);
    }
  });
});

/* "Instead of the Employee Dashboard": the employee tab must never ask as a manager,
 * and the manager surface must. Either drifting silently moves who sees rankings where. */
describe('team rankings — which surface sends which view', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const employeeSrc = readFileSync(path.join(root, 'src', 'components', 'employee', 'EmployeeTeam.tsx'), 'utf8');
  const managerSrc = readFileSync(path.join(root, 'src', 'components', 'manager', 'ManagerApp.tsx'), 'utf8');

  it('the employee team tab never sends a view', () => {
    const calls = employeeSrc.match(/fetch\(\s*`\/api\/team-rankings[^`]*`/g) ?? [];
    assert.ok(calls.length > 0, 'EmployeeTeam must still read /api/team-rankings');
    for (const c of calls) assert.ok(!c.includes('view='), `employee call must not carry a view: ${c}`);
  });

  it('Manager → My Team sends view=manager on every rankings read', () => {
    const calls = managerSrc.match(/fetch\(\s*`\/api\/team-rankings[^`]*`/g) ?? [];
    assert.ok(calls.length > 0, 'ManagerApp must still read /api/team-rankings');
    for (const c of calls) assert.ok(c.includes('&view=manager'), `manager call must send view=manager: ${c}`);
  });
});
