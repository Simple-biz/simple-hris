/**
 * Authorization matrix tests for the route-access guard.
 *
 * Run:  npx tsx --test src/lib/auth/route-access.test.ts
 *   (or `npm run test:authz`)
 *
 * Scope: these cover the AUTHORIZATION decision (evaluateRouteAccess), which is
 * the layer that had the bug — a roleless employee could open /admin. The
 * UNAUTHENTICATED case ("no JWT → /login") is enforced one layer up in proxy.ts
 * (the `!token` branch) before evaluateRouteAccess is ever called; that branch is
 * unchanged by this fix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateRouteAccess,
  isRouteAuthorized,
  requiredRolesFor,
} from './route-access';

const base = { sessionEmail: 'user@simple.biz', elevated: false, requestedEmail: null };

// ---------------------------------------------------------------------------
// Reported bug: an authenticated employee WITH NO ROLES could open /admin.
// ---------------------------------------------------------------------------
test('roleless employee is redirected away from /admin (the reported hole)', () => {
  const d = evaluateRouteAccess({ ...base, pathname: '/admin', roles: [] });
  assert.deepEqual(d, { action: 'redirect', pathname: '/employee', clearSearch: true });
});

test('admin can open /admin', () => {
  const d = evaluateRouteAccess({ ...base, pathname: '/admin', roles: ['admin'], elevated: true });
  assert.deepEqual(d, { action: 'allow' });
});

// ---------------------------------------------------------------------------
// Route variants — /admin, /admin/, /admin/users, /admin/settings, nested.
// ---------------------------------------------------------------------------
for (const pathname of ['/admin', '/admin/', '/admin/users', '/admin/settings', '/admin/a/b/c']) {
  test(`non-admin blocked from variant ${pathname}`, () => {
    const d = evaluateRouteAccess({ ...base, pathname, roles: ['manager'] });
    assert.equal(d.action, 'redirect');
    assert.equal((d as { pathname: string }).pathname, '/employee');
  });
  test(`admin allowed on variant ${pathname}`, () => {
    const d = evaluateRouteAccess({ ...base, pathname, roles: ['admin'], elevated: true });
    assert.deepEqual(d, { action: 'allow' });
  });
}

// ---------------------------------------------------------------------------
// requiredRolesFor resolves every variant to the same /admin requirement.
// ---------------------------------------------------------------------------
test('requiredRolesFor maps /admin and all sub-routes to ["admin"]', () => {
  for (const p of ['/admin', '/admin/', '/admin/users', '/admin/settings/deep']) {
    assert.deepEqual(requiredRolesFor(p), ['admin']);
  }
  assert.equal(requiredRolesFor('/employee'), null); // open route
  assert.equal(requiredRolesFor('/'), null);
});

// ---------------------------------------------------------------------------
// Each privileged dashboard requires its own role; admin is allowed everywhere.
// ---------------------------------------------------------------------------
const DASHBOARDS: Array<{ pathname: string; role: string }> = [
  { pathname: '/ceo', role: 'ceo' },
  { pathname: '/accounting', role: 'accounting' },
  { pathname: '/payroll-clerk', role: 'accounting' },
  { pathname: '/hr', role: 'hr_coordinator' },
  { pathname: '/orphanage', role: 'orphanage_manager' },
  { pathname: '/manager', role: 'manager' },
  { pathname: '/qc', role: 'qc' },
];

for (const { pathname, role } of DASHBOARDS) {
  test(`${pathname} allows its role (${role})`, () => {
    assert.deepEqual(
      evaluateRouteAccess({ ...base, pathname, roles: [role] }),
      { action: 'allow' },
    );
  });
  test(`${pathname} allows admin`, () => {
    assert.deepEqual(
      evaluateRouteAccess({ ...base, pathname, roles: ['admin'], elevated: true }),
      { action: 'allow' },
    );
  });
  test(`${pathname} blocks an unrelated role`, () => {
    const d = evaluateRouteAccess({ ...base, pathname, roles: ['orphanage_manager', 'manager'].filter((r) => r !== role) });
    assert.equal(d.action, 'redirect');
  });
}

test('an accounting user cannot open /admin', () => {
  const d = evaluateRouteAccess({ ...base, pathname: '/admin', roles: ['accounting'], elevated: true });
  assert.equal(d.action, 'redirect');
});

// ---------------------------------------------------------------------------
// Admin API namespace is gated at the edge (defense in depth) → 403, not redirect.
// ---------------------------------------------------------------------------
test('non-admin calling /api/admin/* is forbidden (403)', () => {
  const d = evaluateRouteAccess({ ...base, pathname: '/api/admin/anthropic-key', roles: ['accounting'], elevated: true });
  assert.deepEqual(d, { action: 'forbid' });
});

test('admin calling /api/admin/* is allowed', () => {
  const d = evaluateRouteAccess({ ...base, pathname: '/api/admin/diagnostics', roles: ['admin'], elevated: true });
  assert.deepEqual(d, { action: 'allow' });
});

test('non-admin API routes outside /api/admin/* are not blocked by this layer', () => {
  // Their own handlers enforce authz; the proxy must not 403 them here.
  const d = evaluateRouteAccess({ ...base, pathname: '/api/employees', roles: [] });
  assert.deepEqual(d, { action: 'allow' });
});

// ---------------------------------------------------------------------------
// Open routes stay open to any authenticated user.
// ---------------------------------------------------------------------------
for (const pathname of ['/employee', '/', '/auth-callback']) {
  test(`open route ${pathname} allows a roleless user`, () => {
    assert.deepEqual(evaluateRouteAccess({ ...base, pathname, roles: [] }), { action: 'allow' });
  });
}

// ---------------------------------------------------------------------------
// Contractor-only handling preserved.
// ---------------------------------------------------------------------------
test('contractor-only on /employee is redirected to /contractor', () => {
  const d = evaluateRouteAccess({ ...base, pathname: '/employee', roles: ['contractor'] });
  assert.deepEqual(d, { action: 'redirect', pathname: '/contractor' });
});

test('contractor-only blocked from /admin lands on /contractor, not /employee', () => {
  const d = evaluateRouteAccess({ ...base, pathname: '/admin', roles: ['contractor'] });
  assert.deepEqual(d, { action: 'redirect', pathname: '/contractor', clearSearch: true });
});

// ---------------------------------------------------------------------------
// ?email= ownership pinning preserved (no cross-employee dashboard viewing).
// ---------------------------------------------------------------------------
test('non-elevated user cannot view another employee via ?email=', () => {
  const d = evaluateRouteAccess({
    pathname: '/employee', roles: [], sessionEmail: 'me@simple.biz', elevated: false,
    requestedEmail: 'someone-else@simple.biz',
  });
  assert.deepEqual(d, { action: 'redirect', pathname: '/employee', setEmail: 'me@simple.biz' });
});

test('elevated user MAY view another employee on a non-personal route', () => {
  const d = evaluateRouteAccess({
    pathname: '/accounting', roles: ['accounting'], sessionEmail: 'me@simple.biz', elevated: true,
    requestedEmail: 'someone-else@simple.biz',
  });
  assert.deepEqual(d, { action: 'allow' });
});

test('even an elevated user is pinned to self on personal routes (/ceo)', () => {
  const d = evaluateRouteAccess({
    pathname: '/ceo', roles: ['ceo', 'admin'], sessionEmail: 'me@simple.biz', elevated: true,
    requestedEmail: 'someone-else@simple.biz',
  });
  assert.deepEqual(d, { action: 'redirect', pathname: '/ceo', setEmail: 'me@simple.biz' });
});

test('a QC officer is pinned to self on the personal /qc route', () => {
  const d = evaluateRouteAccess({
    pathname: '/qc', roles: ['qc'], sessionEmail: 'me@simple.biz', elevated: false,
    requestedEmail: 'someone-else@simple.biz',
  });
  assert.deepEqual(d, { action: 'redirect', pathname: '/qc', setEmail: 'me@simple.biz' });
});

// ---------------------------------------------------------------------------
// isRouteAuthorized convenience (used by server-side page guards).
// ---------------------------------------------------------------------------
test('isRouteAuthorized matches the dashboard map', () => {
  assert.equal(isRouteAuthorized('/admin', ['admin']), true);
  assert.equal(isRouteAuthorized('/admin', ['manager']), false);
  assert.equal(isRouteAuthorized('/admin/users', []), false);
  assert.equal(isRouteAuthorized('/employee', []), true);
});

// ---------------------------------------------------------------------------
// /tickets hosts TWO surfaces: the HRIS dev Kanban (`tickets`) and Employee
// Support's live chat (`employee_support`, Kane's Q3, 2026-09-19). Either role
// opens the ROUTE; neither opens the other's surface — that split happens one
// level down, in ticketsHostAccess() (src/lib/rbac/view-tabs.ts), which this
// layer knows nothing about. What this layer must get right is: the new role
// opens /tickets and NOTHING else, and the old role's access is unchanged.
// ---------------------------------------------------------------------------
test('/tickets requires tickets, employee_support or admin — in that order', () => {
  assert.deepEqual(requiredRolesFor('/tickets'), ['tickets', 'employee_support', 'admin']);
  assert.deepEqual(requiredRolesFor('/tickets/anything/deep'), ['tickets', 'employee_support', 'admin']);
});

for (const roles of [['tickets'], ['employee_support'], ['tickets', 'employee_support'], ['admin']]) {
  test(`/tickets allows [${roles.join(', ')}]`, () => {
    assert.deepEqual(
      evaluateRouteAccess({ ...base, pathname: '/tickets', roles, elevated: roles.includes('admin') }),
      { action: 'allow' },
    );
  });
}

for (const roles of [[], ['hr_coordinator'], ['manager', 'qc'], ['accounting'], ['contractor']]) {
  test(`/tickets turns away [${roles.join(', ') || 'no roles'}]`, () => {
    const d = evaluateRouteAccess({ ...base, pathname: '/tickets', roles });
    assert.equal(d.action, 'redirect');
  });
}

// The new role is a key to ONE door. A support answerer must not have acquired
// a dashboard on the way in.
for (const pathname of ['/admin', '/ceo', '/accounting', '/payroll-clerk', '/hr', '/orphanage', '/manager', '/qc']) {
  test(`employee_support cannot open ${pathname}`, () => {
    const d = evaluateRouteAccess({ ...base, pathname, roles: ['employee_support'] });
    assert.equal(d.action, 'redirect');
    assert.equal((d as { pathname: string }).pathname, '/employee');
  });
}

test('employee_support calling /api/admin/* is still forbidden', () => {
  const d = evaluateRouteAccess({ ...base, pathname: '/api/admin/diagnostics', roles: ['employee_support'] });
  assert.deepEqual(d, { action: 'forbid' });
});

test('adding employee_support did not change what a tickets holder may open', () => {
  // The whole point of a parallel key: this list is the pre-2026-09-19 answer,
  // re-asserted.
  assert.equal(isRouteAuthorized('/tickets', ['tickets']), true);
  for (const pathname of ['/admin', '/ceo', '/accounting', '/hr', '/orphanage', '/manager', '/qc']) {
    assert.equal(isRouteAuthorized(pathname, ['tickets']), false, `${pathname} must stay shut to tickets`);
  }
});
