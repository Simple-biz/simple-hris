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

  test('formulas are recalculated ON THE SERVER before anything is audited or saved', () => {
    const recompute = put.indexOf('recomputeSheet(sheet, parsed.value.rows');
    assert.ok(recompute > 0, 'PUT recalculates the rows it was sent');
    assert.ok(recompute < put.indexOf('removedRows(current.rows, rows)'), 'the removal diff sees the recalculated rows');
    assert.ok(recompute < put.indexOf('await saveNpdSheet('), 'what is stored is the recalculated rows');
    assert.match(put, /usdPerPhp,\s*columnFormulas,\s*\}\);/, 'the rate and column formulas are saved with the rows');
    const get = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function PUT'));
    assert.match(get, /usdPerPhp: r\.meta\.usdPerPhp,\s*columnFormulas: r\.meta\.columnFormulas,/);
  });

  test('the DB layer saves through npd_save_sheet_v2 and names a missing v2 exactly', () => {
    const db = read('src', 'lib', 'supabase', 'npd-db.ts');
    assert.match(db, /supabase\.rpc\('npd_save_sheet_v2'/);
    assert.match(db, /if \(error\.code === 'PGRST202'\) return \{ ok: false, missing: true, error: NPD_FORMULAS_NOT_SET_UP \};/);
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

describe('the formulas migration', () => {
  const sql = read('references', 'sql', 'alter', '2026-10-01_npd_formulas.sql');
  const fn = sql.slice(sql.indexOf('create or replace function public.npd_save_sheet_v2('));

  test('it refuses to run before Lock in, and v2 keeps the lock check before the version check', () => {
    assert.match(sql, /Apply references\/sql\/alter\/2026-10-01_npd_sheets_lock\.sql first/);
    const lockCheck = fn.indexOf("raise exception 'npd_sheet_locked'");
    assert.ok(fn.indexOf('for update;') < lockCheck && lockCheck < fn.indexOf("raise exception 'npd_version_conflict:%'"));
  });

  test('the rate is exact numeric with the pesos-per-dollar guard, and v2 is service-role only', () => {
    assert.match(sql, /add column if not exists usd_per_php numeric;/);
    assert.match(sql, /check \(usd_per_php is null or \(usd_per_php > 0 and usd_per_php < 1\)\)/);
    const sig = 'npd_save_sheet_v2(text, date, integer, text, jsonb, numeric, jsonb)';
    assert.ok(sql.includes(`revoke all on function public.${sig} from public, anon, authenticated;`));
    assert.ok(sql.includes(`grant execute on function public.${sig} to service_role;`));
    assert.match(sql, /language plpgsql\nset search_path = ''/);
    assert.doesNotMatch(sql, /create policy|alter publication|drop function/i, 'the original save function stays for the deploy window');
  });

  test('the apply script defaults to a dry run and refuses --apply before Lock in', () => {
    const script = read('scripts', 'apply-npd-formulas-migration.mts');
    assert.match(script, /const dryRun = wantDry \|\| \(!wantVerify && !wantApply\);/);
    assert.match(script, /Lock in is not applied\. Run scripts\/apply-npd-sheets-lock-migration\.mts --apply first\./);
  });

  test('the engine check against the live Google Sheet stays read-only', () => {
    const script = read('scripts', 'verify-npd-formulas-against-sheet.mts');
    assert.match(script, /spreadsheets\.readonly/);
    assert.doesNotMatch(script, /method:\s*'(POST|PUT|PATCH|DELETE)'/);
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

describe('Google Sheet sync (All Dept Payroll CSV · Hogan Payroll Sync)', () => {
  const route = read('app', 'api', 'accounting', 'npd', 'google-sheet', 'route.ts');

  test('the route is GET only, gated on npd EDIT as its first statement', () => {
    assert.match(
      route,
      /export async function GET\(req: Request\) \{\n\s+const authz = await requireFeatureEdit\('accounting', 'npd'\);\n\s+if \(!authz\.ok\) return deniedResponse\(authz\);/,
    );
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.ok(!route.includes(`export async function ${verb}`), `${verb} is not exported`);
  });

  test('it writes nothing but its audit row: the page saves through PUT /api/accounting/npd', () => {
    for (const write of ['saveNpdSheet', 'lockNpdSheet', 'unlockNpdSheet', '.rpc(', '.from(', '.insert(', '.update(', '.upsert(', '.delete(']) {
      assert.ok(!route.includes(write), `route does not call ${write}`);
    }
    assert.ok(route.includes("action: 'npd.google_sheet.loaded'"));
    assert.equal(familyForAction('npd.google_sheet.loaded')?.match, 'npd.');
  });

  test('the week is the wizard’s live upload, never a calendar fallback, and is checked before the sheet is read', () => {
    const resolve = route.indexOf('await resolveCurrentWeek()');
    const degraded = route.indexOf('wizard.degraded.length > 0');
    const noUpload = route.indexOf('if (!wizard.sourceFile)');
    const sunday = route.indexOf('if (!isSundayIso(wizard.weekStart))');
    const fetchSheet = route.indexOf('await fetchNpdSheetGrids(sheet)');
    assert.ok(resolve > 0 && resolve < degraded && degraded < noUpload && noUpload < sunday && sunday < fetchSheet);
    assert.ok(!/defaultNpdWeek|manilaTodayIso|new Date\(\)/.test(route), 'no calendar week');
  });

  test('the Google Sheet is read with the read-only scope', () => {
    const fetcher = read('src', 'lib', 'google-sheets', 'fetch-npd-sheet.ts');
    assert.match(fetcher, /getServiceAccountAccessToken\('https:\/\/www\.googleapis\.com\/auth\/spreadsheets\.readonly'\)/);
    assert.ok(!/auth\/spreadsheets['"]/.test(fetcher), 'never the read-write scope');
    assert.ok(!/method: '(POST|PUT)'/.test(fetcher));
  });

  test('NPD shows the two buttons to edit grants only, and the hook replaces then saves at once', () => {
    const dash = read('src', 'components', 'npd', 'NpdDashboard.tsx');
    assert.match(dash, /\{canEdit && \(\s*<NpdGoogleSheetSync\s+sheet=\{sheet\}\s+stamp=\{ctl\.syncStamp\}\s+saveFailed=\{[^}]+\}\s+targetOf=\{syncTargetOf\}\s+onApply=\{onSyncApply\}\s+disabled=\{switching\}\s+\/>\s*\)\}/);
    const onApply = dash.slice(dash.indexOf('const onSyncApply'));
    assert.ok(onApply.indexOf('await ctl.flush()') < onApply.indexOf('await switchTo('), 'edits on screen are saved before a sync replaces them');
    const sync = read('src', 'components', 'npd', 'NpdGoogleSheetSync.tsx');
    // Each tab shows only its own button, and a sync fills only the tab it was clicked on (Kane, 2026-10-02).
    assert.match(sync, /\{GOOGLE_SHEET_TABS\[sheet\]\.button\}/);
    assert.match(sync, /onClick=\{\(\) => void run\(sheet\)\}/);
    assert.ok(!sync.includes('NPD_SHEETS.map'), 'never both buttons at once');
    // The bar under the button goes green ONLY on a confirmed save: a new stamp from the server.
    assert.match(sync, /if \(stamp && stamp !== stampAtRunRef\.current && stamp\.sheet === progressKind\) toPhase\('done'\);/);
    assert.equal((sync.match(/toPhase\('done'\)/g) ?? []).length, 1, 'nothing else marks a sync done');
    assert.match(sync, /role=\{bar \? 'progressbar' : undefined\}/);
    // Smooth: the compositor runs the fill (Web Animations on transform); React never writes it.
    assert.match(sync, /el\.animate\(\[\{ transform: `scaleX\(\$\{from\}\)` \}, \{ transform: `scaleX\(\$\{to\}\)` \}\]/);
    assert.ok(!/style=\{\{ transform/.test(sync), 'no React-driven transform on the fill');
    assert.ok(!sync.includes('setInterval'), 'no timer ticks the bar');
    assert.ok(sync.includes('if (target.locked)'), 'a locked week is refused before anything is applied');
    const hook = read('src', 'components', 'npd', 'useNpdSheet.ts');
    const applyImport = hook.slice(hook.indexOf('const applyImport'), hook.indexOf('const importSheet'));
    assert.ok(applyImport.indexOf('if (isLocked(s))') < applyImport.indexOf('pushUndo(s)'));
    assert.ok(applyImport.indexOf('pushUndo(s)') < applyImport.indexOf('void saveNow(s)'), 'one undo step, then saved through the normal save');
  });

  test('ONLY the current week: the route takes no week, and the save refuses a sync for any other week before reading anything', () => {
    assert.ok(!/searchParams\.get\('week'\)/.test(route), 'the sync route never takes a week');
    const put = read('app', 'api', 'accounting', 'npd', 'route.ts');
    const body = put.slice(put.indexOf('export async function PUT'));
    const guard = body.indexOf('if (googleSheetSync) {');
    assert.ok(guard > 0);
    assert.ok(body.indexOf('await resolveCurrentWeek()', guard) > guard);
    assert.match(body.slice(guard, guard + 700), /wizard\.weekStart !== week/);
    assert.ok(guard < body.indexOf('await readNpdSheet(sheet, week)'), 'refused before the sheet is read');
    assert.ok(guard < body.indexOf("action: 'npd.rows.removed'"), 'refused before any audit or write');
  });

  test('the timestamp is written only after a save that landed, by the server, as npd.sheet.synced', () => {
    const put = read('app', 'api', 'accounting', 'npd', 'route.ts');
    const body = put.slice(put.indexOf('export async function PUT'));
    const saved = body.indexOf("action: 'npd.sheet.saved'");
    const synced = body.indexOf("action: 'npd.sheet.synced'");
    assert.ok(body.indexOf('if (!saved.ok)') < saved && saved < synced, 'after the failure branch and the saved audit');
    assert.match(body.slice(synced, synced + 600), /synced_by: authz\.sessionEmail/);
    assert.equal(familyForAction('npd.sheet.synced')?.match, 'npd.');
    const db = read('src', 'lib', 'supabase', 'npd-db.ts');
    assert.match(db, /\.eq\('action', 'npd\.sheet\.synced'\)/);
    assert.match(route, /readLastNpdSyncs\(week\)/);
  });

  test('Hogan Payroll Sync reads the sheet Kane named for HSL, pinned, by gid', () => {
    const fetcher = read('src', 'lib', 'google-sheets', 'fetch-npd-sheet.ts');
    assert.match(fetcher, /export const HSL_SOURCE = \{ spreadsheetId: '1VPPYSF0HFoLRpXiZB3Bjm-277_tO77-gm1xeUs0atX4', gid: 406220700 \} as const;/);
    assert.match(fetcher, /if \(sheet === 'hsl'\) return \{ spreadsheetId: HSL_SOURCE\.spreadsheetId, gid: HSL_SOURCE\.gid \};/);
  });

  test('the wizard’s Initialize Payroll Data no longer carries the All Dept Payroll CSV card', () => {
    const wizard = read('src', 'components', 'PayrollWizard.tsx');
    assert.ok(!wizard.includes('handleRatesSheetSync'));
    assert.ok(!wizard.includes("'/api/cron/sync-rates-from-sheet'"));
    assert.ok(!/<h3[^>]*>\s*All Dept Payroll CSV\s*<\/h3>/.test(wizard));
    // The rates sync it called stays OFF: rates belong to the Payment Catalog.
    assert.match(read('app', 'api', 'cron', 'sync-rates-from-sheet', 'route.ts'), /const RATES_SHEET_SYNC_DISABLED = true;/);
  });
});

describe('NPD cache (Kane, 2026-10-02: "add caching on this please")', () => {
  const hook = read('src', 'components', 'npd', 'useNpdSheet.ts');
  const dash = read('src', 'components', 'npd', 'NpdDashboard.tsx');

  test('a cached copy only PAINTS: the seed never sets the session’s version or saved rows, and the live read always runs', () => {
    const seed = hook.slice(hook.indexOf('const cached = parseNpdSheetPayload(sheet, getTabCache(cacheKey));'), hook.indexOf('void load(s);'));
    assert.ok(seed.length > 0);
    assert.ok(!/s\.meta\s*=|s\.saved\s*=|s\.savedSettings\s*=/.test(seed), 'editable() / lock() / a sync stay blocked on a cached copy');
    assert.match(seed, /setRefreshing\(true\)/);
    assert.ok(hook.indexOf('void load(s);') > hook.indexOf('const cached = parseNpdSheetPayload'), 'the live read follows the seed, unconditionally');
  });

  test('the cache is written from server truth only: after a load, a confirmed save, a confirmed lock', () => {
    const calls = hook.split('writeSheetCache(s);').length - 1;
    assert.equal(calls, 3);
    const load = hook.slice(hook.indexOf('const load = useCallback'), hook.indexOf('useEffect(() => {\n    mountedRef.current = true;\n    if (!week) return;'));
    assert.ok(load.indexOf('writeSheetCache(s);') > load.indexOf('s.savedSettings = s.settings;'));
    const save = hook.slice(hook.indexOf('const saveNow = useCallback'), hook.indexOf('const scheduleSave'));
    assert.ok(save.indexOf('writeSheetCache(s);') > save.indexOf('if (!res.ok) {'), 'only after the failure branches');
    assert.ok(!/setTabCache\(TAB_CACHE_KEYS\.npdSheet\(/.test(hook.replace(/function writeSheetCache[\s\S]*?\n}\n/, '')), 'nothing else writes a sheet');
  });

  test('read-only while refreshing; a failed refresh keeps the copy and says so', () => {
    assert.match(dash, /readOnly=\{readOnly \|\| !!ctl\.conflict \|\| ctl\.locked \|\| ctl\.refreshing\}/);
    assert.match(dash, /const rateEditable = [^;]*!ctl\.refreshing;/);
    assert.match(dash, /ctl\.loadState !== 'ready' \|\| ctl\.refreshing\s*\? 'The sheet is still loading\.'/);
    assert.match(dash, /This sheet could not be refreshed\./);
    // A cached copy is never shown as green "Saved": nothing about it was confirmed this time.
    assert.match(dash, /cachedCopy=\{ctl\.refreshing \? \(ctl\.refreshError \? 'failed' : 'refreshing'\) : null\}/);
    const status = dash.slice(dash.indexOf('function SaveStatus'));
    assert.ok(status.indexOf("cachedCopy === 'failed'") < status.indexOf('<CircleCheck'), 'checked before the green pill');
    const load = hook.slice(hook.indexOf('const load = useCallback'));
    assert.match(load, /if \(silent\) setRefreshError\(message\);/);
  });

  test('never a skip flag on NPD data, and sessionStorage only through the shared store', () => {
    for (const f of [hook, dash, read('src', 'components', 'npd', 'NpdGoogleSheetSync.tsx')]) {
      assert.ok(!/hasFetchedThisSession|markFetchedThisSession|localStorage/.test(f));
    }
  });
});

describe('NPD loading state (Kane, 2026-10-02: "Change the table to be skeleton loading please")', () => {
  test('a loading sheet shows the grid skeleton, with the real columns', () => {
    const dash = read('src', 'components', 'npd', 'NpdDashboard.tsx');
    assert.match(dash, /ctl\.loadState === 'loading' \? \(\s*<NpdSheetSkeleton key=\{sheet\} sheet=\{sheet\} columns=\{columns\} \/>/);
    const sk = read('src', 'components', 'npd', 'NpdSheetSkeleton.tsx');
    assert.match(sk, /import \{ ROW_HEAD_W, SHEET_FONT \} from '\.\/NpdSheetGrid';/, 'the grid’s own dimensions, not a copy');
    assert.match(sk, /role="status"[^>]*aria-busy="true"/);
    assert.match(sk, /animate-pulse motion-reduce:animate-none/);
  });
});
