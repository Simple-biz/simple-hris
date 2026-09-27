import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/* Source scan of `GET /api/manager/appointment-rankings`. The route's gate is a
 * RULING, not an implementation detail — Kane, 2026-09-26: *"The my team tab lets
 * you only see what Departments were assigned to you."* A behavioural test cannot
 * see which gate a route consults, so the shape is pinned here (the same approach
 * `rankings-viewers.test.ts` takes for the SP Rankings route). */

const ROUTE = path.join(__dirname, '..', '..', '..', 'app', 'api', 'manager', 'appointment-rankings', 'route.ts');
const SRC = readFileSync(ROUTE, 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('appointment rankings route — My Team scope, not the SP Rankings list', () => {
  it('scopes by department_managers through the shared matcher', () => {
    assert.match(CODE, /listDepartmentsForManager\(sessionEmail\)/);
    assert.match(CODE, /departmentMatchesManagedAssignments\(department, managed\)/);
  });

  it('does not consult the one-name SP Rankings allow-list', () => {
    assert.doesNotMatch(CODE, /canViewTeamRankings|rankings-viewers/);
  });

  it('checks assignments BEFORE the elevated fallback, like department-members', () => {
    const scoped = CODE.indexOf('managed.length > 0');
    const fallback = CODE.indexOf('!elevated');
    const read = CODE.indexOf('getAppointmentRankings(');
    assert.ok(scoped > 0 && fallback > scoped, 'an assigned elevated caller must stay scoped');
    assert.ok(read > fallback, 'the read runs only after both gates');
  });

  it('keys the session, never a caller-supplied email', () => {
    assert.doesNotMatch(CODE, /searchParams\.get\('email'\)/);
  });
});
