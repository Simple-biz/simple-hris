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
 *  - the Notes column reads the person's PAYSTUB on a row with an issue (Kane, 2026-10-06): the
 *    statement's lines, "No Tech Allowance" / "No Attendance Incentive" / "No Performance Bonus
 *    (KPI)" for a ₱0.00 bonus, built through the real `mapPayloadToPayStub`
 *  - the Why column is the screen's reasons, copied, with their strength ("Likely:" / "Check:"),
 *    and no file while a reason still waits on the roster lookup (Kane, 2026-10-06)
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
  paystubNote,
  type HrisNpdExportSource,
  type HrisNpdPaystubs,
} from './hris-npd-export';
import { mapPayloadToPayStub, type PayStubView } from './paystub-view';
import type { HrisNpdReasons } from './hris-npd-reasons';

const FX = 61.52;
const phpFor = (dollars: number) => Math.round(dollars * FX * 100) / 100;
const NOW = new Date(2026, 9, 6, 14, 32, 5);
const WEEK = 'hubstaff_2026-09-20_to_2026-09-26.csv';

function hris(email: string, php: number, over: Partial<HrisCompareInput> = {}): HrisCompareInput {
  return { email, name: email.split('@')[0], php, dispatchable: true, excluded: false, ...over };
}

/**
 * A staged payload shaped like the wizard's `DispatchEmployee`, through the REAL
 * `mapPayloadToPayStub` — the call the Step-8 preview renders the statement with.
 */
function stub(final: number, pay: Record<string, number> = {}, extra: Record<string, unknown> = {}): PayStubView {
  return mapPayloadToPayStub({
    name: 'Someone',
    department_name: 'Lead Gen',
    hours: { total: 40, regular: 40, ot: 0 },
    rates_php: { regular: 265, ot: 397.5 },
    pay_php: {
      regular: 10600,
      ot: 0,
      tech_bonus: 0,
      perfect_attendance_bonus: 0,
      other_bonuses: 0,
      adjustment: 0,
      mesa_deduction: 0,
      mesa_disbursement: 0,
      orphanage_pay: 0,
      ...pay,
      final,
    },
    pay_period: { fx_rate: FX, week: { start: '2026-09-20', end: '2026-09-26' } },
    ...extra,
  });
}

/** One paystub per payable person, keyed like the wizard's getter (normalized work email). */
const PAYSTUBS: HrisNpdPaystubs = new Map([
  ['kaner@simple.biz', [stub(phpFor(250))]],
  ['lorar@simple.biz', [stub(phpFor(279.17), { tech_bonus: 500 })]],
  ['hrisonly@simple.biz', [stub(phpFor(40))]],
]);

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

const NO_REASONS: HrisNpdReasons = new Map();

function build(
  over: Partial<CompareHrisNpdInput> = {},
  source: HrisNpdExportSource = { kind: 'paste' },
  paystubs: HrisNpdPaystubs = PAYSTUBS,
  reasons: HrisNpdReasons = NO_REASONS,
) {
  const { parse, comparison } = setup(over);
  return {
    parse,
    comparison,
    out: buildHrisNpdCsv({ comparison, parse, fxRate: over.fxRate ?? FX, periodLabel: WEEK, source, paystubs, reasons, now: NOW }),
  };
}

/** One CSV line → its cells, RFC 4180 (quoted cells may hold commas and doubled quotes). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Column positions, from the header itself, so a new column can never silently shift a check. */
const COL = Object.fromEntries(HRIS_NPD_EXPORT_HEADER.map((h, i) => [h, i])) as Record<(typeof HRIS_NPD_EXPORT_HEADER)[number], number>;

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
  const c = cells(hit!);
  assert.equal(c.length, HRIS_NPD_EXPORT_HEADER.length, `${email}: one cell per column`);
  return c;
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
    assert.equal(k[COL.Match], 'Match');
    assert.equal(k[COL['HRIS USD']], '250.00');
    assert.equal(k[COL['NPD USD']], '250.00');
    assert.equal(k[COL['Difference USD (NPD - HRIS)']], '0.00');

    const l = lineFor(out.csv, 'lorar@simple.biz');
    assert.equal(l[COL.Match], 'Mismatch');
    assert.equal(l[COL['HRIS USD']], '279.17');
    assert.equal(l[COL['NPD USD']], '281.00');
    assert.equal(l[COL['Difference USD (NPD - HRIS)']], '1.83', 'Difference is NPD − HRIS');
    assert.match(l[COL.Notes], /^Paystub: /, 'a Mismatch carries the paystub');
    assert.doesNotMatch(l[COL.Notes], /implies/);

    assert.equal(lineFor(out.csv, 'npdonly@simple.biz')[COL.Match], 'Not in HRIS');
    const h = lineFor(out.csv, 'hrisonly@simple.biz');
    assert.equal(h[COL.Match], 'Not in NPD');
    assert.equal(h[COL['NPD USD']], '', 'NPD has no figure for them');
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
    const total = cells(lines.find((l) => l.startsWith('TOTAL'))!);
    assert.equal(total.length, HRIS_NPD_EXPORT_HEADER.length, 'the TOTAL row has one cell per column');
    assert.equal(total[0], `TOTAL - ${comparison.totals.people} people`);
    assert.equal(total[1], '');
    assert.equal(total[COL.Why], '');
    assert.equal(total[COL['HRIS USD']], centsCell(comparison.totals.hrisCents));
    assert.equal(total[COL['NPD USD']], centsCell(comparison.totals.npdCents));
    assert.equal(total[COL['Difference USD (NPD - HRIS)']], centsCell(comparison.totals.npdCents - comparison.totals.hrisCents!));
    // The paused person's $9.50 is NOT in the NPD total.
    assert.equal(comparison.totals.npdCents, 25000 + 28100 + 1200);
    const c = comparison.counts!;
    assert.ok(lines.includes(`Match,${c.match}`));
    assert.ok(lines.includes(`Mismatch,${c.mismatch}`));
    assert.ok(lines.includes(`Not in HRIS,${c.not_in_hris}`));
    assert.ok(lines.includes(`Not in NPD,${c.not_in_npd}`));
    assert.ok(lines.includes('Left out - not paid this week,2'));
  });

  it('a within-tolerance match keeps its difference, and carries no note (no issue to explain)', () => {
    const { out } = build({ hrisRows: [hris('kaner@simple.biz', phpFor(249.98))] });
    assert.ok(out.ok);
    const k = lineFor(out.csv, 'kaner@simple.biz');
    assert.equal(k[COL.Match], 'Match');
    assert.equal(k[COL['Difference USD (NPD - HRIS)']], '0.02');
    assert.equal(k[COL.Notes], '');
    assert.equal(k[COL.Why], '');
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
    const notes = lineFor(out.csv, 'kaner@simple.biz')[COL.Notes];
    assert.match(notes, /No paystub: no payout address on file/);
    assert.match(notes, /1 excluded row not counted/);
  });
});

describe('HRIS vs NPD export — the Notes column reads the paystub (Kane, 2026-10-06)', () => {
  /** The Notes cell of a row, unquoted. */
  const notesOf = (csv: string, email: string) => lineFor(csv, email)[COL.Notes];

  it('a Mismatch and a Not in NPD row carry the paystub; a Match and a Not in HRIS row do not', () => {
    const { out } = build();
    assert.ok(out.ok);
    assert.match(notesOf(out.csv, 'lorar@simple.biz'), /^Paystub: Regular Hours ₱10,600\.00 \(40\.00h\) · Tech Allowance ₱500\.00 · /);
    assert.match(notesOf(out.csv, 'hrisonly@simple.biz'), /^Paystub: /);
    assert.equal(notesOf(out.csv, 'kaner@simple.biz'), '');
    assert.equal(notesOf(out.csv, 'npdonly@simple.biz'), 'No HRIS paystub this week');
  });

  it('a bonus on ₱0.00 reads "No …" — Tech, Attendance and Performance (KPI) — and Net closes it', () => {
    const note = paystubNote(stub(10600));
    assert.equal(
      note,
      'Paystub: Regular Hours ₱10,600.00 (40.00h) · No Tech Allowance · No Attendance Incentive · No Performance Bonus (KPI) · Net ₱10,600.00',
    );
  });

  it('paid bonuses, an adjustment with its note, orphanage and MESA read as the statement prints them', () => {
    const note = paystubNote(
      stub(
        12395,
        { ot: 795, tech_bonus: 500, perfect_attendance_bonus: 1000, other_bonuses: 250, adjustment: -500, orphanage_pay: 50, mesa_deduction: 100, mesa_disbursement: 300 },
        { hours: { total: 42, regular: 40, ot: 2 }, adjustment_note: 'Sept correction' },
      ),
    );
    assert.equal(
      note,
      'Paystub: Regular Hours ₱10,600.00 (40.00h) · Overtime ₱795.00 (2.00h) · Tech Allowance ₱500.00 · ' +
        'Attendance Incentive ₱1,000.00 · Performance Bonus (KPI) ₱250.00 · Adjustment -₱500.00 (Sept correction) · ' +
        'Orphanage +₱50.00 · MESA Reimbursement +₱300.00 · MESA Deduction -₱100.00 · Net ₱12,395.00',
    );
  });

  it('a salaried week reads its Salary line, not hours', () => {
    const note = paystubNote(
      stub(30000, { regular: 30000 }, { salary: { period: 'week', amount_native: 30000, currency: 'PHP', amount_php: 30000 } }),
    );
    assert.match(note, /^Paystub: Salary \(weekly\) ₱30,000\.00 · No Tech Allowance/);
    assert.doesNotMatch(note, /Regular Hours/);
  });

  it('two payable rows on one work email: both paystubs, numbered', () => {
    const two: HrisNpdPaystubs = new Map([
      ...PAYSTUBS,
      ['lorar@simple.biz', [stub(phpFor(200)), stub(phpFor(79.17))]],
    ]);
    const { out } = build(
      { hrisRows: [hris('lorar@simple.biz', phpFor(200)), hris('lorar@simple.biz', phpFor(79.17))] },
      { kind: 'paste' },
      two,
    );
    assert.ok(out.ok);
    const n = notesOf(out.csv, 'lorar@simple.biz');
    assert.match(n, /^1 of 2 - Paystub: .* \| 2 of 2 - Paystub: /);
  });

  it('a payable row with no paystub found says so — never a blank that reads as "no issue"', () => {
    const { out } = build({}, { kind: 'paste' }, new Map());
    assert.ok(out.ok);
    assert.equal(notesOf(out.csv, 'lorar@simple.biz'), 'Paystub not found for this row');
  });

  it('the file says what the notes are, at the top', () => {
    const { out } = build();
    assert.ok(out.ok);
    assert.match(out.csv, /Notes: on a Mismatch or Not in NPD row, the person's paystub as Step 8 shows it/);
  });

  it('the wizard builds the paystubs with the Step-8 call, from the payable staged rows (source guard)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/components/PayrollWizard.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const at = src.indexOf('const getHrisNpdPaystubs = useCallback(');
    assert.ok(at > 0, 'getHrisNpdPaystubs not found');
    const body = src.slice(at, src.indexOf('}, [dispatchData.rows]);', at));
    assert.match(body, /for \(const e of dispatchData\.rows\)/);
    assert.match(body, /mapPayloadToPayStub\(/);
    assert.match(body, /normEmail\(e\.email\)/);
    assert.match(src, /getPaystubs: getHrisNpdPaystubs,/);
  });
});

describe("HRIS vs NPD export — the Why column is the screen's reasons (Kane, 2026-10-06)", () => {
  const keyOf = (comparison: ReturnType<typeof setup>['comparison'], email: string) =>
    comparison.rows.find((r) => r.workEmail === email)!.key;

  it('sits right after Match and writes each reason with its strength, in order', () => {
    assert.equal(COL.Why, COL.Match + 1);
    const { comparison } = setup();
    const reasons: HrisNpdReasons = new Map([
      [
        keyOf(comparison, 'lorar@simple.biz'),
        [
          { tone: 'likely', text: "NPD is ₱112.58 higher: exactly HRIS's Tech Allowance ₱500.00. NPD likely left it out." },
          { tone: 'lead', text: 'Check the rate, too.' },
        ],
      ],
      [keyOf(comparison, 'npdonly@simple.biz'), [{ tone: 'found', text: 'No one in HRIS has this address: it is not on the roster, active or offboarded.' }]],
    ]);
    const { out } = build({}, { kind: 'paste' }, PAYSTUBS, reasons);
    assert.ok(out.ok);
    assert.equal(
      lineFor(out.csv, 'lorar@simple.biz')[COL.Why],
      "Likely: NPD is ₱112.58 higher: exactly HRIS's Tech Allowance ₱500.00. NPD likely left it out. | Check: Check the rate, too.",
    );
    assert.equal(
      lineFor(out.csv, 'npdonly@simple.biz')[COL.Why],
      'No one in HRIS has this address: it is not on the roster, active or offboarded.',
    );
    assert.equal(lineFor(out.csv, 'kaner@simple.biz')[COL.Why], '', 'a Match has no reason');
    assert.match(out.csv, /Why: what HRIS's own records say/);
  });

  it('makes no file while a reason still waits on the roster lookup', () => {
    const { comparison } = setup();
    const pending: HrisNpdReasons = new Map([
      [keyOf(comparison, 'npdonly@simple.biz'), [{ tone: 'pending', text: 'Looking this address up in HRIS…' }]],
    ]);
    const { out } = build({}, { kind: 'paste' }, PAYSTUBS, pending);
    assert.equal(out.ok, false);
    assert.equal(out.ok ? null : out.reason, 'Still looking up who the Not in HRIS addresses belong to.');
  });

  it('neutralises a reason like any text cell', () => {
    const { comparison } = setup();
    const reasons: HrisNpdReasons = new Map([[keyOf(comparison, 'npdonly@simple.biz'), [{ tone: 'found', text: '=HYPERLINK("x")' }]]]);
    const { out } = build({}, { kind: 'paste' }, PAYSTUBS, reasons);
    assert.ok(out.ok);
    assert.equal(lineFor(out.csv, 'npdonly@simple.biz')[COL.Why], `'=HYPERLINK("x")`);
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
    assert.equal(
      buildHrisNpdCsv({ comparison, parse, fxRate: FX, periodLabel: WEEK, source: { kind: 'paste' }, paystubs: PAYSTUBS, reasons: NO_REASONS, now: NOW }).ok,
      false,
    );
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
    const out = buildHrisNpdCsv({ comparison, parse, fxRate: FX, periodLabel: WEEK, source: { kind: 'paste' }, paystubs: PAYSTUBS, reasons: NO_REASONS, now: NOW });
    assert.ok(out.ok);
    const k = lineFor(out.csv, 'kaner@simple.biz');
    assert.equal(k[1], "'+Kane");
    assert.equal(k[COL['Difference USD (NPD - HRIS)']], '-1.00', 'a negative difference is a number, not a formula');
    // An NPD address as pasted is a row (Not in HRIS), and a refused line's raw text is listed:
    // both are text, both neutralised.
    assert.equal(lineFor(out.csv, "'=cmd@evil.com")[COL.Match], 'Not in HRIS');
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
    const out = buildHrisNpdCsv({ comparison, parse, fxRate: FX, periodLabel: WEEK, source: { kind: 'paste' }, paystubs: PAYSTUBS, reasons: NO_REASONS, now: NOW });
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
