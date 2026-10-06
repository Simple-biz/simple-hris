/**
 * buildHrisNpdCsv — HRIS vs NPD → Export CSV (Kane, 2026-10-06).
 *
 * What these pin (docs/features/payroll-wizard-hris-vs-npd.md § Export CSV):
 *  - EVERY row of the output is in the file, the not-paid rows included. There is no filter
 *    input at all, so the search and the chips cannot narrow it
 *  - verdicts, counts and totals are the comparison's, copied, never recomputed
 *  - not-paid rows carry the reason in Match and never enter the totals
 *  - no file while the verdicts are held
 *  - money is written from integer cents, exactly
 *  - formula injection is neutralised on text, never on numbers
 *  - every refused NPD line is listed
 *
 * Run:  node --import tsx --test src/lib/payroll/hris-npd-export.test.ts
 */
import { describe, it } from 'node:test';
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
  HRIS_NPD_EXPORT_HEADER,
  buildHrisNpdCsv,
  centsCell,
  hrisNpdExportBlockedReason,
  hrisNpdExportFilename,
  type HrisNpdExportSource,
} from './hris-npd-export';

const FX = 61.52;
const phpFor = (dollars: number) => Math.round(dollars * FX * 100) / 100;
const NOW = new Date(2026, 9, 6, 14, 32, 5);
const WEEK = 'hubstaff_2026-09-20_to_2026-09-26.csv';

function hris(email: string, php: number, over: Partial<HrisCompareInput> = {}): HrisCompareInput {
  return { email, name: email.split('@')[0], php, dispatchable: true, excluded: false, ...over };
}

const PASTE = [
  'Work Email\tUSD',
  'kaner@simple.biz\t250.00',
  'lorar@simple.biz\t281.00',
  'npdonly@simple.biz\t12.00',
  'paused@simple.biz\t9.50',
  'nobody-here\t5.00',
  'bad@simple.biz\t#N/A',
].join('\n');

function setup(over: Partial<CompareHrisNpdInput> = {}, paste = PASTE) {
  const parse = parseNpdPaste(paste);
  const comparison = compareHrisNpd({
    hrisRows: [
      hris('kaner@simple.biz', phpFor(250)),
      hris('lorar@simple.biz', phpFor(279.17)),
      hris('hrisonly@simple.biz', phpFor(40)),
      hris('xena@simple.biz', phpFor(5), { excluded: true, name: 'Xena' }),
    ],
    npdRows: parse.rows,
    fxRate: FX,
    hrisState: 'settled',
    pausedEmails: new Set(['paused@simple.biz']),
    ...over,
  });
  return { parse, comparison };
}

function build(over: Partial<CompareHrisNpdInput> = {}, source: HrisNpdExportSource = { kind: 'paste' }) {
  const { parse, comparison } = setup(over);
  return { parse, comparison, out: buildHrisNpdCsv({ comparison, parse, fxRate: over.fxRate ?? FX, periodLabel: WEEK, source, now: NOW }) };
}

/** The body: the lines from the header row to the line before the TOTAL row. */
function body(csv: string): string[] {
  const lines = csv.split('\r\n');
  const h = lines.indexOf(HRIS_NPD_EXPORT_HEADER.join(','));
  assert.ok(h >= 0, 'no header row');
  const t = lines.findIndex((l, i) => i > h && l.startsWith('TOTAL'));
  assert.ok(t > h, 'no TOTAL row');
  return lines.slice(h + 1, t);
}

function lineFor(csv: string, email: string): string[] {
  const hit = body(csv).find((l) => l.startsWith(email + ','));
  assert.ok(hit, `no line for ${email}`);
  return hit!.split(',');
}

describe('HRIS vs NPD export — every row, as the comparison decided it', () => {
  it('has one line per compared row, and nothing else', () => {
    const { comparison, out } = build();
    assert.ok(out.ok);
    const rows = body(out.csv);
    assert.equal(rows.length, comparison.rows.length);
    for (const r of comparison.rows) assert.ok(rows.some((l) => l.startsWith(r.workEmail + ',')), r.workEmail);
  });

  it('takes no filter: the builder has no search or chip input to narrow it', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/payroll/hris-npd-export.ts'), 'utf8');
    assert.doesNotMatch(src, /filterHrisNpd/);
    const sig = src.slice(src.indexOf('export function buildHrisNpdCsv(input: {'));
    const params = sig.slice(0, sig.indexOf('}): '));
    assert.ok(params.length > 0, 'buildHrisNpdCsv signature not found');
    assert.doesNotMatch(params, /needle|search|filter|visible/i);
    assert.match(sig, /comparison\.rows\.map\(/);
  });

  it('writes each verdict and figure exactly as compared', () => {
    const { out } = build();
    assert.ok(out.ok);
    const k = lineFor(out.csv, 'kaner@simple.biz');
    assert.equal(k[2], 'Match');
    assert.equal(k[3], '250.00');
    assert.equal(k[4], '250.00');
    assert.equal(k[5], '0.00');

    const l = lineFor(out.csv, 'lorar@simple.biz');
    assert.equal(l[2], 'Mismatch');
    assert.equal(l[3], '279.17');
    assert.equal(l[4], '281.00');
    assert.equal(l[5], '1.83', 'Difference is NPD − HRIS');
    assert.match(l.slice(9).join(','), /implies PHP/);

    assert.equal(lineFor(out.csv, 'npdonly@simple.biz')[2], 'Not in HRIS');
    const h = lineFor(out.csv, 'hrisonly@simple.biz');
    assert.equal(h[2], 'Not in NPD');
    assert.equal(h[4], '', 'NPD has no figure for them');
  });

  it('leaves out people configured not to be paid (Kane, 2026-10-06), and says how many', () => {
    const { comparison, out } = build();
    assert.ok(out.ok);
    assert.equal(comparison.leftOut.length, 2, 'fixture: one excluded, one paused');
    // Not a line anywhere in the file: not the body, not the notes.
    assert.ok(!out.csv.includes('xena@simple.biz'), 'excluded on Final Pay');
    assert.ok(!out.csv.includes('paused@simple.biz'), 'department paused');
    assert.doesNotMatch(out.csv, /Not paid ·/);
    assert.match(
      out.csv,
      /Left out, not paid this week: 2 \(1 excluded on Final Pay · 1 in a department paused in Step 1 → Configuration\)\. NPD lists 1 of them\./,
    );
  });

  it("foots to the comparison's own totals and counts — never the not-paid rows", () => {
    const { comparison, out } = build();
    assert.ok(out.ok);
    const lines = out.csv.split('\r\n');
    const total = lines.find((l) => l.startsWith('TOTAL'))!.split(',');
    assert.equal(total[0], `TOTAL - ${comparison.totals.people} people`);
    assert.equal(total[1], '');
    assert.equal(total[3], centsCell(comparison.totals.hrisCents));
    assert.equal(total[4], centsCell(comparison.totals.npdCents));
    assert.equal(total[5], centsCell(comparison.totals.npdCents - comparison.totals.hrisCents!));
    // The paused person's $9.50 is NOT in the NPD total.
    assert.equal(comparison.totals.npdCents, 25000 + 28100 + 1200);
    const c = comparison.counts!;
    assert.ok(lines.includes(`Match,${c.match}`));
    assert.ok(lines.includes(`Mismatch,${c.mismatch}`));
    assert.ok(lines.includes(`Not in HRIS,${c.not_in_hris}`));
    assert.ok(lines.includes(`Not in NPD,${c.not_in_npd}`));
    assert.ok(lines.includes('Left out - not paid this week,2'));
  });

  it('a within-tolerance match keeps its difference and says why it is a match', () => {
    const { out } = build({ hrisRows: [hris('kaner@simple.biz', phpFor(249.98))] });
    assert.ok(out.ok);
    const k = lineFor(out.csv, 'kaner@simple.biz');
    assert.equal(k[2], 'Match');
    assert.equal(k[5], '0.02');
    assert.match(k.slice(9).join(','), /Within the off-by setting/);
    assert.match(out.csv, /off by at most 3 cents/);
  });

  it('notes the no-payout and excluded-row tags the screen shows', () => {
    const { out } = build({
      hrisRows: [
        hris('kaner@simple.biz', phpFor(250), { dispatchable: false }),
        hris('kaner@simple.biz', phpFor(10), { excluded: true }),
      ],
    });
    assert.ok(out.ok);
    const notes = lineFor(out.csv, 'kaner@simple.biz').slice(9).join(',');
    assert.match(notes, /No payout this week/);
    assert.match(notes, /1 excluded row not counted/);
  });
});

describe('HRIS vs NPD export — no file while the verdicts are held', () => {
  it('refuses while loading, on a failed source, and at FX 0, with the shared reason', () => {
    for (const over of [
      { hrisState: 'pending' as const },
      { hrisState: 'unavailable' as const, unavailableSources: ['additions' as const] },
      { fxRate: 0 },
    ]) {
      const { comparison, out } = build(over);
      assert.equal(out.ok, false, JSON.stringify(over));
      assert.equal(out.ok ? null : out.reason, hrisNpdExportBlockedReason(comparison));
    }
  });

  it('refuses with nothing read', () => {
    const parse = parseNpdPaste('');
    const comparison = compareHrisNpd({ hrisRows: [hris('a@simple.biz', 100)], npdRows: parse.rows, fxRate: FX, hrisState: 'settled' });
    assert.ok(hrisNpdExportBlockedReason(comparison));
    assert.equal(buildHrisNpdCsv({ comparison, parse, fxRate: FX, periodLabel: WEEK, source: { kind: 'paste' }, now: NOW }).ok, false);
  });

  it('is open on a judged output', () => {
    const { comparison } = setup();
    assert.equal(hrisNpdExportBlockedReason(comparison), null);
  });
});

describe('HRIS vs NPD export — cells', () => {
  it('writes money from integer cents, exactly', () => {
    assert.equal(centsCell(0), '0.00');
    assert.equal(centsCell(5), '0.05');
    assert.equal(centsCell(100), '1.00');
    assert.equal(centsCell(100500), '1005.00');
    assert.equal(centsCell(-268), '-2.68');
    assert.equal(centsCell(-7), '-0.07');
    assert.equal(centsCell(null), '');
    assert.equal(centsCell(1.5), '', 'a non-integer is not a cents figure');
  });

  it('neutralises a formula in text, never a negative number', () => {
    const paste = ['=cmd@evil.com\t1.00', 'kaner@simple.biz\t249.00', '@SUM(A1)\t2.00'].join('\n');
    const parse = parseNpdPaste(paste);
    const comparison = compareHrisNpd({
      hrisRows: [hris('kaner@simple.biz', phpFor(250), { name: '+Kane' })],
      npdRows: parse.rows,
      fxRate: FX,
      hrisState: 'settled',
    });
    const out = buildHrisNpdCsv({ comparison, parse, fxRate: FX, periodLabel: WEEK, source: { kind: 'paste' }, now: NOW });
    assert.ok(out.ok);
    const k = lineFor(out.csv, 'kaner@simple.biz');
    assert.equal(k[1], "'+Kane");
    assert.equal(k[5], '-1.00', 'a negative difference is a number, not a formula');
    // An NPD address as pasted is a row (Not in HRIS), and a refused line's raw text is listed:
    // both are text, both neutralised.
    assert.equal(lineFor(out.csv, "'=cmd@evil.com")[2], 'Not in HRIS');
    assert.match(out.csv, /\r\n\d+,[^\r\n]*,'@SUM\(A1\)/);
    for (const l of out.csv.split('\r\n')) assert.doesNotMatch(l, /^"?[=+@]|,"?[=+@]/, l);
  });

  it('uses CRLF and quotes a cell with a comma', () => {
    const { out } = build({ hrisRows: [hris('kaner@simple.biz', phpFor(250), { name: 'Reroma, Kane' })] });
    assert.ok(out.ok);
    assert.ok(out.csv.endsWith('\r\n'));
    assert.doesNotMatch(out.csv.replace(/\r\n/g, ''), /\n/);
    assert.match(out.csv, /,"Reroma, Kane",/);
  });
});

describe('HRIS vs NPD export — the notes travel with the file', () => {
  it('lists every refused NPD line with its reason and text', () => {
    const { parse, out } = build();
    assert.ok(out.ok);
    assert.ok(parse.refusals.length >= 2);
    const lines = out.csv.split('\r\n');
    const h = lines.indexOf('Line,Reason,Text');
    assert.ok(h > 0, 'no skipped-lines block');
    assert.equal(lines.slice(h + 1).filter(Boolean).length, parse.refusals.length);
    assert.match(out.csv, new RegExp(`${parse.refusals.length} NPD lines were skipped`));
  });

  it('has no skipped-lines block when nothing was refused', () => {
    const paste = ['kaner@simple.biz\t250.00'].join('\n');
    const parse = parseNpdPaste(paste);
    const comparison = compareHrisNpd({ hrisRows: [hris('kaner@simple.biz', phpFor(250))], npdRows: parse.rows, fxRate: FX, hrisState: 'settled' });
    const out = buildHrisNpdCsv({ comparison, parse, fxRate: FX, periodLabel: WEEK, source: { kind: 'paste' }, now: NOW });
    assert.ok(out.ok);
    assert.doesNotMatch(out.csv, /Line,Reason,Text/);
  });

  it('names the source, the rate, the tolerance and the week', () => {
    const { out: pasted } = build();
    assert.ok(pasted.ok);
    assert.match(pasted.csv, /NPD figures: pasted on step 1/);
    assert.match(pasted.csv, /PHP 61\.52 per \$1/);
    assert.match(pasted.csv, /Week: hubstaff_2026-09-20_to_2026-09-26\.csv/);
    assert.match(pasted.csv, /do not narrow this file/);

    const { out: fed } = build({}, {
      kind: 'locked_sheets',
      week: '2026-09-20',
      versions: { all_departments: 3, hsl: 5 },
      usWorkersRows: 20,
    });
    assert.ok(fed.ok);
    assert.match(fed.csv, /NPD's locked sheets for week 2026-09-20 \(All Departments v3, HSL v5\)/);
    assert.match(fed.csv, /20 NPD rows also fill Total Pay US Workers/);
  });

  it('names the file by week and time', () => {
    assert.equal(hrisNpdExportFilename(WEEK, NOW), 'hris-vs-npd_2026-09-20_to_2026-09-26_2026-10-06T14-32-05.csv');
    assert.equal(hrisNpdExportFilename('odd name.csv', NOW), 'hris-vs-npd_odd-name_2026-10-06T14-32-05.csv');
    assert.equal(hrisNpdExportFilename(null, NOW), 'hris-vs-npd_no-week_2026-10-06T14-32-05.csv');
  });
});
