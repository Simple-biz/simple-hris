import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VIEW_LABELS, VIEW_ROUTES, defaultViewFor, viewsForRoles, type Role } from './views';

/* The switcher rail. Employee Support is hosted AT /tickets (Kane's Q3), so the
 * `employee_support` role unlocks that destination and splits from the dev board
 * one level down, at the tabs (ticketsHostAccess in view-tabs.ts). What must
 * hold here: the new role reaches the rail at all, it reaches nothing else, and
 * a `tickets` holder's rail is byte-for-byte what it was. */

describe('viewsForRoles — the Employee Support role', () => {
  it('puts a support-only holder on the /tickets destination', () => {
    assert.deepEqual(viewsForRoles(['employee_support']), ['tickets', 'employee']);
  });

  it('gives them no dashboard — the rail is Tickets and their own portal, nothing else', () => {
    const views = viewsForRoles(['employee_support']);
    for (const forbidden of ['admin', 'ceo', 'hr', 'accounting', 'orphanage', 'qc', 'manager'] as const) {
      assert.ok(!views.includes(forbidden), `${forbidden} must not appear for a support answerer`);
    }
  });

  it('leaves a tickets holder’s rail exactly as it was', () => {
    assert.deepEqual(viewsForRoles(['tickets']), ['tickets', 'employee']);
    assert.deepEqual(viewsForRoles(['tickets', 'employee_support']), ['tickets', 'employee']);
  });

  it('does not add a row for admin, who already had every one', () => {
    assert.deepEqual(
      viewsForRoles(['admin']),
      ['admin', 'ceo', 'hr', 'accounting', 'orphanage', 'qc', 'manager', 'tickets', 'contractor', 'employee'],
    );
  });

  it('still lands a support answerer on their own portal by default', () => {
    // login/page.tsx prefers 'employee' when present; defaultViewFor is the
    // fallback. Neither should drop somebody onto a shared board on sign-in.
    assert.equal(defaultViewFor(viewsForRoles(['employee_support'])), 'tickets');
    assert.ok(viewsForRoles(['employee_support']).includes('employee'));
  });
});

describe('an AppView is a destination, not a permission catalog', () => {
  it('no two switcher rows point at the same route', () => {
    // This is why Employee Support is a new FeatureViewKey and NOT a new
    // AppView: a second row reading "Employee Support" would navigate to
    // /tickets, the row already there. The surfaces divide at the tabs.
    const routes = Object.values(VIEW_ROUTES);
    assert.equal(new Set(routes).size, routes.length, 'two views share a route');
  });

  it('every view has a route and a label', () => {
    for (const view of Object.keys(VIEW_ROUTES) as Array<keyof typeof VIEW_ROUTES>) {
      assert.ok(VIEW_ROUTES[view], `${view} has no route`);
      assert.ok(VIEW_LABELS[view], `${view} has no label`);
    }
  });

  it('the support role is a Role, not an AppView', () => {
    const role: Role = 'employee_support';
    assert.ok(!(role in VIEW_ROUTES), 'employee_support must not become a switcher destination');
  });
});
