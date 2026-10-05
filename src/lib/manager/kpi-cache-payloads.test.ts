import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { departedMembersResponse, qcOfficerLogPayload, sameEmailSet } from './kpi-cache-payloads';
import { KPI_CACHE_KEYS } from './kpi-cache';

/**
 * The two datasets the department calculator added to the Manager KPI cache on
 * 2026-10-05: the QC first-pass rail and the departed-member set. Failure classes:
 *
 *   1. a FAILED read cached as an EMPTY answer, then painted on the next visit
 *      (the rail as "no officer assigned", the departed set as "hide nobody")
 *   2. a field the rail never draws reaching `sessionStorage` (`mine.members`
 *      carries full EmployeeRows for an officer)
 *   3. a malformed row painted as a short list
 *   4. a cache read deciding: the deal-writing fetch firing on an unresolved
 *      week, or a skipped fetch (source-scan controls below)
 */

const officer = { email: 'ana@simple.biz', index: 1, memberCount: 2, name: 'Ana Cruz' };
const slot = (member: string) => ({
  qc_officer_email: 'ana@simple.biz',
  member_email: member,
  member_name: member.split('@')[0],
  department: 'lead_gen',
  roster_status: 'active',
  current_department: 'lead_gen',
});
const live = {
  periodStart: '2026-09-27',
  officers: [officer],
  officerCount: 1,
  deptTotals: [{ department: 'lead_gen', total: 2, perOfficer: 2 }],
  assignments: [slot('a@x.com'), slot('b@x.com')],
  locks: [{ qc_officer_email: 'ana@simple.biz', status: 'locked', member_count: 2, locked_at: '2026-09-28T10:00:00Z', locked_by: 'ana@simple.biz' }],
  review: [{ period_start: '2026-09-27', department: 'lead_gen', status: 'pending', reviewed_by: null, reviewed_at: null, note: null }],
  mine: { memberEmails: ['a@x.com'], byDept: {}, members: [{ work_email: 'a@x.com', regular_rate: 4.5, phone: '0917' }] },
  error: null,
  degraded: null,
};

test('a live answer projects to exactly the four lists the rail draws', () => {
  const p = qcOfficerLogPayload(true, live);
  assert.ok(p);
  assert.deepEqual(Object.keys(p).sort(), ['assignments', 'locks', 'officers', 'review']);
  assert.deepEqual(p.officers, [officer]);
  assert.equal(p.assignments.length, 2);
});

test('class 2: nothing the rail does not draw survives the projection', () => {
  const p = qcOfficerLogPayload(true, live);
  const text = JSON.stringify(p);
  for (const banned of ['mine', 'regular_rate', 'phone', 'roster_status', 'current_department', 'locked_by', 'deptTotals']) {
    assert.ok(!text.includes(banned), `${banned} must not reach the cache`);
  }
});

test('class 1: a non-2xx or an error body is not an answer', () => {
  assert.equal(qcOfficerLogPayload(false, live), null);
  // What the rail used to read as "No QC officer is assigned": a 500's body.
  assert.equal(qcOfficerLogPayload(true, { error: 'boom' }), null);
  assert.equal(qcOfficerLogPayload(false, { error: 'period_start must be a Sunday' }), null);
  assert.equal(qcOfficerLogPayload(true, null), null);
  assert.equal(qcOfficerLogPayload(true, 'nope'), null);
});

test('a list the response left out reads as empty — the rail always did', () => {
  assert.deepEqual(qcOfficerLogPayload(true, { officers: [officer] }), {
    officers: [officer],
    assignments: [],
    locks: [],
    review: [],
  });
});

test('class 3: one undrawable row refuses the payload rather than shortening it', () => {
  assert.equal(qcOfficerLogPayload(true, { ...live, assignments: [slot('a@x.com'), { member_email: 'b@x.com' }] }), null);
  assert.equal(qcOfficerLogPayload(true, { ...live, assignments: 'x' }), null);
  assert.equal(qcOfficerLogPayload(true, { ...live, locks: [{ qc_officer_email: 'ana@simple.biz', status: 'maybe' }] }), null);
  assert.equal(qcOfficerLogPayload(true, { ...live, review: [{ department: 'lead_gen', status: 'done' }] }), null);
  assert.equal(qcOfficerLogPayload(true, { ...live, officers: [{ email: 'ana@simple.biz' }] }), null);
});

test('departed: a clean answer is normalised and cacheable', () => {
  assert.deepEqual(departedMembersResponse(true, { emails: [' B@x.com', 'a@x.com', 'b@x.com'], degraded: null, error: null }), {
    emails: ['a@x.com', 'b@x.com'],
    cacheable: true,
  });
});

test('departed class 1: a degraded 200 is shown as the route said, and never cached', () => {
  // The route fails OPEN with a 200 — caching it would paint hide-nobody next visit.
  assert.deepEqual(departedMembersResponse(true, { emails: [], degraded: 'timesheet read failed', error: null }), {
    emails: [],
    cacheable: false,
  });
  assert.deepEqual(departedMembersResponse(true, { emails: ['a@x.com'], degraded: 'evidence partial' }).cacheable, false);
});

test('departed: any failure hides NOBODY — never the previous answer', () => {
  for (const [ok, json] of [
    [false, { emails: ['a@x.com'] }],
    [true, { error: 'QC, manager, or admin role required' }],
    [true, { emails: 'a@x.com' }],
    [true, { emails: [1] }],
    [true, null],
  ] as const) {
    assert.deepEqual(departedMembersResponse(ok, json), { emails: [], cacheable: false });
  }
});

test('sameEmailSet compares contents, not identity', () => {
  assert.equal(sameEmailSet(new Set(['a', 'b']), new Set(['b', 'a'])), true);
  assert.equal(sameEmailSet(new Set(['a']), new Set(['a', 'b'])), false);
  assert.equal(sameEmailSet(new Set(['a', 'c']), new Set(['a', 'b'])), false);
  assert.equal(sameEmailSet(new Set(), new Set()), true);
});

test('keys are per WEEK and do not collide with the dept-week applied rows', () => {
  assert.notEqual(KPI_CACHE_KEYS.qcOfficerLog('2026-09-27'), KPI_CACHE_KEYS.qcOfficerLog('2026-09-20'));
  assert.notEqual(KPI_CACHE_KEYS.departedMembers('2026-09-27'), KPI_CACHE_KEYS.departedMembers('2026-09-20'));
  assert.notEqual(
    KPI_CACHE_KEYS.qcOfficerLog('2026-09-27'),
    KPI_CACHE_KEYS.deptApplied('dept-manager', 'lead_gen', '2026-09-27'),
  );
});

// ── Class 4: source-scan controls on the two call sites ─────────────────────

const calc = readFileSync(join(process.cwd(), 'src/components/manager/DeptBonusCalculator.tsx'), 'utf8');
const hook = readFileSync(join(process.cwd(), 'src/components/manager/useDepartedMembers.ts'), 'utf8');

test('the deal-writing fetch still only ever receives a RESOLVED week', () => {
  // GET /api/qc/assignments deals and upserts the week it is handed
  // (qc-scoring.md → The period key is a SUNDAY). The cache may paint the
  // presumed week; it must never be the week that fetch is sent.
  assert.match(calc, /periodStart=\{weekResolved \? weekStart : ''\}/);
  // The departed set is NOT painted before the week resolves — it filters the
  // member list, and departed-guard.test.ts forbids filtering on the seed. Its
  // cache is read only under the week the fetch is sent.
  assert.match(calc, /useDepartedMembers\(weekResolved \? weekStart : ''\)/);
  assert.match(hook, /cachedSet\(weekStart\)/);
  assert.ok(!/paintWeek|paintPeriod/.test(hook), 'the departed hook has no paint-only week');
});

test('both fetches stay unconditional — nothing cached is consulted to skip one', () => {
  const rail = calc.slice(calc.indexOf('function QcOfficerLog('), calc.indexOf('export default function DeptBonusCalculator'));
  assert.ok(rail.includes("fetch(`/api/qc/assignments?period_start=${periodStart}`"));
  assert.ok(!/if\s*\([^)]*(getKpiCache|hasKpiCache)/.test(rail), 'a cache read must never gate the rail fetch');
  assert.ok(!/if\s*\([^)]*(getKpiCache|hasKpiCache)/.test(hook), 'a cache read must never gate the departed fetch');
});

test('only an answer is cached: both writes sit behind their parser', () => {
  assert.match(calc, /qcOfficerLogPayload\(res\.ok, json\)/);
  assert.match(hook, /departedMembersResponse\(res\.ok, json\)/);
  assert.match(hook, /if \(answer\.cacheable\) setKpiCache/);
});
