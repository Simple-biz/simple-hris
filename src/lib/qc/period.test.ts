/**
 * The Sunday lock on QC period keys, and the source-scan control that keeps the
 * clock seed from coming back.
 *
 * Both halves matter. The predicate alone would not have prevented the ten
 * phantom periods measured on 2026-09-14 — the route has to USE it, and the
 * shell must not seed a week from `new Date()` at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isQcPeriodStart, qcPeriodStartError } from './period';

test('accepts pay-week Sundays', () => {
  for (const d of ['2026-09-06', '2026-09-13', '2026-08-16', '2026-06-14', '2026-01-04']) {
    assert.equal(isQcPeriodStart(d), true, `${d} is a Sunday`);
    assert.equal(qcPeriodStartError(d), null, `${d} should be accepted`);
  }
});

test('rejects every other weekday — the phantom keys measured in prod', () => {
  // Real non-Sunday period_start values found in qc_score_assignments.
  for (const d of ['2026-09-14', '2026-09-07', '2026-08-17', '2026-08-10', '2026-08-03']) {
    assert.equal(isQcPeriodStart(d), false, `${d} is a Monday and must be refused`);
    assert.match(qcPeriodStartError(d)!, /must be a pay-week Sunday/);
    assert.match(qcPeriodStartError(d)!, /Monday/, 'names the day it actually is');
  }
  assert.match(qcPeriodStartError('2026-09-12')!, /Saturday/);
});

test('rejects malformed and impossible days', () => {
  for (const bad of ['', '   ', 'today', '2026-9-6', '20260906', '2026-09-06T00:00:00Z', '2026-02-31', '2026-13-01']) {
    assert.equal(isQcPeriodStart(bad), false, `${JSON.stringify(bad)} must not pass`);
    assert.notEqual(qcPeriodStartError(bad), null);
  }
  assert.equal(isQcPeriodStart(null), false);
  assert.equal(isQcPeriodStart(undefined), false);
  assert.equal(qcPeriodStartError(null), 'period_start required');
});

test('a leap day that IS a Sunday is accepted (no calendar shortcuts)', () => {
  // 2032-02-29 is a Sunday.
  assert.equal(isQcPeriodStart('2032-02-29'), true);
});

test('CONTROL: the QC assignments route validates period_start before dealing', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/qc/assignments/route.ts'), 'utf8');
  // Match the CALLS, not the import line — `indexOf('qcPeriodStartError')` alone
  // would find the import and pass trivially no matter where the guard sits.
  const guardAt = src.indexOf('isQcPeriodStart(');
  const dealAt = src.indexOf('ensureQcAssignmentsForPeriod(');
  assert.ok(guardAt > 0, 'route must validate through the shared checker');
  assert.ok(dealAt > 0, 'route must still deal the period');
  assert.ok(
    guardAt < dealAt,
    'the guard must run BEFORE ensureQcAssignmentsForPeriod — that call WRITES, so a ' +
      'late check would reject the response after the phantom week was already dealt',
  );
});

/**
 * Comments removed, so the control scans CODE.
 *
 * Written deliberately: the first cut matched the bare identifier against the
 * whole file and failed on the comment that explains the fix — a detector that
 * cannot tell an explanation from a call is the same defect the `EmployeeProfile`
 * hook-order guard shipped with (audit 2026-09-12, row 31). Strips block
 * comments and whole-line `//` / `*` lines; leaves string literals alone, since
 * the tokens below never appear inside one.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

test('CONTROL: the QC shell never seeds a period from the clock', () => {
  const code = stripComments(readFileSync(join(process.cwd(), 'src/components/qc/QCApp.tsx'), 'utf8'));
  assert.doesNotMatch(
    code,
    /isoWeekStart/,
    'the Monday-anchored clock seed manufactured ten phantom periods — it must not return',
  );
  assert.doesNotMatch(
    code,
    /useState<string>\(\(\)\s*=>/,
    'the period must not be lazily initialised from anything; it resolves from usePayWeeks',
  );
  assert.match(
    code,
    /const \[weekStart, setWeekStart\] = useState<string>\(''\)/,
    'the period starts EMPTY and is set only once usePayWeeks resolves a real batch Sunday',
  );
});

test('CONTROL: the comment stripper actually strips (the guard that broke last time)', () => {
  assert.equal(stripComments('  // isoWeekStart(new Date())\nconst a = 1;').includes('isoWeekStart'), false);
  assert.equal(stripComments('/* isoWeekStart */\nconst a = 1;').includes('isoWeekStart'), false);
  assert.equal(stripComments('const x = isoWeekStart(d);').includes('isoWeekStart'), true, 'real calls survive');
});

test("CONTROL: the manager calculator's QC officer log waits for a resolved week", () => {
  const code = stripComments(
    readFileSync(join(process.cwd(), 'src/components/manager/DeptBonusCalculator.tsx'), 'utf8'),
  );
  // GET /api/qc/assignments DEALS the week, so this fetch is a write path too —
  // it manufactured phantom periods from the manager side exactly as QCApp did.
  assert.match(
    code,
    /periodStart=\{weekResolved \? weekStart : ''\}/,
    'QcOfficerLog must receive the period only once the week has resolved',
  );
});
