/** Run: node --import tsx --test src/lib/accounting-scoreboard/roles.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOARD_ACTIONS,
  BOARD_ROLES,
  ROLE_LABEL,
  can,
  canRevokeGrant,
  highestGrant,
  isBoardRole,
  resolveBoardRole,
  type BoardAction,
  type BoardRole,
} from './roles';

// Carla, 2026-10-07: Team member edits everything except Setup; Assistant sees Setup but can't change it
// and sees everyone's tasks; Admin has full write. Not an edit/view/hidden matrix ("Nah.").
// Kane, 2026-10-07 (item 393): HRIS accounting alone no longer makes a manager; HRIS admin stays a board Admin.

test('an HRIS admin is always a board Admin (break glass)', () => {
  assert.equal(resolveBoardRole({ hrisRoles: ['admin'], grant: null, isMember: false }), 'admin');
  assert.equal(resolveBoardRole({ hrisRoles: ['admin'], grant: 'assistant', isMember: true }), 'admin');
});

test('HRIS accounting alone is a Team member at most, never a manager, and never lets anyone in', () => {
  assert.equal(resolveBoardRole({ hrisRoles: ['accounting'], grant: null, isMember: true }), 'member');
  assert.equal(resolveBoardRole({ hrisRoles: ['accounting'], grant: null, isMember: false }), null);
  assert.equal(resolveBoardRole({ hrisRoles: ['accounting', 'ceo', 'hr_coordinator'], grant: null, isMember: false }), null);
});

test('a grant is the role, and it is membership', () => {
  assert.equal(resolveBoardRole({ hrisRoles: [], grant: 'assistant', isMember: false }), 'assistant');
  assert.equal(resolveBoardRole({ hrisRoles: [], grant: 'admin', isMember: false }), 'admin');
  assert.equal(resolveBoardRole({ hrisRoles: ['accounting'], grant: 'assistant', isMember: true }), 'assistant');
});

test('nobody else gets in', () => {
  assert.equal(resolveBoardRole({ hrisRoles: [], grant: null, isMember: false }), null);
});

test('the permission table (the plan\'s cases, plus unverify_any found in Step 0)', () => {
  const cases: Array<[BoardRole, BoardAction, boolean]> = [
    ['member', 'edit_cells', true], ['member', 'log_lines', true], ['member', 'view_setup', false],
    ['member', 'edit_setup', false], ['member', 'delete_any_line', false], ['member', 'unverify_any', false],
    ['member', 'lock_week', false], ['member', 'view_all_tasks', false], ['member', 'manage_roles', false],
    ['assistant', 'edit_cells', true], ['assistant', 'log_lines', true],
    ['assistant', 'view_setup', true], ['assistant', 'edit_setup', false], ['assistant', 'view_all_tasks', true],
    ['assistant', 'manage_tasks', false], ['assistant', 'reopen_week', false], ['assistant', 'delete_any_line', false],
    ['assistant', 'unverify_any', false], ['assistant', 'manage_roles', false],
    ['admin', 'edit_setup', true], ['admin', 'delete_any_line', true], ['admin', 'unverify_any', true],
    ['admin', 'lock_week', true], ['admin', 'reopen_week', true], ['admin', 'manage_tasks', true],
    ['admin', 'manage_roles', true], ['admin', 'view_setup', true],
  ];
  for (const [role, action, expected] of cases) assert.equal(can(role, action), expected, `${role} ${action}`);
});

test('the roles nest: everything a Team member may do, an Assistant may; everything an Assistant may, an Admin may', () => {
  for (const action of BOARD_ACTIONS) {
    if (can('member', action)) assert.ok(can('assistant', action), `assistant lacks ${action}`);
    if (can('assistant', action)) assert.ok(can('admin', action), `admin lacks ${action}`);
  }
  assert.ok(BOARD_ACTIONS.every((a) => can('admin', a)), 'an Admin may do everything');
});

test('Review Focus 3: the last Admin grant cannot be revoked', () => {
  assert.equal(canRevokeGrant({ role: 'admin' }, 1), false);
  assert.equal(canRevokeGrant({ role: 'admin' }, 0), false);
  assert.equal(canRevokeGrant({ role: 'admin' }, 2), true);
  assert.equal(canRevokeGrant({ role: 'assistant' }, 1), true);
  assert.equal(canRevokeGrant({ role: 'assistant' }, 0), true);
});

test('two aliases with different grants: the higher one wins', () => {
  assert.equal(highestGrant([]), null);
  assert.equal(highestGrant(['assistant']), 'assistant');
  assert.equal(highestGrant(['assistant', 'admin']), 'admin');
  assert.equal(highestGrant(['admin', 'assistant']), 'admin');
});

test('isBoardRole: only the three words', () => {
  for (const r of BOARD_ROLES) assert.ok(isBoardRole(r));
  for (const bad of ['Admin', 'manager', '', null, undefined, 1, true]) assert.equal(isBoardRole(bad), false);
});

test('every role has a label people read', () => {
  assert.deepEqual(ROLE_LABEL, { admin: 'Admin', assistant: 'Assistant', member: 'Team member' });
});

/* ── Source pins: no access decision is left on the old flag ──────────────── */

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}
const ROOT = process.cwd();
const SOURCES = [
  join(ROOT, 'src', 'lib', 'accounting-scoreboard'),
  join(ROOT, 'src', 'components', 'accounting-scoreboard'),
  join(ROOT, 'app', 'api', 'accounting-scoreboard'),
  join(ROOT, 'app', 'accounting-scoreboard'),
].flatMap(filesUnder);

test('nothing on the board reads isManager or an HRIS role list any more', () => {
  const offenders = SOURCES.filter((f) => /\bisManager\b|MANAGER_ROLES/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('every route resolves access through resolveAccess, and setup writes ask for edit_setup', () => {
  const routes = SOURCES.filter((f) => f.includes(join('app', 'api', 'accounting-scoreboard')) && f.endsWith('route.ts'));
  assert.ok(routes.length >= 11, `found ${routes.length} routes`);
  for (const f of routes) assert.match(readFileSync(f, 'utf8'), /resolveAccess\(/, f);
  for (const name of ['rows', 'sections', 'custom-sections', 'problem-types', 'members', 'roster']) {
    const src = readFileSync(join(ROOT, 'app', 'api', 'accounting-scoreboard', name, 'route.ts'), 'utf8');
    assert.doesNotMatch(src, /resolveAccess\((?!'edit_setup'\))/, `${name} must ask for edit_setup`);
  }
  const roles = readFileSync(join(ROOT, 'app', 'api', 'accounting-scoreboard', 'roles', 'route.ts'), 'utf8');
  assert.doesNotMatch(roles, /resolveAccess\((?!'manage_roles'\))/, 'the roles route is Admin only');
});

test('the server refuses the last Admin revoke before the database does', () => {
  const server = readFileSync(join(ROOT, 'src', 'lib', 'accounting-scoreboard', 'server.ts'), 'utf8');
  assert.match(server, /canRevokeGrant\(/);
  assert.match(server, /accounting_scoreboard\.role_granted/);
  assert.match(server, /accounting_scoreboard\.role_revoked/);
});
