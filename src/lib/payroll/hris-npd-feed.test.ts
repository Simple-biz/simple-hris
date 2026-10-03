import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import HrisNpdComparison, {
  type HrisNpdFeedProps,
  type HrisNpdSaveProps,
  type HrisNpdStep,
} from '@/components/payroll/HrisNpdComparison';
import { NPD_COLUMNS, type NpdSheetKind } from '@/lib/npd/columns';
import type { NpdRow } from '@/lib/npd/sheet';
import { compareHrisNpd, parseNpdPaste, type HrisCompareInput } from './hris-npd-compare';
import {
  NPD_FEED_RECHECK_MS,
  bothNpdTabsLocked,
  buildNpdFeedText,
  npdFeedSignature,
  npdFeedTabStatus,
  npdWeekForSourceFile,
  parseKnownVersions,
  parseNpdFeedPayload,
  readNpdFeedSignature,
  type NpdFeedTabStatus,
} from './hris-npd-feed';

// ── HRIS vs NPD fed by NPD's LOCKED sheets (Kane, 2026-10-02) ─────────────────
//
// "once the values from NPD are both locked from ALL DEPT AND HSL - The values from there will
// automatically feed here in the validation step and will show us the mismatch and all those
// people that aren't in each other's list". The feed is a paste built from the two locked
// sheets, so the step's paste contract and every comparison rule apply to it unchanged.

const WEEK = '2026-09-20';
const FX = 61.52;
const phpFor = (dollars: number) => Math.round(dollars * FX * 100) / 100;

let nextId = 0;
function row(sheet: NpdSheetKind, cells: Record<string, string>): NpdRow {
  const cols = NPD_COLUMNS[sheet];
  for (const k of Object.keys(cells)) assert.ok(cols.some((c) => c.key === k), `${sheet} has no ${k}`);
  nextId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    values: cols.map((c) => cells[c.key] ?? ''),
    overrides: [],
    formulas: {},
  };
}
const blank = (sheet: NpdSheetKind) => row(sheet, {});

function feed(all: NpdRow[], hsl: NpdRow[], versions = { all_departments: 3, hsl: 5 }) {
  return buildNpdFeedText({
    week: WEEK,
    sheets: { all_departments: { version: versions.all_departments, rows: all }, hsl: { version: versions.hsl, rows: hsl } },
  });
}

function hris(email: string, php: number): HrisCompareInput {
  return { email, name: email.split('@')[0]!, php, dispatchable: true, excluded: false };
}

describe('the feed text', () => {
  it('starts with a signature naming the week and both versions; the parser skips it as the header', () => {
    const f = feed([row('all_departments', { work_email: 'kaner@simple.biz', php_usd_conversion: '$250.00' })], []);
    const first = f.text.split('\n')[0]!;
    assert.equal(first, `${npdFeedSignature(WEEK, { all_departments: 3, hsl: 5 })}\tWork Email\tPHP USD Conversion`);
    assert.equal(first, 'NPD locked sheets, week 2026-09-20: All Departments v3, HSL v5\tWork Email\tPHP USD Conversion');
    const p = parseNpdPaste(f.text);
    assert.equal(p.headerSkipped, true);
    assert.deepEqual(p.rows.map((r) => [r.email, r.cents]), [['kaner@simple.biz', 25000]]);
    assert.equal(p.refusals.length, 0);
  });

  it('reads ONLY the Work Email and PHP USD Conversion columns — never a name, a personal address or any other figure', () => {
    const f = feed(
      [
        row('all_departments', {
          work_email: 'kaner@simple.biz',
          name: 'Kane R',
          department: 'Accounting',
          total_pay_php: '₱15,380.00',
          php_usd_conversion: '$250.00',
          bank_preferred: 'kane.personal@gmail.com',
        }),
      ],
      [],
    );
    assert.doesNotMatch(f.text, /Kane R|Accounting|15,380|gmail/);
    assert.match(f.text, /\nAll Departments row 1\tkaner@simple\.biz\t\$250\.00$/);
  });

  it('All Departments first, then HSL, each in grid order; a blank row is skipped but still counts as a position', () => {
    const f = feed(
      [
        row('all_departments', { work_email: 'a@simple.biz', php_usd_conversion: '$1.00' }),
        blank('all_departments'),
        row('all_departments', { work_email: 'b@simple.biz', php_usd_conversion: '$2.00' }),
      ],
      [row('hsl', { work_email: 'c@simple.biz', php_usd_conversion: '$3.00' })],
    );
    assert.deepEqual(f.text.split('\n').slice(1).map((l) => l.split('\t')[0]), [
      'All Departments row 1',
      'All Departments row 3',
      'HSL row 1',
    ]);
    assert.deepEqual(f.linesBySheet, { all_departments: 2, hsl: 1 });
  });

  it('a cell can never break a line: a tab or line break inside a cell stays visible and is refused, never half-read', () => {
    const f = feed(
      [
        row('all_departments', { work_email: 'a@simple.biz', php_usd_conversion: '$1\n00' }),
        row('all_departments', { work_email: 'b@simple.biz', php_usd_conversion: '$2\t00' }),
      ],
      [],
    );
    assert.equal(f.text.split('\n').length, 3, 'one line per row, plus the signature');
    const p = parseNpdPaste(f.text);
    // "$1⏎00" must not become $100 (parseUsdCell strips spaces, so a space would have).
    assert.equal(p.rows.length, 0);
    assert.equal(p.refusals.length, 2);
    assert.ok(p.refusals.every((r) => /is not a dollar amount/.test(r.reason)));
  });

  it('counts the rows carrying Total Pay US Workers, which is never compared or added', () => {
    const f = feed(
      [
        row('all_departments', { work_email: 'us@simple.biz', php_usd_conversion: '$0.00', total_pay_us_workers: '$4,275.00' }),
        row('all_departments', { work_email: 'ph@simple.biz', php_usd_conversion: '$250.00' }),
      ],
      [],
    );
    assert.equal(f.usWorkersRows, 1);
    assert.doesNotMatch(f.text, /4,275/);
    const p = parseNpdPaste(f.text);
    assert.deepEqual(p.rows.map((r) => [r.email, r.cents]), [['us@simple.biz', 0], ['ph@simple.biz', 25000]]);
  });
});

describe('the paste contract applies to the feed word for word', () => {
  const f = feed(
    [
      row('all_departments', { work_email: 'ok@simple.biz', php_usd_conversion: '$1,234.56' }),
      row('all_departments', { work_email: '', php_usd_conversion: '$114.92' }),
      row('all_departments', { work_email: 'norate@simple.biz', php_usd_conversion: '' }),
      row('all_departments', { work_email: 'err@simple.biz', php_usd_conversion: '#VALUE!' }),
      row('all_departments', { work_email: 'peso@simple.biz', php_usd_conversion: '₱1,000.00' }),
      row('all_departments', { work_email: 'neg@simple.biz', php_usd_conversion: '-$5.50' }),
    ],
    [],
  );
  const p = parseNpdPaste(f.text);

  it('reads the good rows, negatives included', () => {
    assert.deepEqual(p.rows.map((r) => [r.email, r.cents]), [['ok@simple.biz', 123456], ['neg@simple.biz', -550]]);
  });

  it('refuses every other row, each listed with its NPD tab and row in the raw line', () => {
    const byRaw = new Map(p.refusals.map((r) => [r.raw.split('\t')[0], r.reason]));
    assert.match(byRaw.get('All Departments row 2')!, /No work email on this line/);
    assert.match(byRaw.get('All Departments row 3')!, /No dollar amount in column 3/);
    assert.match(byRaw.get('All Departments row 4')!, /"#VALUE!" is not a dollar amount/);
    assert.match(byRaw.get('All Departments row 5')!, /looks like pesos/);
    assert.equal(p.refusals.length, 4);
  });
});

describe('the comparison on a feed: mismatches, and everyone not in the other list', () => {
  it('a person on both tabs is ADDED; missing sides are labelled; nobody is dropped', () => {
    const f = feed(
      [
        row('all_departments', { work_email: 'Moved@simple.biz', php_usd_conversion: '$100.00' }),
        row('all_departments', { work_email: 'match@simple.biz', php_usd_conversion: '$250.00' }),
        row('all_departments', { work_email: 'npdonly@simple.biz', php_usd_conversion: '$12.00' }),
      ],
      [
        row('hsl', { work_email: 'moved@simple.biz', php_usd_conversion: '$50.00' }),
        row('hsl', { work_email: 'off@simple.biz', php_usd_conversion: '$279.17' }),
      ],
    );
    const parse = parseNpdPaste(f.text);
    const c = compareHrisNpd({
      hrisRows: [
        hris('moved@simple.biz', phpFor(150)),
        hris('match@simple.biz', phpFor(250)),
        hris('off@simple.biz', phpFor(276.49)),
        hris('hrisonly@simple.biz', phpFor(40)),
      ],
      npdRows: parse.rows,
      fxRate: FX,
      hrisState: 'settled',
    });
    const by = new Map(c.rows.map((r) => [r.workEmail.toLowerCase(), r]));
    assert.equal(by.get('moved@simple.biz')!.status, 'match');
    assert.equal(by.get('moved@simple.biz')!.npdCents, 15000);
    assert.equal(by.get('moved@simple.biz')!.npdLines.length, 2);
    assert.equal(by.get('match@simple.biz')!.status, 'match');
    assert.equal(by.get('off@simple.biz')!.status, 'mismatch');
    assert.equal(by.get('npdonly@simple.biz')!.status, 'not_in_hris');
    assert.equal(by.get('hrisonly@simple.biz')!.status, 'not_in_npd');
    assert.deepEqual(c.counts, { match: 2, mismatch: 1, not_in_hris: 1, not_in_npd: 1 });
  });
});

describe('the signature', () => {
  const text = feed([row('all_departments', { work_email: 'a@simple.biz', php_usd_conversion: '$1.00' })], [], {
    all_departments: 12,
    hsl: 7,
  }).text;

  it('a feed names its week and versions', () => {
    assert.deepEqual(readNpdFeedSignature(text), { kind: 'feed', week: WEEK, versions: { all_departments: 12, hsl: 7 } });
  });

  it('an ordinary paste is a paste', () => {
    assert.deepEqual(readNpdFeedSignature('kaner@simple.biz\t250.00'), { kind: 'paste' });
    assert.deepEqual(readNpdFeedSignature('Work Email\tUSD\nkaner@simple.biz\t250.00'), { kind: 'paste' });
  });

  it('anything that starts like a feed but is not one exactly is malformed, never a paste', () => {
    assert.equal(readNpdFeedSignature(text.replace('HSL v7', 'HSL vX')).kind, 'malformed');
    assert.equal(readNpdFeedSignature(text.replace('2026-09-20', '2026-09-21')).kind, 'malformed'); // not a Sunday
    assert.equal(readNpdFeedSignature(text.replace('\tWork Email', '\tEmail')).kind, 'malformed');
  });
});

describe('the NPD week of a wizard week', () => {
  it("is the filename range's start, when it is a Sunday", () => {
    assert.deepEqual(npdWeekForSourceFile('simple-biz_daily_report_2026-09-20_to_2026-09-26.csv'), { ok: true, week: '2026-09-20' });
  });
  it('is refused — never guessed — when the range starts on another day, or there is no range', () => {
    assert.equal(npdWeekForSourceFile('report_2026-09-21_to_2026-09-27.csv').ok, false);
    assert.equal(npdWeekForSourceFile('report.csv').ok, false);
  });
});

describe('lock state', () => {
  const meta = (over: Partial<Parameters<typeof npdFeedTabStatus>[0]> = {}) =>
    npdFeedTabStatus({ sheetId: 'x', version: 2, rowCount: 10, updatedAt: null, updatedBy: null, lockedAt: null, lockedBy: null, ...over });

  it('none / unlocked / locked', () => {
    assert.deepEqual(npdFeedTabStatus({ sheetId: null, version: 0, rowCount: 0, updatedAt: null, updatedBy: null, lockedAt: null, lockedBy: null }), { state: 'none' });
    assert.deepEqual(meta({ rowCount: 0 }), { state: 'none' });
    assert.equal(meta().state, 'unlocked');
    assert.deepEqual(meta({ lockedAt: '2026-10-02T19:00:00Z', lockedBy: 'a@simple.biz' }), {
      state: 'locked',
      version: 2,
      rowCount: 10,
      lockedAt: '2026-10-02T19:00:00Z',
      lockedBy: 'a@simple.biz',
    });
  });

  it('the feed needs BOTH tabs locked — one is not enough', () => {
    const locked: NpdFeedTabStatus = { state: 'locked', version: 1, rowCount: 1, lockedAt: 'x', lockedBy: null };
    const open: NpdFeedTabStatus = { state: 'unlocked', version: 1, rowCount: 1, updatedAt: null, updatedBy: null };
    assert.equal(bothNpdTabsLocked({ all_departments: locked, hsl: locked }), true);
    assert.equal(bothNpdTabsLocked({ all_departments: locked, hsl: open }), false);
    assert.equal(bothNpdTabsLocked({ all_departments: { state: 'none' }, hsl: locked }), false);
  });
});

describe("the route's reply, as the browser reads it", () => {
  const lockedTab = (version: number) => ({ state: 'locked', version, rowCount: 2, lockedAt: '2026-10-02T19:00:00Z', lockedBy: 'a@simple.biz' });
  const f = feed([row('all_departments', { work_email: 'a@simple.biz', php_usd_conversion: '$1.00' })], [row('hsl', { work_email: 'b@simple.biz', php_usd_conversion: '$2.00' })]);
  const good = { week: WEEK, tabs: { all_departments: lockedTab(3), hsl: lockedTab(5) }, feed: { versions: { all_departments: 3, hsl: 5 }, ...f } };

  it('a locked week with its feed', () => {
    const p = parseNpdFeedPayload(JSON.parse(JSON.stringify(good)));
    assert.ok(p && p.feed && p.feed !== 'unchanged');
    assert.equal(p.feed.text, f.text);
  });

  it('a week that is not locked carries no feed', () => {
    const p = parseNpdFeedPayload({ week: WEEK, tabs: { all_departments: lockedTab(3), hsl: { state: 'none' } }, feed: null });
    assert.ok(p);
    assert.equal(p.feed, null);
  });

  it('anything inconsistent is NOT a reply (an error on the step, never "not locked")', () => {
    // A feed while a tab is not locked.
    assert.equal(parseNpdFeedPayload({ ...good, tabs: { ...good.tabs, hsl: { state: 'none' } } }), null);
    // No feed while both are locked.
    assert.equal(parseNpdFeedPayload({ ...good, feed: null }), null);
    // The text names other versions than the reply.
    assert.equal(parseNpdFeedPayload({ ...good, feed: { ...good.feed, versions: { all_departments: 4, hsl: 5 } } }), null);
    // The tabs' versions are not the feed's.
    assert.equal(parseNpdFeedPayload({ ...good, tabs: { ...good.tabs, hsl: lockedTab(6) } }), null);
    // Another week's feed.
    assert.equal(parseNpdFeedPayload({ ...good, week: '2026-09-27' }), null);
    assert.equal(parseNpdFeedPayload({ ...good, tabs: { all_departments: { state: 'what' }, hsl: lockedTab(5) } }), null);
    assert.equal(parseNpdFeedPayload(null), null);
  });

  it('"unchanged" only when both are locked', () => {
    assert.equal(parseNpdFeedPayload({ ...good, feed: 'unchanged' })?.feed, 'unchanged');
    assert.equal(parseNpdFeedPayload({ ...good, tabs: { ...good.tabs, hsl: { state: 'none' } }, feed: 'unchanged' }), null);
  });

  it('known versions', () => {
    assert.deepEqual(parseKnownVersions('3,5'), { all_departments: 3, hsl: 5 });
    assert.equal(parseKnownVersions('3'), null);
    assert.equal(parseKnownVersions(null), null);
  });
});

// ─── Source guards ───────────────────────────────────────────────────────────

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

describe('the feed route', () => {
  const ROUTE = read('app/api/payroll-wizard/npd-feed/route.ts');

  it('needs BOTH grants: the wizard (the tab) AND NPD (the rows)', () => {
    const w = ROUTE.indexOf("requireFeatureAccess('accounting', 'payroll_wizard', 'view')");
    const n = ROUTE.indexOf("requireFeatureAccess('accounting', 'npd', 'view')");
    const work = ROUTE.indexOf('readNpdSheetMeta(');
    assert.ok(w > 0 && n > w && work > n, 'both gates, before any read');
    assert.match(ROUTE, /needsGrant: true/);
  });

  it('is read-only: no write, no audit, no settings store, no browser client', () => {
    assert.doesNotMatch(ROUTE, /export async function (POST|PUT|PATCH|DELETE)/);
    assert.doesNotMatch(ROUTE, /\.(insert|upsert|update|delete|rpc)\(|insertAuditLog|saveNpdSheet|lockNpdSheet/);
    assert.doesNotMatch(ROUTE, /app-settings|app_settings|getSupabaseBrowserClient/);
  });

  it("never reads an unlocked sheet's rows: the rows are read only after both headers say locked, and re-checked", () => {
    const gate = ROUTE.indexOf('if (!bothNpdTabsLocked(headTabs))');
    const rows = ROUTE.indexOf('readNpdSheet(s, week)');
    const recheck = ROUTE.indexOf('if (!bothNpdTabsLocked(tabs))');
    const build = ROUTE.indexOf('buildNpdFeedText(');
    assert.ok(gate > 0 && rows > gate && recheck > rows && build > recheck);
  });

  it('a failed read is an error, never "not locked" or an empty NPD', () => {
    assert.match(ROUTE, /for \(const m of metas\) if \(!m\.ok\) return failed\(m\);/);
    assert.match(ROUTE, /for \(const r of sheets\) if \(!r\.ok\) return failed\(r\);/);
  });

  it('resolves the NPD week from the wizard week, with no calendar fallback', () => {
    assert.match(ROUTE, /npdWeekForSourceFile\(sourceFile\)/);
    assert.doesNotMatch(ROUTE, /resolveCurrentWeek|new Date\(/);
  });
});

describe('Save output proves a feed against the locked sheets', () => {
  const ROUTE = read('app/api/payroll-wizard/npd-comparison/route.ts');

  it('after validation, before the hash and the save', () => {
    const v = ROUTE.indexOf('validateHrisNpdSnapshot(body.snapshot)');
    const p = ROUTE.indexOf('proveNpdSource(sourceFile, valid.snapshot.header.paste_text)');
    const h = ROUTE.indexOf("createHash('sha256')");
    const s = ROUTE.indexOf('saveHrisNpdSnapshot(');
    assert.ok(v > 0 && p > v && h > p && s > h);
  });

  it('refuses when NPD changed (409 npdChanged), when the text is not what the sheets say, and on a failed read', () => {
    assert.match(ROUTE, /if \(!r\.meta\.lockedAt\) changed\.push/);
    assert.match(ROUTE, /r\.meta\.version !== sig\.versions\[s\]/);
    assert.match(ROUTE, /npdChanged: true/);
    assert.match(ROUTE, /if \(rebuilt\.text !== pasteText\)/);
    assert.match(ROUTE, /if \(sig\.kind === 'malformed'\)/);
    assert.match(ROUTE, /wk\.week !== sig\.week/);
  });
});

describe('the wizard', () => {
  const WIZARD = read('src/components/PayrollWizard.tsx');

  it('reads NPD only through the route — never a client-side Supabase read of NPD tables', () => {
    assert.match(WIZARD, /fetch\(`\/api\/payroll-wizard\/npd-feed\?sourceFile=/);
    assert.doesNotMatch(WIZARD, /npd_sheets|npd_all_departments_rows|npd_hsl_rows/);
  });

  it('only the newest check lands, and a failed RE-check keeps what was read', () => {
    assert.match(WIZARD, /if \(seq !== npdFeedSeq\.current\) return;/);
    assert.match(WIZARD, /if \(prev\.view\.state === 'ready'\) return \{ \.\.\.prev, refreshing: false, lastError: message \};/);
  });

  it('checks on every week change, and once a minute only while the tab is open and visible', () => {
    assert.match(WIZARD, /const hrisNpdOpen = currentStep === 7 && validationSection === 'hris_vs_npd';/);
    assert.match(WIZARD, /window\.setInterval\(recheck, NPD_FEED_RECHECK_MS\)/);
    assert.match(WIZARD, /if \(document\.visibilityState === 'visible'\) loadNpdFeed/);
    assert.ok(NPD_FEED_RECHECK_MS >= 30_000, 'not a hammer');
  });

  it("the locked sheets' text is used only while the reply says BOTH are locked, for THIS week", () => {
    assert.match(WIZARD, /const npdFeedText = npdFeedForThisWeek && npdFeedView\.state === 'ready' && npdFeedView\.feed \? npdFeed\.text : null;/);
    assert.match(WIZARD, /const npdFeedForThisWeek = calcSourceFile != null && npdFeed\.sourceFile === calcSourceFile;/);
  });

  it('a save refused because NPD changed reads NPD again', () => {
    assert.match(WIZARD, /if \(res\.status === 409 && out\.npdChanged\) loadNpdFeed\(file, \{ useKnown: false \}\);/);
  });
});

// ─── Rendered ────────────────────────────────────────────────────────────────

const NOT_SAVED: HrisNpdSaveProps = {
  latest: { state: 'ready', meta: null },
  disabledReason: null,
  saving: false,
  savedThisOutput: false,
  onSave: () => {},
};

const LOCKED_TABS = {
  all_departments: { state: 'locked', version: 3, rowCount: 3, lockedAt: '2026-10-02T19:00:00Z', lockedBy: 'aliviah@simple.biz' },
  hsl: { state: 'locked', version: 5, rowCount: 1, lockedAt: '2026-10-02T19:05:00Z', lockedBy: 'aliviah@simple.biz' },
} as const;

function renderFeed(text: string, feedProps: HrisNpdFeedProps, step: HrisNpdStep, pasteText = ''): string {
  const parse = parseNpdPaste(text);
  const comparison = compareHrisNpd({
    hrisRows: [hris('kaner@simple.biz', phpFor(250))],
    npdRows: parse.rows,
    fxRate: FX,
    hrisState: 'settled',
  });
  return renderToStaticMarkup(
    React.createElement(HrisNpdComparison, {
      pasteText,
      onPasteChange: () => {},
      parse,
      npdFeed: feedProps,
      comparison,
      fxRate: FX,
      hrisPeople: 1,
      periodLabel: 'hubstaff_2026-09-20_to_2026-09-26.csv',
      step,
      onStepChange: () => {},
      toleranceCents: comparison.toleranceCents,
      onToleranceChange: () => {},
      search: '',
      onSearchChange: () => {},
      filter: 'all',
      onFilterChange: () => {},
      save: NOT_SAVED,
    }),
  );
}

describe('rendered: NPD Figures fed by the locked sheets', () => {
  const f = feed(
    [
      row('all_departments', { work_email: 'kaner@simple.biz', php_usd_conversion: '$250.00' }),
      row('all_departments', { work_email: '', php_usd_conversion: '$114.92' }),
      row('all_departments', { work_email: 'us@simple.biz', php_usd_conversion: '$0.00', total_pay_us_workers: '$4,275.00' }),
    ],
    [row('hsl', { work_email: 'npdonly@simple.biz', php_usd_conversion: '$12.00' })],
  );
  const active: HrisNpdFeedProps = {
    view: { state: 'ready', week: WEEK, tabs: { ...LOCKED_TABS }, feed: { versions: { all_departments: 3, hsl: 5 }, linesBySheet: f.linesBySheet, usWorkersRows: f.usWorkersRows } },
    refreshing: false,
    lastError: null,
    checkedAt: null,
    onRefresh: () => {},
  };

  it('step 1 shows what was read from each locked tab — and no paste box', () => {
    const html = renderFeed(f.text, active, 'input', 'a stale paste@simple.biz\t1.00');
    assert.doesNotMatch(html, /<textarea/);
    assert.match(html, /from NPD’s locked sheets/);
    assert.match(html, /All Departments[\s\S]*?v3[\s\S]*?locked by aliviah@simple\.biz/);
    assert.match(html, /HSL[\s\S]*?v5/);
    assert.match(html, /3 rows read/);
    assert.match(html, /1 skipped/);
    assert.match(html, /Unlock a tab in Accounting → NPD to go back to pasting/);
  });

  it('a refused NPD row is listed with its tab and row', () => {
    const html = renderFeed(f.text, active, 'input');
    assert.match(html, /No work email on this line[\s\S]*?All Departments row 2/);
  });

  it('says Total Pay US Workers is not compared, with the count', () => {
    const html = renderFeed(f.text, active, 'input');
    assert.match(html, /1 NPD row also has <strong[^>]*>Total Pay US Workers<\/strong> filled/);
  });

  it('the output names its source on the rail: NPD locked sheets, rows read, View', () => {
    const html = renderFeed(f.text, active, 'output');
    assert.match(html, /NPD locked sheets · 3 rows read/);
    assert.match(html, />View</);
    assert.match(html, /npdonly@simple\.biz[\s\S]*?Not in HRIS/);
  });

  it('a failed re-check keeps the figures and says so', () => {
    const html = renderFeed(f.text, { ...active, lastError: 'HTTP 500.' }, 'input');
    assert.match(html, /Couldn&#x27;t re-check NPD just now \(HTTP 500\.\)/);
    assert.match(html, /3 rows read/);
  });
});

describe('rendered: NPD Figures while NPD is NOT both locked (the paste is the input)', () => {
  it('names each tab’s lock state above the paste box, and says the figures load on their own once both are locked', () => {
    const html = renderFeed(
      '',
      {
        view: { state: 'ready', week: WEEK, tabs: { all_departments: { state: 'unlocked', version: 2, rowCount: 527, updatedAt: null, updatedBy: null }, hsl: LOCKED_TABS.hsl }, feed: null },
        refreshing: false,
        lastError: null,
        checkedAt: null,
        onRefresh: () => {},
      },
      'input',
    );
    assert.match(html, /<textarea/);
    assert.match(html, /All Departments <span>not locked yet<\/span>/);
    assert.match(html, /HSL <span[^>]*>locked by aliviah@simple\.biz/);
    assert.match(html, /Once both are locked in, their figures load here on their own/);
  });

  it('without the NPD grant: a neutral note, and the paste box', () => {
    const html = renderFeed('', { view: { state: 'error', message: 'Reading NPD’s locked sheets needs the NPD grant.', needsGrant: true }, refreshing: false, lastError: null, checkedAt: null, onRefresh: () => {} }, 'input');
    assert.match(html, /needs the NPD grant/);
    assert.doesNotMatch(html, /amber/);
    assert.match(html, /<textarea/);
  });

  it('a failed check is an amber error with Try again — never "not locked"', () => {
    const html = renderFeed('', { view: { state: 'error', message: 'HTTP 500.', needsGrant: false }, refreshing: false, lastError: null, checkedAt: null, onRefresh: () => {} }, 'input');
    assert.match(html, /Couldn&#x27;t check NPD&#x27;s locked sheets: HTTP 500\./);
    assert.match(html, /Try again/);
    assert.doesNotMatch(html, /not locked yet/);
  });
});
