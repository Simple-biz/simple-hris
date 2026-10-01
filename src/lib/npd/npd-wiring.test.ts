/**
 * NPD wiring — the guards that live in files the pure tests cannot reach:
 * the tab registries, the route's gate and save order, and the SQL's lockdown.
 * Source scans, so a refactor that drops one fails here instead of in production.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ACCOUNTING_TAB_IDS, accountingTabToFeatureKey, allowedAccountingTabsForUser } from '@/lib/rbac/accounting-tabs';
import { VIEW_TAB_IDS } from '@/lib/rbac/view-tabs';
import { FEATURE_CATALOG } from '@/lib/rbac/feature-permissions';
import { dashboardPages, pageLabel } from '@/lib/pages/visibility';
import { humanizeTabId } from '@/lib/presence/page-label';
import { familyForAction } from '@/lib/audit/registry';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

describe('NPD is registered as an Accounting tab, right below the Payroll Wizard', () => {
  test('every registry lists npd immediately after payroll-wizard', () => {
    const after = (list: readonly string[], id: string) => list[list.indexOf(id) + 1];
    assert.equal(after(ACCOUNTING_TAB_IDS, 'payroll-wizard'), 'npd');
    assert.equal(after(VIEW_TAB_IDS.accounting, 'payroll-wizard'), 'npd');
    assert.equal(after(FEATURE_CATALOG.accounting.map((f) => f.key), 'payroll_wizard'), 'npd');
    assert.equal(after(dashboardPages('accounting').map((p) => p.key), 'payroll-wizard'), 'npd');
  });

  test('the tab id maps to the `npd` feature key, the one the route gates on', () => {
    assert.equal(accountingTabToFeatureKey('npd'), 'npd');
  });

  test('hidden until granted: a non-admin without an npd grant does not get the tab', () => {
    assert.equal(allowedAccountingTabsForUser(['accounting'], { accounting: { payroll_wizard: 'edit' } }).includes('npd'), false);
    assert.ok(allowedAccountingTabsForUser(['accounting'], { accounting: { npd: 'view' } }).includes('npd'));
    assert.ok(allowedAccountingTabsForUser(['admin'], {}).includes('npd'));
  });

  test('labels: "NPD" everywhere a short name shows, never "Npd"', () => {
    assert.equal(humanizeTabId('npd'), 'NPD');
    assert.match(pageLabel('accounting', 'npd'), /NPD/);
  });

  test('the sidebar item sits right after Payroll Wizard and uses the hover label', () => {
    const src = read('src', 'components', 'Sidebar.tsx');
    const wizard = src.indexOf("{ id: 'payroll-wizard'");
    const npd = src.indexOf("{ id: 'npd'");
    const next = src.indexOf("{ id: 'bonus-catalog'");
    assert.ok(wizard > 0 && wizard < npd && npd < next, 'npd is between payroll-wizard and bonus-catalog');
    assert.match(src, /title: 'New Payroll Dashboard'/);
    assert.match(src, /<NpdNavLabel \/>/);
  });

  test('the label wipes NPD → New Payroll Dashboard on hover, like S-Wall', () => {
    const src = read('src', 'components', 'npd', 'NpdNavLabel.tsx');
    assert.match(src, />\s*NPD\s*</);
    assert.match(src, />\s*New Payroll Dashboard\s*</);
    assert.match(src, /group-hover:\[clip-path:inset\(0_100%_0_0\)\]/, 'the short label wipes out');
    assert.match(src, /group-hover:\[clip-path:inset\(0_0%_0_0\)\]/, 'the long label wipes in');
  });

  test('App.tsx renders the NPD dashboard for the npd tab', () => {
    const src = read('src', 'App.tsx');
    assert.match(src, /case 'npd':[\s\S]{0,400}<NpdDashboard canEdit=\{canEditAccountingTab\('npd', roles, featurePerms\)\} \/>/);
  });
});

describe('the NPD route', () => {
  const src = read('app', 'api', 'accounting', 'npd', 'route.ts');
  const get = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function PUT'));
  const put = src.slice(src.indexOf('export async function PUT'), src.indexOf('function conflictResponse'));

  test('GET is gated on npd VIEW, PUT on npd EDIT, each as its first statement', () => {
    assert.match(get, /^export async function GET\(req: Request\) \{\n\s+const authz = await requireFeatureAccess\('accounting', 'npd', 'view'\);\n\s+if \(!authz\.ok\) return deniedResponse\(authz\);/);
    assert.match(put, /^export async function PUT\(req: Request\) \{\n\s+const authz = await requireFeatureEdit\('accounting', 'npd'\);\n\s+if \(!authz\.ok\) return deniedResponse\(authz\);/);
  });

  test('saved_by is the SESSION email, never the body', () => {
    assert.match(put, /savedBy: authz\.sessionEmail/);
    assert.doesNotMatch(put, /savedBy: (raw|body|parsed)/);
  });

  test('order: read current → early 409 → audit removed rows → save → saved audit', () => {
    const at = (needle: string) => {
      const i = put.indexOf(needle);
      assert.ok(i >= 0, `PUT contains ${needle}`);
      return i;
    };
    const readCurrent = at('await readNpdSheet(sheet, week)');
    const early409 = at('current.meta.version !== expectedVersion');
    const removedAudit = at("action: 'npd.rows.removed'");
    const save = at('await saveNpdSheet(');
    const savedAudit = at("action: 'npd.sheet.saved'");
    assert.ok(readCurrent < early409 && early409 < removedAudit && removedAudit < save && save < savedAudit);
  });

  test('a removal that cannot be audited refuses the save', () => {
    const block = put.slice(put.indexOf("action: 'npd.rows.removed'"), put.indexOf('await saveNpdSheet('));
    assert.match(block, /if \(audit\.error\) \{\s*return NextResponse\.json\([\s\S]*?status: 500/);
  });

  test('a failed read is a 500/503, never an empty sheet', () => {
    assert.match(src, /status: f\.missing \? 503 : 500/);
    assert.match(put, /if \(!current\.ok\) return failed\(current\);/);
  });

  test('every action the route writes has an audit family', () => {
    for (const action of ['npd.sheet.saved', 'npd.rows.removed', 'npd.sheet.save_failed']) {
      assert.ok(src.includes(`'${action}'`), `route writes ${action}`);
      assert.equal(familyForAction(action)?.match, 'npd.', `${action} lands in the npd. family`);
    }
  });
});

describe('the NPD migration locks the tables to the service role', () => {
  const sql = read('references', 'sql', 'create', '2026-10-01_npd_sheets.sql');

  test('RLS on every table, no policies, privileges revoked from anon/authenticated', () => {
    for (const t of ['npd_sheets', 'npd_all_departments_rows', 'npd_hsl_rows']) {
      assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security;`));
      assert.match(sql, new RegExp(`revoke all on table public\\.${t} from anon, authenticated;`));
    }
    assert.doesNotMatch(sql, /create policy/i);
    assert.doesNotMatch(sql, /alter publication/i, 'never added to supabase_realtime');
  });

  test('the save function is revoked from PUBLIC/anon/authenticated and pins search_path', () => {
    assert.match(sql, /revoke all on function public\.npd_save_sheet\(text, date, integer, text, jsonb\) from public, anon, authenticated;/);
    assert.match(sql, /grant execute on function public\.npd_save_sheet\(text, date, integer, text, jsonb\) to service_role;/);
    assert.match(sql, /language plpgsql\nset search_path = ''/);
  });

  test('the version check raises the prefix the DB layer maps to a 409', () => {
    assert.match(sql, /raise exception 'npd_version_conflict:%', v_version/);
    const db = read('src', 'lib', 'supabase', 'npd-db.ts');
    assert.match(db, /\/npd_version_conflict:\(\\d\+\)\//);
  });

  test('the apply script points at this SQL file and defaults to a dry run', () => {
    const script = read('scripts', 'apply-npd-sheets-migration.mts');
    assert.match(script, /const SQL_RELATIVE = 'references\/sql\/create\/2026-10-01_npd_sheets\.sql';/);
    assert.match(script, /const dryRun = wantDry \|\| \(!wantVerify && !wantApply\);/);
  });
});
