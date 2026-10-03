import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  compareHrisNpd,
  filterHrisNpdRows,
  parseNpdPaste,
  parseUsdCell,
  stagedUsdCents,
  HRIS_SOURCE_LABELS,
  DEFAULT_MATCH_TOLERANCE_CENTS,
  MAX_MATCH_TOLERANCE_CENTS,
  parseToleranceCents,
  type CompareHrisNpdInput,
  type HrisCompareInput,
} from './hris-npd-compare';
import { PAY_STUB_SOURCE_KEYS } from './paystub-field-state';

const FX = 61.52;

function hris(email: string, php: number, extra: Partial<HrisCompareInput> = {}): HrisCompareInput {
  return { email, name: email.split('@')[0], php, dispatchable: true, excluded: false, ...extra };
}

function run(partial: Partial<CompareHrisNpdInput> & { paste?: string }) {
  const { paste = '', ...rest } = partial;
  return compareHrisNpd({
    hrisRows: [],
    npdRows: parseNpdPaste(paste).rows,
    fxRate: FX,
    hrisState: 'settled',
    ...rest,
  });
}

/** PHP that stages to exactly `dollars` at the test FX. */
const phpFor = (dollars: number) => Math.round(dollars * FX * 100) / 100;

describe('parseUsdCell', () => {
  test('reads what sheets and people put around a dollar figure', () => {
    const cases: Array<[string, number]> = [
      ['250', 25000],
      ['250.00', 25000],
      ['$250.00', 25000],
      ['250$', 25000],
      ['$ 1,250.50', 125050],
      ['1,234,567.89', 123456789],
      ['USD 12.5', 1250],
      ['US$99.99', 9999],
      ['12.34 USD', 1234],
      ['.5', 50],
      ['0', 0],
      ['-$2.06', -206],
      ['$-2.06', -206],
      ['(2.06)', -206],
      ['+$3.00', 300],
      ['−4.00', -400],
    ];
    for (const [raw, cents] of cases) {
      const r = parseUsdCell(raw);
      assert.deepEqual(r, { ok: true, cents }, raw);
    }
  });

  test('parses the decimal string exactly — never float × 100', () => {
    // Math.round(1.005 * 100) === 100 in IEEE doubles; the string says 1.005.
    assert.deepEqual(parseUsdCell('1.005'), { ok: true, cents: 101 });
    assert.deepEqual(parseUsdCell('1.004'), { ok: true, cents: 100 });
    assert.deepEqual(parseUsdCell('-0'), { ok: true, cents: 0 });
  });

  test('refuses pesos — the PHP column pasted as the dollar column is the likeliest wrong paste', () => {
    for (const raw of ['₱12,652.73', '12652.73 PHP', 'PHP 500', '500 pesos', 'COP 14,000']) {
      const r = parseUsdCell(raw);
      assert.equal(r.ok, false, raw);
      if (!r.ok) assert.match(r.reason, /pesos/);
    }
  });

  test('refuses anything that is not a plain decimal', () => {
    for (const raw of ['', '   ', '#N/A', 'n/a', '12,50', '1,2345', '$', 'twelve', '1.2.3', '12-5']) {
      assert.equal(parseUsdCell(raw).ok, false, JSON.stringify(raw));
    }
  });
});

describe('parseNpdPaste', () => {
  test("Kane's shape: work email ⇥ dollars", () => {
    const p = parseNpdPaste('kaner@simple.biz\t250\narvsn@simple.biz\t$205.67');
    assert.equal(p.mode, 'tsv');
    assert.equal(p.amountColumn, 1);
    assert.deepEqual(p.refusals, []);
    assert.deepEqual(p.rows, [
      { line: 1, email: 'kaner@simple.biz', cents: 25000 },
      { line: 2, email: 'arvsn@simple.biz', cents: 20567 },
    ]);
  });

  test('a wide block (email … USD) reads the email cell and the RIGHTMOST column', () => {
    const text = [
      'Name\tWork Email\tHours\tPHP\tUSD',
      'Kane R\tKaneR@Simple.biz\t40.00\t15,380.00\t250.00',
      'Lora R\tlorar@simple.biz\t40.00\t17,009.68\t276.49',
    ].join('\n');
    const p = parseNpdPaste(text);
    assert.equal(p.headerSkipped, true);
    assert.equal(p.amountColumn, 4);
    assert.deepEqual(p.rows.map((r) => [r.email, r.cents]), [
      ['kaner@simple.biz', 25000],
      ['lorar@simple.biz', 27649],
    ]);
  });

  test('a BLANK dollar cell is refused, never read from the cell beside it', () => {
    const text = [
      'a@simple.biz\t15,380.00\t250.00',
      'b@simple.biz\t17,009.68\t', // NPD has pesos but no dollars for b
    ].join('\n');
    const p = parseNpdPaste(text);
    assert.deepEqual(p.rows.map((r) => r.email), ['a@simple.biz']);
    assert.equal(p.refusals.length, 1);
    assert.equal(p.refusals[0].line, 2);
    assert.match(p.refusals[0].reason, /No dollar amount in column 3/);
  });

  test('a selection wider than the data is harmless — empty trailing columns never hold the figure', () => {
    const p = parseNpdPaste('a@simple.biz\t250\t\t\nb@simple.biz\t10.50\t\t');
    assert.equal(p.amountColumn, 1);
    assert.deepEqual(p.rows.map((r) => r.cents), [25000, 1050]);
  });

  test('a total row (no email) is refused and cannot move the dollar column', () => {
    const p = parseNpdPaste('a@simple.biz\t250\nb@simple.biz\t100\nTOTAL\t\t350');
    assert.equal(p.amountColumn, 1);
    assert.equal(p.rows.length, 2);
    assert.deepEqual(p.refusals.map((r) => [r.line, r.reason]), [[3, 'No work email on this line']]);
  });

  test('the header is skipped once, at the top only', () => {
    const p = parseNpdPaste('Work Email\tUSD\na@simple.biz\t1\nWork Email\tUSD');
    assert.equal(p.headerSkipped, true);
    assert.equal(p.rows.length, 1);
    assert.deepEqual(p.refusals.map((r) => r.line), [3]);
  });

  test('CRLF and blank lines are tolerated, and line numbers count the blanks', () => {
    const p = parseNpdPaste('a@simple.biz\t1\r\n\r\n  \r\nb@simple.biz\t2');
    assert.deepEqual(p.rows.map((r) => r.line), [1, 4]);
  });

  test('a PHP figure in the dollar column is refused with the reason, line by line', () => {
    const p = parseNpdPaste('a@simple.biz\t₱12,652.73');
    assert.equal(p.rows.length, 0);
    assert.match(p.refusals[0].reason, /pesos/);
  });

  test('in a tab-separated paste a line with no tab is refused, not guessed at', () => {
    const p = parseNpdPaste('a@simple.biz\t1\nb@simple.biz 2');
    assert.equal(p.rows.length, 1);
    assert.match(p.refusals[0].reason, /tab-separated/);
  });

  test('an email in the rightmost column has no dollars to its right', () => {
    const p = parseNpdPaste('250\ta@simple.biz');
    assert.equal(p.rows.length, 0);
    assert.match(p.refusals[0].reason, /right of the email/);
  });

  test('typed by hand (no tab anywhere): "email amount", split at the first space or comma', () => {
    const p = parseNpdPaste('Email Amount\nkaner@simple.biz 250$\nb@simple.biz, $1,250.00\nc@simple.biz\nnot-an-email 5');
    assert.equal(p.mode, 'typed');
    assert.equal(p.headerSkipped, true);
    assert.deepEqual(p.rows.map((r) => [r.email, r.cents]), [
      ['kaner@simple.biz', 25000],
      ['b@simple.biz', 125000],
    ]);
    assert.deepEqual(p.refusals.map((r) => r.line), [4, 5]);
  });

  test('an empty paste has no mode, rows or refusals', () => {
    assert.deepEqual(parseNpdPaste('  \n\n'), { rows: [], refusals: [], headerSkipped: false, mode: null, amountColumn: null });
  });
});

describe('stagedUsdCents — the dollar figure Payment Dispatch is sent', () => {
  test('is the staging expression before its final / 100', () => {
    for (const php of [12652.73, 17009.68, 5102.13, 0, -100, 0.3, 123456.785]) {
      const staged = Math.round((php / FX) * 100) / 100;
      assert.equal(stagedUsdCents(php, FX)! / 100, staged, String(php));
    }
  });

  test('refuses a rate of 0 or less — never a figure divided by a placeholder', () => {
    assert.equal(stagedUsdCents(1000, 0), null);
    assert.equal(stagedUsdCents(1000, -1), null);
    assert.equal(stagedUsdCents(Number.NaN, FX), null);
  });

  test('SOURCE GUARD: PayrollWizard.tsx still stages amount_usd with the same expression', () => {
    const src = fs
      .readFileSync(path.join(process.cwd(), 'src/components/PayrollWizard.tsx'), 'utf8')
      .replace(/\r\n/g, '\n');
    assert.ok(
      src.includes('amount_usd: usdToPhpRate > 0 ? Math.round((e.pay_php.final / usdToPhpRate) * 100) / 100 : null,'),
      'The staged amount_usd expression changed. Update stagedUsdCents to match, or HRIS vs NPD compares a figure dispatch does not send.',
    );
  });
});

describe('compareHrisNpd', () => {
  test("Kane's example: same dollars ⇒ match, and the row keeps HRIS's address and name", () => {
    const c = run({ hrisRows: [hris('kaner@simple.biz', phpFor(250))], paste: 'kaner@simple.biz\t250' });
    assert.equal(c.hold, null);
    assert.equal(c.rows.length, 1);
    const r = c.rows[0];
    assert.equal(r.status, 'match');
    assert.equal(r.hrisCents, 25000);
    assert.equal(r.npdCents, 25000);
    assert.equal(r.deltaCents, 0);
    assert.equal(r.workEmail, 'kaner@simple.biz');
    assert.equal(r.name, 'kaner');
    assert.deepEqual(c.counts, { match: 1, mismatch: 0, not_in_hris: 0, not_in_npd: 0 });
  });

  // Kane, 2026-09-30: "now lets make it match if the difference is just 3 cents", then "a user
  // input … where the user can set the off by how many cents". 3 is the default.
  test('the default tolerance is 3 cents, and the result says which tolerance it used', () => {
    assert.equal(DEFAULT_MATCH_TOLERANCE_CENTS, 3);
    assert.equal(MAX_MATCH_TOLERANCE_CENTS, 99);
    const c = run({ hrisRows: [hris('a@simple.biz', phpFor(1))], paste: 'a@simple.biz\t1' });
    assert.equal(c.toleranceCents, 3);
  });

  test('the operator sets it: at 1¢ a 2¢ gap is a mismatch; at 0 only exact counts; at 10 the 7¢ residue matches', () => {
    const at = (tol: number, npd: string) =>
      run({ hrisRows: [hris('a@simple.biz', phpFor(250))], paste: `a@simple.biz\t${npd}`, toleranceCents: tol });
    assert.equal(at(1, '250.02').rows[0].status, 'mismatch');
    assert.equal(at(1, '250.01').rows[0].status, 'match');
    assert.equal(at(0, '250.01').rows[0].status, 'mismatch');
    assert.equal(at(0, '250.00').rows[0].status, 'match');
    assert.equal(at(10, '250.07').rows[0].status, 'match');
    assert.equal(at(10, '250.07').toleranceCents, 10);
  });

  test('an unusable tolerance is never applied — the default is used and reported', () => {
    for (const bad of [-1, 1.5, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = run({ hrisRows: [hris('a@simple.biz', phpFor(250))], paste: 'a@simple.biz\t250.03', toleranceCents: bad });
      assert.equal(c.toleranceCents, 3, String(bad));
      assert.equal(c.rows[0].status, 'match', String(bad));
    }
  });

  test('parseToleranceCents: whole cents 0–99 only, never rounded or clamped into range', () => {
    for (const [raw, want] of [[0, 0], [3, 3], [99, 99], ['7', 7], [' 12 ', 12]] as const) {
      assert.equal(parseToleranceCents(raw), want, JSON.stringify(raw));
    }
    for (const raw of [-1, 100, 1.5, '1.5', '', '  ', 'abc', '-2', null, undefined, Number.NaN]) {
      assert.equal(parseToleranceCents(raw), null, JSON.stringify(raw));
    }
  });

  test('up to 3 cents either way is a MATCH, and the difference is kept, not erased', () => {
    for (const [npd, delta] of [['250.01', 1], ['250.03', 3], ['249.97', -3], ['249.99', -1]] as const) {
      const c = run({ hrisRows: [hris('a@simple.biz', phpFor(250))], paste: `a@simple.biz\t${npd}` });
      assert.equal(c.rows[0].status, 'match', npd);
      assert.equal(c.rows[0].deltaCents, delta, npd);
      assert.equal(c.rows[0].impliedNpdRate, null, npd);
    }
  });

  test('4 cents either way is a MISMATCH — the boundary is inclusive at 3', () => {
    for (const npd of ['250.04', '249.96']) {
      const c = run({ hrisRows: [hris('a@simple.biz', phpFor(250))], paste: `a@simple.biz\t${npd}` });
      assert.equal(c.rows[0].status, 'mismatch', npd);
    }
  });

  test("the 2026-08-18 week's $0.07 residue is still a mismatch under the tolerance", () => {
    const c = run({ hrisRows: [hris('arvsn@simple.biz', phpFor(207.66))], paste: 'arvsn@simple.biz\t207.73' });
    assert.equal(c.rows[0].status, 'mismatch');
    assert.equal(c.rows[0].deltaCents, 7);
  });

  test('the 2026-08-18 case: pesos agree, the divisor does not — the row says what rate NPD used', () => {
    const c = run({ hrisRows: [hris('lorar@simple.biz', 17009.68)], paste: 'lorar@simple.biz\t279.17' });
    const r = c.rows[0];
    assert.equal(r.hrisCents, 27649); // 17,009.68 ÷ 61.52
    assert.equal(r.status, 'mismatch');
    assert.equal(r.deltaCents, 268);
    assert.equal(r.impliedNpdRate, 60.93);
  });

  test('NO ROW IS DROPPED: the result is the union of both sides, the missing side labelled', () => {
    const c = run({
      hrisRows: [hris('both@simple.biz', phpFor(10)), hris('hrisonly@simple.biz', phpFor(20))],
      paste: 'both@simple.biz\t10\nnpdonly@simple.biz\t30',
    });
    assert.deepEqual(
      c.rows.map((r) => [r.workEmail, r.status]),
      [
        ['both@simple.biz', 'match'],
        ['hrisonly@simple.biz', 'not_in_npd'],
        ['npdonly@simple.biz', 'not_in_hris'],
      ],
    );
    const hrisOnly = c.rows.find((r) => r.workEmail === 'hrisonly@simple.biz')!;
    assert.equal(hrisOnly.npdCents, null);
    assert.equal(hrisOnly.hrisCents, 2000);
    const npdOnly = c.rows.find((r) => r.workEmail === 'npdonly@simple.biz')!;
    assert.equal(npdOnly.hrisCents, null);
    assert.equal(npdOnly.npdCents, 3000);
    assert.deepEqual(c.counts, { match: 1, mismatch: 0, not_in_hris: 1, not_in_npd: 1 });
  });

  test('every HRIS row and every parsed NPD address appears exactly once, at scale', () => {
    const hrisRows = Array.from({ length: 1200 }, (_, i) => hris(`p${i}@simple.biz`, phpFor(i)));
    const paste = Array.from({ length: 1100 }, (_, i) => `p${i + 150}@simple.biz\t${i + 150}`).join('\n');
    const c = run({ hrisRows, paste });
    const union = new Set([...hrisRows.map((r) => r.email), ...parseNpdPaste(paste).rows.map((r) => r.email)]);
    assert.equal(c.rows.length, union.size);
    assert.equal(new Set(c.rows.map((r) => r.key)).size, c.rows.length);
    // HRIS p0–p1199, NPD p150–p1249: 1,050 on both sides, 150 HRIS-only, 50 NPD-only.
    assert.equal(c.counts!.match, 1050);
    assert.equal(c.counts!.not_in_npd, 150);
    assert.equal(c.counts!.not_in_hris, 50);
    assert.equal(c.rows.length, 1250);
  });

  test('matching ignores case and whitespace in the address', () => {
    const c = run({ hrisRows: [hris(' KaneR@Simple.BIZ ', phpFor(5))], paste: 'kaner@simple.biz\t5' });
    assert.equal(c.rows.length, 1);
    assert.equal(c.rows[0].status, 'match');
  });

  test('a person on two NPD lines is ADDED (the 2026-09-29 orphanage ruling), and the lines are listed', () => {
    const c = run({ hrisRows: [hris('a@simple.biz', phpFor(15.5))], paste: 'a@simple.biz\t10\nA@simple.biz\t5.50' });
    assert.equal(c.rows.length, 1);
    assert.equal(c.rows[0].npdCents, 1550);
    assert.deepEqual(c.rows[0].npdLines, [1, 2]);
    assert.equal(c.rows[0].status, 'match');
  });

  test('an unknown address on two lines is one Not-in-HRIS row with both added', () => {
    const c = run({ paste: 'x@simple.biz\t1\nx@simple.biz\t2' });
    assert.equal(c.rows.length, 1);
    assert.equal(c.rows[0].npdCents, 300);
    assert.equal(c.rows[0].status, 'not_in_hris');
  });

  // Kane, 2026-09-30: "We are not connecting this with the personal email please we are
  // connecting this to the work email." The join is the work email, exactly.

  test('WORK EMAIL ONLY: a personal address never reaches the HRIS row — both sides stay visible, unmatched', () => {
    const c = run({
      hrisRows: [hris('kaner@simple.biz', phpFor(250))],
      paste: 'kane.personal@gmail.com\t250',
    });
    assert.deepEqual(c.rows.map((r) => [r.workEmail, r.status]), [
      ['kane.personal@gmail.com', 'not_in_hris'],
      ['kaner@simple.biz', 'not_in_npd'],
    ]);
  });

  test('WORK EMAIL ONLY: the compare input has no alias bridge to hand an address to', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/payroll/hris-npd-compare.ts'), 'utf8');
    assert.doesNotMatch(src, /aliasesFor|masterAliases|personal_email/);
    const wizard = fs.readFileSync(path.join(process.cwd(), 'src/components/PayrollWizard.tsx'), 'utf8');
    const call = wizard.slice(wizard.indexOf('compareHrisNpd({'), wizard.indexOf('compareHrisNpd({') + 900);
    assert.doesNotMatch(call, /aliasesFor|masterAliasesFor/);
  });

  test('a work email on two NPD lines is still one person, added', () => {
    const c = run({
      hrisRows: [hris('a@simple.biz', phpFor(30))],
      paste: 'a@simple.biz\t10\nA@Simple.biz\t20',
    });
    assert.equal(c.rows.length, 1);
    assert.equal(c.rows[0].npdCents, 3000);
    assert.equal(c.rows[0].status, 'match');
  });

  // Kane, 2026-09-30: "If they are configured not to be paid please lets not include them here".
  test('CONFIGURED NOT TO BE PAID — paused department: NPD\'s line is not compared, and is listed as left out', () => {
    const c = run({
      hrisRows: [hris('a@simple.biz', phpFor(1))],
      paste: 'a@simple.biz\t1\npaused@simple.biz\t9\nPaused@simple.biz\t1',
      pausedEmails: new Set(['paused@simple.biz']),
    });
    assert.deepEqual(c.rows.map((r) => r.workEmail), ['a@simple.biz']);
    assert.deepEqual(c.leftOut, [
      { workEmail: 'paused@simple.biz', name: null, reason: 'paused', npdCents: 1000, npdLines: [2, 3] },
    ]);
    assert.equal(c.totals.npdCents, 100);
  });

  test('CONFIGURED NOT TO BE PAID — Excluded on Final Pay: not a row, not a false "Not in HRIS", listed with what NPD says', () => {
    const c = run({
      hrisRows: [hris('x@simple.biz', phpFor(5), { excluded: true, name: 'Xena' }), hris('z@simple.biz', phpFor(8), { excluded: true })],
      paste: 'x@simple.biz\t5\ny@simple.biz\t6',
    });
    assert.deepEqual(c.rows.map((r) => [r.workEmail, r.status]), [['y@simple.biz', 'not_in_hris']]);
    assert.deepEqual(c.leftOut, [
      { workEmail: 'x@simple.biz', name: 'Xena', reason: 'excluded', npdCents: 500, npdLines: [1] },
      { workEmail: 'z@simple.biz', name: 'z', reason: 'excluded', npdCents: null, npdLines: [] },
    ]);
    assert.deepEqual(c.counts, { match: 0, mismatch: 0, not_in_hris: 1, not_in_npd: 0 });
  });

  test('an excluded row beside a payable row on the same work email: compared on the payable one, and says so', () => {
    const c = run({
      hrisRows: [hris('a@simple.biz', phpFor(10)), hris('a@simple.biz', phpFor(99), { excluded: true })],
      paste: 'a@simple.biz\t10',
    });
    assert.equal(c.rows.length, 1);
    assert.equal(c.rows[0].hrisCents, 1000);
    assert.equal(c.rows[0].hrisRowCount, 1);
    assert.equal(c.rows[0].excludedRowCount, 1);
    assert.equal(c.rows[0].status, 'match');
    assert.deepEqual(c.leftOut, []);
  });

  test('two Validation rows on one email are both paid, so their staged cents are summed', () => {
    const c = run({
      hrisRows: [hris('a@simple.biz', 100.01), hris('A@simple.biz', 200.02)],
      paste: 'a@simple.biz\t0',
    });
    assert.equal(c.rows.length, 1);
    assert.equal(c.rows[0].hrisRowCount, 2);
    assert.equal(c.rows[0].hrisCents, stagedUsdCents(100.01, FX)! + stagedUsdCents(200.02, FX)!);
  });

  test('a no-payout row (no payout address) is a data gap, not a configuration — it stays in', () => {
    const c = run({
      hrisRows: [hris('y@simple.biz', phpFor(6), { dispatchable: false })],
      paste: 'y@simple.biz\t6',
    });
    assert.equal(c.rows.length, 1);
    assert.equal(c.rows[0].noPayoutRowCount, 1);
    assert.equal(c.rows[0].status, 'match');
    assert.deepEqual(c.leftOut, []);
  });

  test('rows are sorted by address', () => {
    const c = run({ hrisRows: [hris('c@simple.biz', 1), hris('a@simple.biz', 1)], paste: 'b@simple.biz\t1' });
    assert.deepEqual(c.rows.map((r) => r.workEmail), ['a@simple.biz', 'b@simple.biz', 'c@simple.biz']);
  });

  test('totals are the whole comparison', () => {
    const c = run({
      hrisRows: [hris('a@simple.biz', phpFor(10)), hris('b@simple.biz', phpFor(20))],
      paste: 'a@simple.biz\t10\nz@simple.biz\t7',
    });
    assert.deepEqual(c.totals, { hrisCents: 3000, npdCents: 1700, people: 3 });
  });
});

describe('compareHrisNpd — no verdict before the figures can be judged', () => {
  const base = { hrisRows: [hris('a@simple.biz', phpFor(1))], paste: 'a@simple.biz\t1\nb@simple.biz\t2' };

  test('nothing pasted ⇒ no rows at all (absence is not zero), not "everyone is Not in NPD"', () => {
    const c = run({ hrisRows: base.hrisRows, paste: '' });
    assert.deepEqual(c.hold, { kind: 'no_npd_rows' });
    assert.deepEqual(c.rows, []);
    assert.equal(c.counts, null);
  });

  test('only refused lines ⇒ still no rows', () => {
    const c = run({ hrisRows: base.hrisRows, paste: 'a@simple.biz\t#N/A' });
    assert.deepEqual(c.hold, { kind: 'no_npd_rows' });
    assert.equal(c.rows.length, 0);
  });

  test('loading ⇒ rows keep their figures and lose their verdicts', () => {
    const c = run({ ...base, hrisState: 'pending' });
    assert.deepEqual(c.hold, { kind: 'loading' });
    assert.equal(c.rows.length, 2);
    assert.ok(c.rows.every((r) => r.status === null));
    assert.equal(c.counts, null);
    assert.equal(c.rows[0].hrisCents, 100);
  });

  test('a failed input ⇒ held, and the banner can name it', () => {
    const c = run({ ...base, hrisState: 'unavailable', unavailableSources: ['additions', 'fx'] });
    assert.deepEqual(c.hold, { kind: 'unavailable', sources: ['additions', 'fx'] });
    assert.ok(c.rows.every((r) => r.status === null));
  });

  test('the cycle rate still 0 ⇒ held, and no HRIS dollar figure is invented', () => {
    const c = run({ ...base, fxRate: 0 });
    assert.deepEqual(c.hold, { kind: 'no_fx' });
    assert.ok(c.rows.every((r) => r.status === null && r.hrisCents === null));
    assert.equal(c.totals.hrisCents, null);
    assert.equal(c.totals.npdCents, 300);
  });

  test('loading outranks a missing rate — the rate may be what is still loading', () => {
    assert.deepEqual(run({ ...base, fxRate: 0, hrisState: 'pending' }).hold, { kind: 'loading' });
  });

  test('every source key has a banner label', () => {
    for (const k of PAY_STUB_SOURCE_KEYS) assert.ok(HRIS_SOURCE_LABELS[k], k);
  });
});

describe('filterHrisNpdRows — display only', () => {
  const c = run({
    hrisRows: [hris('kaner@simple.biz', phpFor(1), { name: 'Kane Rivera' }), hris('b@simple.biz', phpFor(2))],
    paste: 'kaner@simple.biz\t1\nb@simple.biz\t3\nz@simple.biz\t4',
  });

  test('status chips narrow to one bucket', () => {
    assert.deepEqual(filterHrisNpdRows(c.rows, { status: 'mismatch' }).map((r) => r.workEmail), ['b@simple.biz']);
    assert.deepEqual(filterHrisNpdRows(c.rows, { status: 'not_in_hris' }).map((r) => r.workEmail), ['z@simple.biz']);
    assert.equal(filterHrisNpdRows(c.rows, { status: 'all' }).length, 3);
  });

  test('the search reaches a person by work email and by name', () => {
    assert.deepEqual(filterHrisNpdRows(c.rows, { needle: 'rivera' }).map((r) => r.workEmail), ['kaner@simple.biz']);
    assert.deepEqual(filterHrisNpdRows(c.rows, { needle: 'KANER@' }).map((r) => r.workEmail), ['kaner@simple.biz']);
  });

  test('filtering never touches the totals', () => {
    filterHrisNpdRows(c.rows, { status: 'match', needle: 'x' });
    assert.equal(c.totals.people, 3);
  });
});

// ─── People configured not to be paid: rows with the reason, never compared (Kane, 2026-10-02) ──

describe('the table lines: compared rows + people configured not to be paid', async () => {
  const m = await import('./hris-npd-compare');
  const c = m.compareHrisNpd({
    hrisRows: [
      { email: 'b@simple.biz', name: 'Bee', php: 6152, dispatchable: true, excluded: false },
      { email: 'a@simple.biz', name: 'Ay', php: 6152, dispatchable: true, excluded: true },
    ],
    npdRows: m.parseNpdPaste('a@simple.biz\t100.00\nb@simple.biz\t100.00\nc@simple.biz\t5.00').rows,
    fxRate: 61.52,
    hrisState: 'settled',
    pausedEmails: new Set(['c@simple.biz']),
  });

  test('both kinds, sorted together by work email; the not-paid ones are not in counts or totals', () => {
    const lines = m.hrisNpdDisplayRows(c);
    assert.deepEqual(lines.map((l) => [l.kind, l.workEmail]), [
      ['not_paid', 'a@simple.biz'],
      ['compared', 'b@simple.biz'],
      ['not_paid', 'c@simple.biz'],
    ]);
    assert.deepEqual(c.counts, { match: 1, mismatch: 0, not_in_hris: 0, not_in_npd: 0 });
    assert.equal(c.totals.npdCents, 10000);
    assert.equal(c.totals.people, 1);
  });

  test('the Not paid chip shows only them; a verdict chip never shows them; the search covers both', () => {
    const lines = m.hrisNpdDisplayRows(c);
    assert.deepEqual(m.filterHrisNpdDisplay(lines, { status: 'not_paid' }).map((l) => l.workEmail), ['a@simple.biz', 'c@simple.biz']);
    assert.deepEqual(m.filterHrisNpdDisplay(lines, { status: 'match' }).map((l) => l.workEmail), ['b@simple.biz']);
    assert.deepEqual(m.filterHrisNpdDisplay(lines, { needle: 'ay' }).map((l) => l.workEmail), ['a@simple.biz']);
    assert.equal(m.filterHrisNpdDisplay(lines, {}).length, 3);
  });

  test('every reason has the words the Match column states', () => {
    assert.equal(m.HRIS_NPD_NOT_PAID_REASON.excluded.short, 'Excluded on Final Pay');
    assert.equal(m.HRIS_NPD_NOT_PAID_REASON.paused.short, 'Department paused this week');
  });
});
