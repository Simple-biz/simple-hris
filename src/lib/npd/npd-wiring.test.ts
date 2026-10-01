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
  const put = src.slice(src.indexOf('export async function PUT'), src.indexOf('export async function PATCH'));
  const patch = src.slice(src.indexOf('export async function PATCH'), src.indexOf('function lockedResponse'));
  const lockBranch = patch.slice(0, patch.indexOf('// Unlock.'));
  const unlockBranch = patch.slice(patch.indexOf('// Unlock.'));

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

  test('PATCH (lock / unlock) is gated on npd EDIT as its first statement', () => {
    assert.match(patch, /^export async function PATCH\(req: Request\) \{\n\s+const authz = await requireFeatureEdit\('accounting', 'npd'\);\n\s+if \(!authz\.ok\) return deniedResponse\(authz\);/);
  });

  test('a save to a LOCKED sheet is refused before the version check and before any audit', () => {
    const lockCheck = put.indexOf('if (current.meta.lockedAt) return lockedResponse(');
    assert.ok(lockCheck > 0, 'PUT checks the lock');
    assert.ok(lockCheck < put.indexOf('current.meta.version !== expectedVersion'), 'lock before version (the database checks in the same order)');
    assert.ok(lockCheck < put.indexOf("action: 'npd.rows.removed'"), 'a refused save writes no removal audit');
    assert.match(put, /if \(saved\.locked\) \{/, 'a lock that lands between the read and the save is still a 423');
    assert.match(src, /status: 423/);
  });

  test('who locked and who unlocked is the SESSION email', () => {
    assert.match(lockBranch, /lockedBy: authz\.sessionEmail/);
    assert.match(unlockBranch, /unlockedBy: authz\.sessionEmail/);
  });

  test('an unlock is audited WITH ITS REASON first, and refused if that audit fails', () => {
    const audit = unlockBranch.indexOf("action: 'npd.sheet.unlocked'");
    const call = unlockBranch.indexOf('await unlockNpdSheet(');
    assert.ok(audit > 0 && call > audit, 'the unlock audit comes before the unlock');
    const between = unlockBranch.slice(audit, call);
    assert.match(between, /reason: body\.reason/);
    assert.match(between, /if \(audit\.error\) \{\s*return NextResponse\.json\([\s\S]*?status: 500/);
  });

  test('the DB layer reads the lock refusal before the version conflict', () => {
    const db = read('src', 'lib', 'supabase', 'npd-db.ts');
    const save = db.slice(db.indexOf('export async function saveNpdSheet'));
    assert.ok(save.indexOf('npd_sheet_locked') < save.indexOf('npd_version_conflict'));
    assert.match(db, /\.select\('\*'\)/, 'header reads tolerate the lock columns not existing yet');
  });

  test('every action the route writes has an audit family', () => {
    for (const action of ['npd.sheet.saved', 'npd.rows.removed', 'npd.sheet.save_failed', 'npd.sheet.locked', 'npd.sheet.unlocked', 'npd.sheet.unlock_failed']) {
      assert.ok(src.includes(`'${action}'`), `route writes ${action}`);
      assert.equal(familyForAction(action)?.match, 'npd.', `${action} lands in the npd. family`);
    }
  });
});

describe('the Lock in migration', () => {
  const sql = read('references', 'sql', 'alter', '2026-10-01_npd_sheets_lock.sql');

  test('the replaced save function refuses a locked sheet BEFORE the version check, under the row lock', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.npd_save_sheet('), sql.indexOf('create or replace function public.npd_lock_sheet('));
    const forUpdate = fn.indexOf('for update;');
    const lockCheck = fn.indexOf("raise exception 'npd_sheet_locked'");
    const versionCheck = fn.indexOf("raise exception 'npd_version_conflict:%'");
    assert.ok(forUpdate > 0 && forUpdate < lockCheck && lockCheck < versionCheck);
  });

  test('a lock only freezes the version the editor saw, and never an empty sheet', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.npd_lock_sheet('), sql.indexOf('create or replace function public.npd_unlock_sheet('));
    assert.match(fn, /if v_version is distinct from p_expected_version then\s+raise exception 'npd_version_conflict:%'/);
    assert.match(fn, /if v_rows = 0 then\s+raise exception 'npd_sheet_empty'/);
    assert.doesNotMatch(fn, /set version|row_count =/, 'locking changes no version and no rows');
  });

  test('every NPD function is service-role only and pins search_path', () => {
    for (const sig of ['npd_save_sheet(text, date, integer, text, jsonb)', 'npd_lock_sheet(text, date, integer, text)', 'npd_unlock_sheet(text, date, text)']) {
      assert.ok(sql.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), sig);
      assert.ok(sql.includes(`grant execute on function public.${sig} to service_role;`), sig);
    }
    assert.equal((sql.match(/language plpgsql\nset search_path = ''/g) ?? []).length, 3);
    assert.doesNotMatch(sql, /create policy|alter publication/i);
  });

  test('the base create migration is untouched (it is applied; the lock ships as an ALTER)', () => {
    const create = read('references', 'sql', 'create', '2026-10-01_npd_sheets.sql');
    assert.doesNotMatch(create, /locked_at|npd_lock_sheet/);
  });

  test('the apply script points at the ALTER, needs the base tables, and defaults to a dry run', () => {
    const script = read('scripts', 'apply-npd-sheets-lock-migration.mts');
    assert.match(script, /const SQL_RELATIVE = 'references\/sql\/alter\/2026-10-01_npd_sheets_lock\.sql';/);
    assert.match(script, /const dryRun = wantDry \|\| \(!wantVerify && !wantApply\);/);
    assert.match(script, /to_regclass\('public\.npd_sheets'\) IS NOT NULL/);
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
