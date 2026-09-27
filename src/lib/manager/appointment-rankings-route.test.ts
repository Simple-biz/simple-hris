import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/* Source scan of the My Team appointment reads and their shared gate. The gate is a
 * RULING, not an implementation detail — Kane, 2026-09-26: *"The my team tab lets
 * you only see what Departments were assigned to you."* A behavioural test cannot
 * see which gate a route consults, so the shape is pinned here (the same approach
 * `rankings-viewers.test.ts` takes for the SP Rankings route). */

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const ROOT = path.join(__dirname, '..', '..', '..');
const GATE = strip(readFileSync(path.join(__dirname, 'managed-department-gate.ts'), 'utf8'));
const ROUTES = {
  appointments: {
    code: strip(readFileSync(path.join(ROOT, 'app', 'api', 'manager', 'appointment-rankings', 'route.ts'), 'utf8')),
    read: 'getAppointmentRankings(',
  },
  days: {
    code: strip(
      readFileSync(path.join(ROOT, 'app', 'api', 'manager', 'appointment-rankings', 'days', 'route.ts'), 'utf8'),
    ),
    read: 'getDepartmentDaysWorked(',
  },
  // PM Team's bonus-ranked leaderboard (2026-09-26) — the same gate, the same order,
  // for both of its reads.
  deliverables: {
    code: strip(readFileSync(path.join(ROOT, 'app', 'api', 'manager', 'deliverable-rankings', 'route.ts'), 'utf8')),
    read: 'getDeliverableRankings(',
  },
  'deliverables daily': {
    code: strip(readFileSync(path.join(ROOT, 'app', 'api', 'manager', 'deliverable-rankings', 'route.ts'), 'utf8')),
    read: 'getDeliverableDailyRankings(',
  },
};

describe('managed-department gate — My Team scope, not the SP Rankings doors', () => {
  it('scopes by department_managers through the shared matcher', () => {
    assert.match(GATE, /listDepartmentsForManager\(sessionEmail\)/);
    assert.match(GATE, /departmentMatchesManagedAssignments\(department, managed\)/);
  });

  it('does not consult either SP Rankings door', () => {
    assert.doesNotMatch(GATE, /canViewTeamRankings|managerMayReadRankings|rankings-viewers/);
  });

  it('checks assignments BEFORE the elevated fallback, like department-members', () => {
    const scoped = GATE.indexOf('managed.length > 0');
    const fallback = GATE.indexOf('!elevated');
    const allowed = GATE.indexOf("return { kind: 'allowed'");
    assert.ok(scoped > 0 && fallback > scoped, 'an assigned elevated caller must stay scoped');
    assert.ok(allowed > fallback, 'allowed is reached only after both checks');
  });

  it('keys the session, never a caller-supplied email', () => {
    assert.match(GATE, /getServerSession\(authOptions\)/);
    assert.doesNotMatch(GATE, /searchParams/);
  });
});

for (const [name, { code, read }] of Object.entries(ROUTES)) {
  describe(`${name} route — gated before it reads`, () => {
    it('calls the shared gate, and reads only after every refusal has returned', () => {
      const gate = code.indexOf('authorizeManagedDepartment(department)');
      const lastRefusal = code.indexOf("gate.kind === 'out_of_scope'");
      const readAt = code.indexOf(read);
      assert.ok(gate > 0, 'must call authorizeManagedDepartment');
      assert.ok(lastRefusal > gate && readAt > lastRefusal, 'the read runs only once the gate allowed it');
    });

    it('does not consult the SP Rankings doors and takes no email parameter', () => {
      assert.doesNotMatch(code, /canViewTeamRankings|managerMayReadRankings|rankings-viewers/);
      assert.doesNotMatch(code, /searchParams\.get\('email'\)/);
    });
  });
}
