/**
 * The employee payroll-lock banner must never assert a restriction that is not
 * real on the tab in view — the false "Issues are temporarily paused" is what
 * made people believe Documents were delayed during a payroll run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PAYROLL_LOCK_AFFECTED_TABS,
  PAYROLL_LOCK_DETAIL_PROFILE,
  PAYROLL_LOCK_DETAIL_UNAFFECTED,
  payrollLockDetailFor,
} from './payroll-lock-detail';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every tab the employee shell renders (EmployeeApp's switch). */
const EMPLOYEE_TABS = [
  'dashboard', 'profile', 'hours', 'kpi', 'approvals',
  'leaves', 'mesa', 'team', 'notifications', 's-wall',
];

test('Profile names the one real restriction AND clears documents in the same breath', () => {
  const detail = payrollLockDetailFor('profile');
  assert.equal(detail, PAYROLL_LOCK_DETAIL_PROFILE);
  assert.match(detail, /read-only/, 'the payout restriction is real and must be stated');
  assert.match(detail, /documents is unaffected/i, 'the reassurance is the whole point of this change');
});

test('every other employee tab is told it is unaffected — silence reads as a lock', () => {
  for (const tab of EMPLOYEE_TABS.filter((t) => !PAYROLL_LOCK_AFFECTED_TABS.includes(t))) {
    assert.equal(payrollLockDetailFor(tab), PAYROLL_LOCK_DETAIL_UNAFFECTED, `tab ${tab}`);
  }
});

test('an unknown or newly added tab is told it is unaffected, which is the true statement', () => {
  assert.equal(payrollLockDetailFor('a-tab-that-does-not-exist-yet'), PAYROLL_LOCK_DETAIL_UNAFFECTED);
  assert.equal(payrollLockDetailFor(''), PAYROLL_LOCK_DETAIL_UNAFFECTED);
});

test('no sentence mentions Issues or Disputes — that tab is gone from the employee shell', () => {
  for (const tab of EMPLOYEE_TABS) {
    const detail = payrollLockDetailFor(tab);
    assert.ok(!/issue/i.test(detail), `"${detail}" names Issues, a tab the employee shell no longer renders`);
    assert.ok(!/dispute/i.test(detail), `"${detail}" names Disputes, a tab the employee shell no longer renders`);
  }
});

test('the Issues tab really is gone — the premise this module is built on', () => {
  // If Issues ever comes back, the sentences above become wrong by omission and
  // this test says so at the moment of the change rather than during a payroll run.
  const sidebar = read('src/components/employee/EmployeeSidebar.tsx');
  const app = read('src/components/employee/EmployeeApp.tsx');
  assert.ok(
    !/^\s*\{\s*id:\s*'disputes'/m.test(sidebar),
    "the disputes nav entry is live again — re-teach payroll-lock-detail.ts before shipping it",
  );
  assert.ok(
    !/^\s*case 'disputes':/m.test(app),
    "the disputes render branch is live again — re-teach payroll-lock-detail.ts before shipping it",
  );
});

test('PayrollLockBanner REQUIRES a detail prop, and the shell feeds it from this module', () => {
  const banner = read('src/components/employee/PayrollLockBanner.tsx');
  // Non-optional on purpose. An optional `detail` is what let the retired
  // "Issues are temporarily paused." default survive the tab it named; with no
  // default, a new mount has to state its own consequence or fail to compile.
  assert.match(banner, /^\s*detail:\s*string;/m, 'detail must stay REQUIRED — no default sentence to go stale');
  assert.ok(!/detail\?:/.test(banner), 'detail was made optional again — a default will go stale unnoticed');
  assert.ok(!/detail\s*=\s*['"]/.test(banner), 'a default sentence was reintroduced in the signature');
  const app = read('src/components/employee/EmployeeApp.tsx');
  assert.match(
    app,
    /<PayrollLockBanner[^>]*detail=\{payrollLockDetailFor\(activeTab\)\}/s,
    'the employee shell must scope the banner sentence to the active tab',
  );
});

test('the banner default no longer hard-codes the retired Issues sentence', () => {
  const banner = read('src/components/employee/PayrollLockBanner.tsx');
  assert.ok(
    !/Issues are temporarily paused/.test(banner),
    'the retired default sentence is still in the banner',
  );
});
