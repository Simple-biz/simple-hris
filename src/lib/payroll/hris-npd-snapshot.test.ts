import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  compareHrisNpd,
  parseNpdPaste,
  type CompareHrisNpdInput,
  type HrisCompareInput,
} from './hris-npd-compare';
import {
  MAX_SNAPSHOT_ROWS,
  buildHrisNpdSnapshot,
  cleanSnapshotSourceFile,
  parseHrisNpdSaveMeta,
  validateHrisNpdSnapshot,
  type HrisNpdSnapshot,
} from './hris-npd-snapshot';

const FX = 61.52;
const phpFor = (dollars: number) => Math.round(dollars * FX * 100) / 100;

function hris(email: string, php: number, extra: Partial<HrisCompareInput> = {}): HrisCompareInput {
  return { email, name: email.split('@')[0], php, dispatchable: true, excluded: false, ...extra };
}

/**
 * Every kind of row and every left-out reason, from the REAL comparison, at the default 3¢:
 * a 2¢ match (keeps its difference), a $2.00 mismatch, a person on two NPD lines (added),
 * Not in HRIS, Not in NPD, an excluded person NPD lists, a paused-department line, and a
 * refused line.
 */
const PASTE = [
  'Work Email\tName\tUSD',
  'a@simple.biz\tA\t$100.02',
  'b@simple.biz\tB\t$52.00',
  'c@simple.biz\tC\t$7.50',
  'e@simple.biz\tE\t$10.00',
  'e@simple.biz\tE\t$5.00',
  'x@simple.biz\tX\t$40.00',
  'p@simple.biz\tP\t$12.00',
  'q@simple.biz\tQ\t',
  '',
].join('\n');

function input(over: Partial<CompareHrisNpdInput> = {}, paste = PASTE) {
  const parse = parseNpdPaste(paste);
  const comparison = compareHrisNpd({
    hrisRows: [
      hris('A@simple.biz', phpFor(100)),
      hris('b@simple.biz', phpFor(50)),
      hris('d@simple.biz', phpFor(40), { dispatchable: false }),
      hris('e@simple.biz', phpFor(15)),
      hris('x@simple.biz', phpFor(40), { excluded: true }),
    ],
    npdRows: parse.rows,
    fxRate: FX,
    hrisState: 'settled',
    pausedEmails: new Set(['p@simple.biz']),
    ...over,
  });
  return { comparison, parse, pasteText: paste, fxRate: over.fxRate ?? FX };
}

function built(): HrisNpdSnapshot {
  const b = buildHrisNpdSnapshot(input());
  assert.ok(b.ok, b.ok ? '' : b.reason);
  return b.snapshot;
}

/** A deep copy with one change, for the refusal cases. */
function changed(fn: (s: HrisNpdSnapshot & { header: Record<string, unknown>; rows: Array<Record<string, unknown>> }) => void): unknown {
  const s = JSON.parse(JSON.stringify(built()));
  fn(s);
  return s;
}

function refused(raw: unknown, needle: RegExp) {
  const v = validateHrisNpdSnapshot(raw);
  assert.equal(v.ok, false, 'expected a refusal');
  if (!v.ok) assert.ok(v.errors.some((e) => needle.test(e)), `no error matched ${needle}: ${JSON.stringify(v.errors)}`);
}

describe('buildHrisNpdSnapshot', () => {
  test('is the output exactly as shown: every row, its verdict, the left-out list, the refusals, the paste', () => {
    const { comparison, parse } = input();
    const s = built();
    assert.equal(s.rows.length, comparison.rows.length);
    assert.deepEqual(
      s.rows.map((r) => [r.row_no, r.work_email, r.status]),
      [
        [1, 'A@simple.biz', 'match'],
        [2, 'b@simple.biz', 'mismatch'],
        [3, 'c@simple.biz', 'not_in_hris'],
        [4, 'd@simple.biz', 'not_in_npd'],
        [5, 'e@simple.biz', 'match'],
      ],
    );
    const a = s.rows[0];
    assert.equal(a.delta_cents, 2, 'a within-tolerance match keeps its difference');
    assert.deepEqual(s.rows[4].npd_lines, [5, 6], 'a person on two NPD lines: both lines, added');
    assert.equal(s.rows[4].npd_cents, 1500);
    assert.equal(s.rows[3].no_payout_row_count, 1);
    assert.deepEqual(
      s.header.left_out.map((l) => [l.work_email, l.reason, l.npd_cents]),
      [['p@simple.biz', 'paused', 1200], ['x@simple.biz', 'excluded', 4000]],
    );
    assert.equal(s.header.refusal_count, 1);
    assert.equal(s.header.refusals[0].line, 9);
    assert.equal(s.header.npd_lines_read, parse.rows.length);
    assert.equal(s.header.paste_text, PASTE, 'the paste is kept verbatim');
    assert.equal(s.header.tolerance_cents, 3);
    assert.equal(s.header.fx_rate, FX);
    assert.deepEqual(
      [s.header.match_count, s.header.mismatch_count, s.header.not_in_hris_count, s.header.not_in_npd_count],
      [2, 1, 1, 1],
    );
    assert.equal(s.header.hris_total_cents, comparison.totals.hrisCents);
    assert.equal(s.header.npd_total_cents, comparison.totals.npdCents);
  });

  test('carries the operator’s tolerance, and the verdicts it gave', () => {
    const b = buildHrisNpdSnapshot(input({ toleranceCents: 1 }));
    assert.ok(b.ok);
    if (!b.ok) return;
    assert.equal(b.snapshot.header.tolerance_cents, 1);
    assert.equal(b.snapshot.rows[0].status, 'mismatch', 'A is 2¢ off: a mismatch at 1¢');
  });

  test('REFUSES while the verdicts are held — an unjudged output is not a result', () => {
    for (const [over, needle] of [
      [{ hrisState: 'pending' as const }, /still loading/],
      [{ hrisState: 'unavailable' as const }, /failed to load/],
      [{ fxRate: 0 }, /rate is still 0/],
    ] as const) {
      const b = buildHrisNpdSnapshot(input(over));
      assert.equal(b.ok, false);
      if (!b.ok) assert.match(b.reason, needle);
    }
    const empty = buildHrisNpdSnapshot(input({}, ''));
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.match(empty.reason, /readable NPD line/);
  });
});

describe('validateHrisNpdSnapshot', () => {
  test('accepts what the build produced, unchanged, in canonical key order', () => {
    const s = built();
    const v = validateHrisNpdSnapshot(JSON.parse(JSON.stringify(s)));
    assert.ok(v.ok, v.ok ? '' : JSON.stringify(v.errors));
    if (!v.ok) return;
    assert.equal(JSON.stringify(v.snapshot), JSON.stringify(s), 'validation changes nothing');
  });

  test('the same output hashes the same however its keys arrive (the unchanged check depends on it)', () => {
    const s = built();
    const shuffled = JSON.parse(JSON.stringify(s), function (this: unknown, _k, value) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse());
      }
      return value;
    });
    const a = validateHrisNpdSnapshot(s);
    const b = validateHrisNpdSnapshot(shuffled);
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.equal(JSON.stringify(a.snapshot), JSON.stringify(b.snapshot));
  });

  test('refuses a row with no verdict', () => {
    refused(changed((s) => { s.rows[0].status = null as never; }), /status must be one of/);
  });

  test('refuses a verdict that disagrees with the tolerance it was given with', () => {
    refused(changed((s) => { s.header.tolerance_cents = 1; }), /a match must be within 1¢/);
    // B marked a mismatch on a 2¢ gap, at 3¢.
    refused(changed((s) => {
      s.rows[1].npd_cents = 5002;
      s.rows[1].delta_cents = 2;
      s.rows[1].implied_npd_rate = null;
      s.header.npd_total_cents -= 198;
    }), /a mismatch must be more than 3¢ off/);
  });

  test('refuses a difference that is not NPD − HRIS, and figures on the side a row is not on', () => {
    refused(changed((s) => { s.rows[1].delta_cents = 100; }), /NPD − HRIS/);
    refused(changed((s) => { s.rows[2].hris_cents = 5; }), /null on a Not in HRIS row/);
    refused(changed((s) => { s.rows[3].npd_cents = 5; }), /null on a Not in NPD row/);
    refused(changed((s) => { s.rows[3].delta_cents = 0; }), /delta_cents must be null/);
    refused(changed((s) => { s.rows[0].implied_npd_rate = 60; }), /only on a mismatch/);
  });

  test('refuses counts and totals that are not the rows’', () => {
    refused(changed((s) => { s.header.match_count = 3; s.header.mismatch_count = 0; }), /counts are not the rows/);
    refused(changed((s) => { s.header.hris_total_cents = 1; }), /hris_total_cents is not the sum/);
    refused(changed((s) => { s.header.npd_total_cents = 1; }), /npd_total_cents is not the sum/);
    refused(changed((s) => { s.header.left_out_count = 0; }), /left_out_count/);
  });

  test('refuses rows out of order', () => {
    refused(changed((s) => { s.rows[1].row_no = 7; }), /row_no must be 2/);
  });

  test('the NPD side must be EXACTLY the stored paste', () => {
    // A figure that is not the paste's.
    refused(changed((s) => {
      s.rows[2].npd_cents = 800;
      s.header.npd_total_cents += 50;
    }), /not the sum of its paste lines/);
    // A paste line moved onto someone else.
    refused(changed((s) => {
      s.rows[2].npd_lines = [3];
      s.rows[1].npd_lines = [4];
    }), /not this address/);
    // A row dropped from the output (its line is then on no row).
    refused(changed((s) => {
      const gone = s.rows.splice(2, 1)[0];
      s.rows.forEach((r, i) => { r.row_no = i + 1; });
      s.header.not_in_hris_count -= 1;
      s.header.row_count -= 1;
      s.header.npd_total_cents -= gone.npd_cents as number;
    }), /on no row/);
    // A paste edited after the comparison was made.
    refused(changed((s) => { s.header.paste_text = s.header.paste_text.replace('$7.50', '$9.50'); }), /not the sum of its paste lines/);
    // The refusals must be the paste's own.
    refused(changed((s) => { s.header.refusals = []; s.header.refusal_count = 0; }), /refused lines are not the paste/);
    // The same line counted twice.
    refused(changed((s) => {
      s.rows[2].npd_lines = [4, 4];
      s.rows[2].npd_cents = 1500;
      s.header.npd_total_cents += 750;
    }), /counted twice/);
  });

  test('refuses a paused-department person NPD does not list (they were never a row)', () => {
    refused(changed((s) => {
      const p = s.header.left_out.find((l) => l.reason === 'paused')!;
      p.npd_cents = null;
      p.npd_lines = [];
    }), /paused-department person is listed only when NPD lists them/);
  });

  test('refuses an out-of-range tolerance or rate, an empty output, and an oversized one', () => {
    refused(changed((s) => { s.header.tolerance_cents = 100; }), /tolerance_cents/);
    refused(changed((s) => { s.header.tolerance_cents = 2.5; }), /tolerance_cents/);
    refused(changed((s) => { s.header.fx_rate = 0; }), /fx_rate/);
    refused(changed((s) => { s.rows = []; }), /no output to save/);
    refused(changed((s) => { s.rows = Array.from({ length: MAX_SNAPSHOT_ROWS + 1 }, () => s.rows[0]); }), /limited to 5000 rows/);
    refused({ header: null, rows: [] }, /snapshot must be/);
  });
});

describe('cleanSnapshotSourceFile', () => {
  test('a filename-shaped week key, trimmed; nothing else', () => {
    assert.equal(cleanSnapshotSourceFile('  simple-biz_daily_report_2026-09-27_to_2026-10-03.csv '), 'simple-biz_daily_report_2026-09-27_to_2026-10-03.csv');
    assert.equal(cleanSnapshotSourceFile(''), null);
    assert.equal(cleanSnapshotSourceFile('a\nb'), null);
    assert.equal(cleanSnapshotSourceFile('x'.repeat(301)), null);
    assert.equal(cleanSnapshotSourceFile(42), null);
  });
});

describe('parseHrisNpdSaveMeta', () => {
  test('reads the route’s latest save; anything malformed is not a save', () => {
    const ok = {
      id: 'u', version: 2, savedAt: '2026-10-01T15:00:00Z', savedBy: 'a@simple.biz', toleranceCents: 3,
      rowCount: 5, leftOutCount: 2, counts: { match: 2, mismatch: 1, not_in_hris: 1, not_in_npd: 1 },
    };
    assert.deepEqual(parseHrisNpdSaveMeta(ok), ok);
    assert.equal(parseHrisNpdSaveMeta({ ...ok, version: 0 }), null);
    assert.equal(parseHrisNpdSaveMeta({ ...ok, counts: { match: 1 } }), null);
    assert.equal(parseHrisNpdSaveMeta(null), null);
  });
});

// ─── Source guards: the SQL, the route and the wizard agree ──────────────────

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read('references/sql/create/2026-10-01_payroll_wizard_npd_comparisons.sql');

/** Column names declared in one `create table` block of the SQL file. */
function sqlColumns(table: string): Set<string> {
  const start = SQL.indexOf(`create table if not exists public.${table} (`);
  assert.ok(start >= 0, `no create table for ${table}`);
  const body = SQL.slice(start, SQL.indexOf('\n);', start));
  const cols = new Set<string>();
  for (const line of body.split('\n').slice(1)) {
    const m = /^\s{2}([a-z_][a-z0-9_]*)\s+(uuid|text|integer|bigint|numeric|timestamptz|jsonb)\b/.exec(line);
    if (m) cols.add(m[1]);
  }
  return cols;
}

describe('the SQL and the snapshot agree', () => {
  test('every snapshot key is a column (a missing one would be silently NULL in jsonb_populate_record)', () => {
    const s = built();
    const head = sqlColumns('payroll_wizard_npd_comparisons');
    const rows = sqlColumns('payroll_wizard_npd_comparison_rows');
    for (const k of Object.keys(s.header)) assert.ok(head.has(k), `header key ${k} is not a column`);
    for (const k of Object.keys(s.rows[0])) assert.ok(rows.has(k), `row key ${k} is not a column`);
  });

  test('the caps match the save function and the CHECKs', () => {
    assert.match(SQL, new RegExp(`v_n > ${MAX_SNAPSHOT_ROWS}\\b`));
    assert.match(SQL, /tolerance_cents between 0 and 99/);
    assert.match(SQL, /status\s+text not null/);
    assert.match(SQL, /length\(paste_text\) between 1 and 2000000/);
  });

  test('service-role only: RLS on, privileges and EXECUTE revoked, no policy, no realtime', () => {
    assert.match(SQL, /alter table public\.payroll_wizard_npd_comparisons enable row level security/);
    assert.match(SQL, /alter table public\.payroll_wizard_npd_comparison_rows enable row level security/);
    assert.match(SQL, /revoke all on function public\.payroll_wizard_save_npd_comparison\(text, text, text, jsonb\) from public, anon, authenticated/);
    assert.doesNotMatch(SQL, /create policy/i);
    assert.doesNotMatch(SQL, /supabase_realtime add/i);
  });
});

describe('the route', () => {
  const ROUTE = read('app/api/payroll-wizard/npd-comparison/route.ts');

  test('GET is the wizard view grant; POST is the wizard EDIT grant', () => {
    assert.match(ROUTE, /export async function GET[\s\S]*?requireFeatureAccess\('accounting', 'payroll_wizard', 'view'\)/);
    assert.match(ROUTE, /export async function POST[\s\S]*?requireFeatureEdit\('accounting', 'payroll_wizard'\)/);
  });

  test('saved_by is the SESSION email, never the body', () => {
    assert.match(ROUTE, /savedBy: authz\.sessionEmail/);
    assert.doesNotMatch(ROUTE, /body\.(savedBy|saved_by)/);
  });

  test('the snapshot is validated, then hashed as validated, then saved', () => {
    const v = ROUTE.indexOf('validateHrisNpdSnapshot(');
    const h = ROUTE.indexOf("createHash('sha256')");
    const s = ROUTE.indexOf('saveHrisNpdSnapshot(');
    assert.ok(v > 0 && h > v && s > h, 'validate → hash → save');
    assert.match(ROUTE, /JSON\.stringify\(valid\.snapshot\)/);
  });

  test('never reads or writes app_settings (payroll.wizard.* is readable by every signed-in user)', () => {
    assert.doesNotMatch(ROUTE, /app-settings|app_settings/);
  });
});

describe('the wizard', () => {
  const WIZARD = read('src/components/PayrollWizard.tsx');

  test('Save output is refused on a replay (the wizard’s rule: a replay saves nothing)', () => {
    assert.match(WIZARD, /const saveHrisNpdOutput = React\.useCallback\([\s\S]*?if \(!calcSourceFile \|\| isReplay\) return;/);
  });

  test('the snapshot is built from the SAME comparison and parse the table renders', () => {
    assert.match(
      WIZARD,
      /buildHrisNpdSnapshot\(\{\s*comparison: hrisNpdComparison,\s*parse: npdPasteParse,\s*pasteText: npdPasteText,\s*fxRate: usdToPhpRate,?\s*\}\)/,
    );
  });

  test('the save state rides in the ONE panel props object, so step and full screen agree', () => {
    assert.match(WIZARD, /const hrisNpdPanelProps: HrisNpdPanelProps = \{[\s\S]*?save: hrisNpdSaveProps,[\s\S]*?\};/);
  });
});
