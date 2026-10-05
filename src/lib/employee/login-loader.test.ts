/**
 * The employee sign-in card ("Loading your Employee Dashboard") must cover the
 * shell until the Overview is really on screen, and must never trap anyone
 * behind it. docs/features/employee-login-loader.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOGIN_LOADER_EYEBROW,
  LOGIN_LOADER_MAX_MS,
  LOGIN_LOADER_STATUS_MESSAGES,
  LOGIN_LOADER_TAB,
  loginLoaderLifted,
  shouldLiftLoginLoader,
  type LoginLoaderLiftInput,
} from './login-loader';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The one state that holds the card: the Overview is coming and nothing has happened yet. */
const HOLD: LoginLoaderLiftInput = {
  overviewReady: false,
  activeTab: LOGIN_LOADER_TAB,
  overviewVisibility: 'visible',
  timedOut: false,
};

test('the card holds while the Overview is on its way and nothing has settled', () => {
  assert.equal(shouldLiftLoginLoader(HOLD), false);
});

test('the Overview reporting its first paint lifts the card', () => {
  assert.equal(shouldLiftLoginLoader({ ...HOLD, overviewReady: true }), true);
});

test('a hung load cannot trap anyone — the ceiling lifts it on its own', () => {
  assert.equal(shouldLiftLoginLoader({ ...HOLD, timedOut: true }), true);
  assert.ok(Number.isFinite(LOGIN_LOADER_MAX_MS) && LOGIN_LOADER_MAX_MS > 0);
  // Raising the ceiling only lengthens the worst case of staring at a card.
  assert.ok(LOGIN_LOADER_MAX_MS <= 15_000, `ceiling ${LOGIN_LOADER_MAX_MS}ms`);
});

test('an Overview that will never report lifts the card: another tab, hidden, or under construction', () => {
  assert.equal(shouldLiftLoginLoader({ ...HOLD, activeTab: 'profile' }), true);
  assert.equal(shouldLiftLoginLoader({ ...HOLD, overviewVisibility: 'hidden' }), true);
  assert.equal(shouldLiftLoginLoader({ ...HOLD, overviewVisibility: 'construction' }), true);
});

test('once lifted, the card never comes back over a page in use', () => {
  const liftedByBounce = loginLoaderLifted(false, { ...HOLD, activeTab: 'profile' });
  assert.equal(liftedByBounce, true);
  // Back on the Overview, fetches still in flight — the hold inputs return.
  assert.equal(loginLoaderLifted(liftedByBounce, HOLD), true);
  assert.equal(loginLoaderLifted(false, HOLD), false);
});

test('the copy is about signing in, not switching', () => {
  assert.doesNotMatch(LOGIN_LOADER_EYEBROW, /switch/i);
  assert.ok(LOGIN_LOADER_STATUS_MESSAGES.length >= 2, 'a single line cannot cycle');
  for (const line of LOGIN_LOADER_STATUS_MESSAGES) {
    assert.doesNotMatch(line, /switch|permission/i, line);
  }
});

const APP = read('src/components/employee/EmployeeApp.tsx');
const DASHBOARD = read('src/components/employee/EmployeeDashboard.tsx');
const LOADER = read('src/components/employee/EmployeeLoginLoader.tsx');

test('the shell shows the card on EVERY cold mount — never gated on the sign-in baton', () => {
  // Most visits arrive via `/` → `/employee` (app/page.tsx) with no baton at all;
  // gating on it is what made the card invisible on 2026-10-05 ("where is the loading?").
  assert.match(APP, /\n\s*<EmployeeLoginLoader show=\{loginLoaderUp\} \/>\n/);
  assert.doesNotMatch(APP, /revealFromLogin && <EmployeeLoginLoader/);
  assert.match(APP, /const \[loginLoaderLatched, setLoginLoaderLatched\] = useState\(false\);/);
  assert.equal(APP.match(/<EmployeeLoginLoader\b/g)?.length, 1);
});

test('a hard load paints the same card before the shell exists, not a bare spinner', () => {
  const page = read('app/employee/page.tsx');
  assert.match(page, /<Suspense fallback=\{<EmployeeShellFallback \/>\}>/);
  assert.match(page, /eyebrow=\{LOGIN_LOADER_EYEBROW\}/);
  assert.doesNotMatch(page, /animate-spin/);
});

test('the shell hears the Overview, and Penny stays quiet while the card is up', () => {
  assert.match(APP, /onFirstPaintReady=\{\(\) => setOverviewReady\(true\)\}/);
  // A new reason to stay quiet goes in the render guard, never the timer
  // (docs/features/employee-penny-ai.md § It stays quiet when speaking would be wrong).
  assert.match(APP, /quiet: activeTab !== 'dashboard' \|\| loginLoaderUp,/);
});

test('the Overview reports once, and only after the first week of hours settled', () => {
  assert.match(DASHBOARD, /const firstPaintReady = !loading && firstHoursSettled && !fileLoading;/);
  assert.match(DASHBOARD, /if \(!firstPaintReady \|\| firstPaintReportedRef\.current\) return;/);
  assert.equal(DASHBOARD.match(/onFirstPaintReady\?\.\(\)/g)?.length, 1);
});

test('no minimum display time — the only timer is the ceiling', () => {
  assert.doesNotMatch(LOADER, /setTimeout|setInterval/);
  const appTimers = APP.match(/setTimeout\([^;]*LOGIN_LOADER[^;]*\)/g) ?? [];
  assert.deepEqual(appTimers, [
    'setTimeout(() => setLoginLoaderTimedOut(true), LOGIN_LOADER_MAX_MS)',
  ]);
  // The ceiling is armed on every mount, like the card — not behind the baton.
  assert.match(APP, /LOGIN_LOADER_MAX_MS\);\n\s*return \(\) => window\.clearTimeout\(id\);\n\s*\}, \[\]\);/);
});

test('the dashboard switch keeps its own copy — only the employee loading card overrides it', () => {
  const switchLoader = read('src/components/common/DashboardSwitchLoader.tsx');
  assert.match(switchLoader, /eyebrow = 'Switching to'/);
  const overriders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx$/.test(entry.name)) {
        const src = read(rel);
        if (/<DashboardSwitchLoader\b[^>]*\beyebrow=/.test(src)) overriders.push(rel.replace(/\\/g, '/'));
      }
    }
  };
  walk('src');
  walk('app');
  assert.deepEqual(overriders.sort(), [
    'app/employee/page.tsx',
    'src/components/employee/EmployeeLoginLoader.tsx',
  ]);
});
