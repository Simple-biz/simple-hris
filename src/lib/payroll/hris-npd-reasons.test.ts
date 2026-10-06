/**
 * HRIS vs NPD → Why (Kane, 2026-10-06): "Not in HRIS - Lets add the reason why they arent in HRIS
 * … if its not in NPD, find an appropriate reason … for the Mismatch … if they lack their PAB, Tech
 * Bonus, KPI or whatever be smart about this".
 *
 * What these pin (docs/features/payroll-wizard-hris-vs-npd.md § Why):
 *  - a reason never changes a verdict, a figure or a count, and naming the person behind a
 *    personal email is not a join (both rows stay what they are)
 *  - Not in HRIS: offboarded (date, reason), on the roster with no hours, no such person (plus a
 *    one-letter typo lead), their personal email; a FAILED lookup never reads "not on the roster"
 *  - Not in NPD: NPD's line for them was skipped, paid in COP, final / first paycheck, ₱0.00, the
 *    other address NPD used, and a lead naming NPD's tab when nothing is known
 *  - Mismatch: "likely" only when leaving out exactly those paystub lines (or that rate, those
 *    hours, that FX) reproduces NPD's figure to the cent; leads are said as leads
 *  - nothing while held; NPD's own columns are never read
 *  - the roster lookup's matching and reply parsing; the route's gate; the wizard's wiring
 *
 * Run:  node --import tsx --test src/lib/payroll/hris-npd-reasons.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import HrisNpdComparison from '@/components/payroll/HrisNpdComparison';
import { compareHrisNpd, parseNpdPaste, type CompareHrisNpdInput, type HrisCompareInput } from './hris-npd-compare';
import {
  INFER_TOL_CENTS,
  explainHrisNpd,
  hrisNpdIdentityEmails,
  hrisNpdReasonsPending,
  linesExplainingGap,
  paystubLines,
  reasonDate,
  reasonText,
  type HrisNpdIdentityState,
  type HrisNpdPersonFacts,
  type HrisNpdReasonPaystubs,
} from './hris-npd-reasons';
import {
  matchNpdIdentities,
  parseNpdIdentityPayload,
  type MasterIdentityRow,
  type NpdIdentityMatch,
} from './hris-npd-identity';
import { mapPayloadToPayStub, type PayStubView } from './paystub-view';

const FX = 61.52;
const cents = (php: number) => Math.round((php / FX) * 100);
const dollars = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

function hris(email: string, php: number, over: Partial<HrisCompareInput> = {}): HrisCompareInput {
  return { email, name: email.split('@')[0], php, dispatchable: true, excluded: false, ...over };
}

/** A staged payload through the REAL `mapPayloadToPayStub`, as the wizard maps it. */
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
    pay_period: { fx_rate: FX, week: { start: '2026-09-27', end: '2026-10-03' } },
    ...extra,
  });
}

function facts(over: Partial<HrisNpdPersonFacts> = {}): HrisNpdPersonFacts {
  return {
    department: 'Lead Gen',
    isHsl: false,
    totalHours: 40,
    regularHours: 40,
    otHours: 0,
    regularRate: 265,
    otRate: 397.5,
    otIsDifferential: false,
    salaried: false,
    salaryHeld: null,
    firstPaycheck: false,
    startDate: null,
    finalPay: null,
    settlement: null,
    ...over,
  };
}

const READY_NONE: HrisNpdIdentityState = { state: 'ready', byEmail: {} };

function explain(opts: {
  hrisRows: HrisCompareInput[];
  paste: string;
  facts?: Record<string, HrisNpdPersonFacts>;
  paystubs?: Record<string, PayStubView[]>;
  identities?: HrisNpdIdentityState;
  timesheet?: string[];
  compare?: Partial<CompareHrisNpdInput>;
}) {
  const parse = parseNpdPaste(opts.paste);
  const comparison = compareHrisNpd({
    hrisRows: opts.hrisRows,
    npdRows: parse.rows,
    fxRate: FX,
    hrisState: 'settled',
    ...opts.compare,
  });
  const before = JSON.stringify(comparison);
  const reasons = explainHrisNpd({
    comparison,
    parse,
    sourceText: opts.paste,
    fxRate: FX,
    facts: new Map(Object.entries(opts.facts ?? {})),
    paystubs: new Map(Object.entries(opts.paystubs ?? {})) as HrisNpdReasonPaystubs,
    identities: opts.identities ?? READY_NONE,
    timesheetEmails: new Set(opts.timesheet ?? []),
    weekStart: '2026-09-27',
  });
  assert.equal(JSON.stringify(comparison), before, 'explaining never changes the comparison');
  const rowOf = (email: string) => {
    const r = comparison.rows.find((x) => x.workEmail === email);
    assert.ok(r, `no row for ${email}`);
    return r!;
  };
  return {
    comparison,
    reasons,
    rowOf,
    why: (email: string) => (reasons.get(rowOf(email).key) ?? []).map((r) => `${r.tone}: ${r.text}`),
  };
}

function match(over: Partial<NpdIdentityMatch>): NpdIdentityMatch {
  return {
    name: null,
    workEmail: null,
    personalEmail: null,
    alternateEmails: [],
    department: null,
    startDate: null,
    offboardedAt: null,
    offboardedReason: null,
    matchedBy: 'work',
    ...over,
  };
}

// ─── Mismatch ─────────────────────────────────────────────────────────────────

describe('Mismatch — the gap is a line of HRIS’s paystub (likely, to the cent)', () => {
  it('NPD left out the KPI: names the line and its amount', () => {
    const { why } = explain({
      hrisRows: [hris('kpi@simple.biz', 12600)],
      paste: `kpi@simple.biz\t${dollars(cents(10600))}`,
      paystubs: { 'kpi@simple.biz': [stub(12600, { other_bonuses: 2000 })] },
      facts: { 'kpi@simple.biz': facts() },
    });
    assert.deepEqual(why('kpi@simple.biz'), [
      "likely: NPD is ₱2,000.00 lower: exactly HRIS's Performance Bonus (KPI) ₱2,000.00. NPD likely left it out.",
    ]);
  });

  it('two lines of the same amount: says "one of", never picks one', () => {
    const { why } = explain({
      hrisRows: [hris('amb@simple.biz', 11600)],
      paste: `amb@simple.biz\t${dollars(cents(11100))}`,
      paystubs: { 'amb@simple.biz': [stub(11600, { tech_bonus: 500, other_bonuses: 500 })] },
    });
    assert.deepEqual(why('amb@simple.biz'), [
      "likely: NPD is ₱500.00 lower: exactly HRIS's Tech Allowance ₱500.00 or Performance Bonus (KPI) ₱500.00. NPD likely left one of them out.",
    ]);
  });

  it('PAB and Tech together, when no single line fits', () => {
    const { why } = explain({
      hrisRows: [hris('two@simple.biz', 12350)],
      paste: `two@simple.biz\t${dollars(cents(10850))}`,
      paystubs: { 'two@simple.biz': [stub(12350, { tech_bonus: 500, perfect_attendance_bonus: 1000, other_bonuses: 250 })] },
    });
    assert.deepEqual(why('two@simple.biz'), [
      "likely: NPD is ₱1,500.00 lower: exactly HRIS's Tech Allowance ₱500.00 and Attendance Incentive ₱1,000.00. NPD likely left them out.",
    ]);
  });

  it('a deduction NPD did not take reads as NPD higher', () => {
    const { why } = explain({
      hrisRows: [hris('mesa@simple.biz', 10500)],
      paste: `mesa@simple.biz\t${dollars(cents(10600))}`,
      paystubs: { 'mesa@simple.biz': [stub(10500, { mesa_deduction: 100 })] },
    });
    assert.deepEqual(why('mesa@simple.biz'), [
      "likely: NPD is ₱100.00 higher: exactly HRIS's MESA Deduction -₱100.00. NPD likely left it out.",
    ]);
  });

  it('an adjustment line keeps its note', () => {
    const lines = paystubLines(stub(10100, { adjustment: -500 }, { adjustment_note: 'Sept correction' }));
    assert.ok(lines.some((l) => l.label === 'Adjustment (Sept correction)' && l.php === -500));
  });

  it('a ₱100 MESA contribution only NPD took', () => {
    const { why } = explain({
      hrisRows: [hris('m100@simple.biz', 10600)],
      paste: `m100@simple.biz\t${dollars(cents(10500))}`,
      paystubs: { 'm100@simple.biz': [stub(10600)] },
    });
    assert.deepEqual(why('m100@simple.biz'), [
      'likely: NPD is ₱100.00 lower: the MESA contribution. HRIS deducts no MESA this week; NPD looks to have taken it.',
    ]);
  });

  it('the bar is one cent, never the operator’s looser "off by"', () => {
    assert.equal(INFER_TOL_CENTS, 1);
    const lines = paystubLines(stub(12600, { other_bonuses: 2000 }));
    // NPD 2¢ away from "KPI left out": inside a 3¢ match tolerance, outside the inference bar.
    assert.equal(linesExplainingGap(lines, 12600, cents(10600) + 2, FX, INFER_TOL_CENTS).length, 0);
    assert.equal(linesExplainingGap(lines, 12600, cents(10600) + 1, FX, INFER_TOL_CENTS).length, 1);
  });

  it('an hours or salary line is only ever tried alone', () => {
    const lines = paystubLines(stub(11100, { tech_bonus: 500 }));
    const regular = lines.find((l) => l.label === 'Regular Hours')!;
    assert.equal(regular.base, true);
    // Regular + Tech left out = NPD $0.00 — never offered as a combination.
    assert.equal(linesExplainingGap(lines, 11100, 0, FX, 1).length, 0);
  });
});

describe('Mismatch — rate, hours and FX', () => {
  it('a different hourly rate, in ₱5 steps', () => {
    const php = 300 * 37.19;
    const { why } = explain({
      hrisRows: [hris('rate@simple.biz', php)],
      paste: `rate@simple.biz\t${dollars(cents(190 * 37.19))}`,
      paystubs: { 'rate@simple.biz': [stub(php, { regular: php }, { hours: { total: 37.19, regular: 37.19, ot: 0 } })] },
      facts: { 'rate@simple.biz': facts({ totalHours: 37.19, regularHours: 37.19, regularRate: 300, otRate: 450 }) },
    });
    assert.deepEqual(why('rate@simple.biz'), [
      "likely: Looks like a different hourly rate: NPD pays ₱110.00/h lower than HRIS's ₱300.00/h, over 37.19h.",
    ]);
  });

  // Hours are priced the way the week is: regular to 40, overtime past it, so fewer hours come
  // off overtime first. (Measured 09-27: a 2.00h-shorter week on 42.29h first read as "3.00h of
  // regular", the same pesos, until the hours were priced against the 40h line.)
  const H = { totalHours: 42.29, regularHours: 40, otHours: 2.29, regularRate: 300, otRate: 450 };
  const phpH = 40 * 300 + 2.29 * 450;

  it('fewer hours come off overtime first', () => {
    const { why } = explain({
      hrisRows: [hris('hrs@simple.biz', phpH)],
      paste: `hrs@simple.biz\t${dollars(cents(phpH - 2 * 450))}`,
      facts: { 'hrs@simple.biz': facts(H) },
    });
    assert.deepEqual(why('hrs@simple.biz'), ['likely: Looks like an hours difference: NPD pays for 40.29h, HRIS for 42.29h (2.00h fewer).']);
  });

  it('fewer hours across the 40h line: the overtime, then regular hours', () => {
    const { why } = explain({
      hrisRows: [hris('x40@simple.biz', phpH)],
      paste: `x40@simple.biz\t${dollars(cents(phpH - 2.29 * 450 - 0.71 * 300))}`,
      facts: { 'x40@simple.biz': facts(H) },
    });
    assert.deepEqual(why('x40@simple.biz'), ['likely: Looks like an hours difference: NPD pays for 39.29h, HRIS for 42.29h (3.00h fewer).']);
  });

  it('a hundredth of an hour is a rounding slip', () => {
    const { why } = explain({
      hrisRows: [hris('rnd@simple.biz', 12000)],
      paste: `rnd@simple.biz\t${dollars(cents(12000 - 3))}`,
      facts: { 'rnd@simple.biz': facts({ regularRate: 300, otRate: 450 }) },
    });
    const w = why('rnd@simple.biz');
    assert.equal(w.length, 1);
    // The size only, never whose hours moved (one of three real cases had the same hours both sides).
    assert.match(w[0], /^likely: A rounding-sized gap \(≈₱\d\.\d\d, the pay for about 0\.01h\): the two sides rounded hours or pay differently\.$/);
    assert.doesNotMatch(w[0], /NPD pays for/);
  });

  it('three or more rows on one other rate: the pesos agree, NPD used another FX', () => {
    const at = (php: number) => dollars(Math.round((php / 61.6) * 100));
    const { why } = explain({
      hrisRows: [hris('a@simple.biz', 20000), hris('b@simple.biz', 15000), hris('c@simple.biz', 30000)],
      paste: [`a@simple.biz\t${at(20000)}`, `b@simple.biz\t${at(15000)}`, `c@simple.biz\t${at(30000)}`].join('\n'),
    });
    for (const e of ['a@simple.biz', 'b@simple.biz', 'c@simple.biz']) {
      assert.deepEqual(why(e), [
        "likely: The pesos agree: NPD converted at ₱61.60 per $1, not this cycle's ₱61.52 (3 mismatched rows are on that rate).",
      ]);
    }
  });

  it('one row on another rate proves nothing and says nothing about FX', () => {
    const { why } = explain({
      hrisRows: [hris('a@simple.biz', 20000)],
      paste: `a@simple.biz\t${dollars(Math.round((20000 / 61.6) * 100))}`,
    });
    const w = why('a@simple.biz');
    assert.equal(w.length, 1);
    assert.doesNotMatch(w[0], /per \$1/);
    assert.match(w[0], /^lead: NPD is ≈₱\d+\.\d\d lower, and no line of HRIS's paystub accounts for it\. \(No staged paystub to compare\.\)$/);
  });

  it('a round amount more is a bonus lead, never "10.00h more" at a ₱500/h rate', () => {
    const php = 50.02 * 500;
    const { why } = explain({
      hrisRows: [hris('gyd@simple.biz', php)],
      paste: `gyd@simple.biz\t${dollars(cents(php + 5000))}`,
      paystubs: { 'gyd@simple.biz': [stub(php, { regular: php, perfect_attendance_bonus: 0 }, { hours: { total: 50.02, regular: 50.02, ot: 0 } })] },
      facts: { 'gyd@simple.biz': facts({ totalHours: 50.02, regularHours: 50.02, regularRate: 500, otRate: 750, otIsDifferential: true }) },
    });
    const w = why('gyd@simple.biz');
    assert.equal(w.length, 1);
    assert.match(
      w[0],
      /^lead: NPD is ≈₱5,000\.\d\d higher, a round amount like a bonus\. HRIS pays: no Tech Allowance · no Attendance Incentive · no Performance Bonus \(KPI\)\. NPD may pay a bonus HRIS does not, or a bigger one\.$/,
    );
  });

  it('NPD pays more past 40h and two stories give the same pesos: a lead naming both', () => {
    const php = 40 * 355 + 4.24 * 532.5;
    const { why } = explain({
      hrisRows: [hris('kyleb@simple.biz', php)],
      paste: `kyleb@simple.biz\t${dollars(cents(php + 10.5 * 355))}`,
      paystubs: { 'kyleb@simple.biz': [stub(php, { regular: 14200, ot: 4.24 * 532.5 }, { hours: { total: 44.24, regular: 40, ot: 4.24 } })] },
      facts: { 'kyleb@simple.biz': facts({ totalHours: 44.24, regularHours: 40, otHours: 4.24, regularRate: 355, otRate: 532.5 }) },
    });
    assert.deepEqual(why('kyleb@simple.biz'), [
      'lead: NPD is ≈₱3,727.50 higher: either more hours (NPD pays for 51.24h, HRIS for 44.24h (7.00h more)), or 10.50h at their ₱355.00/h rate paid outside the timesheet (orphanage, a time adjustment).',
    ]);
  });

  it('under 40h, extra hours at the plain rate are only one story: a lead for hours outside the timesheet', () => {
    // 30h at ₱300: 3.25h more timesheet hours is 30h → 33.25h, all regular — the same as 3.25h at
    // the plain rate, so the one story is said as an hours difference.
    const { why } = explain({
      hrisRows: [hris('u40@simple.biz', 9000)],
      paste: `u40@simple.biz	${dollars(cents(9000 + 3.25 * 300))}`,
      facts: { 'u40@simple.biz': facts({ totalHours: 30, regularHours: 30, regularRate: 300, otRate: 450 }) },
    });
    assert.deepEqual(why('u40@simple.biz'), ['likely: Looks like an hours difference: NPD pays for 33.25h, HRIS for 30.00h (3.25h more).']);
  });

  it('NPD pays more, not a round amount: a lead with HRIS’s bonus lines', () => {
    const php = 40 * 265 + 16.97 * 397.5;
    const { why } = explain({
      hrisRows: [hris('qc@simple.biz', php)],
      paste: `qc@simple.biz\t${dollars(cents(php + 480.33))}`,
      paystubs: { 'qc@simple.biz': [stub(php, { regular: 10600, ot: 16.97 * 397.5, perfect_attendance_bonus: 0 }, { hours: { total: 56.97, regular: 40, ot: 16.97 } })] },
      facts: { 'qc@simple.biz': facts({ totalHours: 56.97, regularHours: 40, otHours: 16.97 }) },
    });
    const w = why('qc@simple.biz');
    assert.equal(w.length, 1);
    assert.match(
      w[0],
      /^lead: NPD is ≈₱480\.\d\d higher\. HRIS pays: no Tech Allowance · no Attendance Incentive · no Performance Bonus \(KPI\)\. NPD may pay a bonus HRIS does not, or a bigger one\.$/,
    );
  });

  it('nothing fits: a lead with the gap and HRIS’s bonus lines, never a guess', () => {
    const { why } = explain({
      hrisRows: [hris('odd@simple.biz', 12345.67)],
      paste: `odd@simple.biz\t${dollars(cents(12345.67 - 987.65))}`,
      paystubs: { 'odd@simple.biz': [stub(12345.67, { regular: 12345.67 })] },
      facts: { 'odd@simple.biz': facts({ salaried: true, regularRate: null }) },
    });
    const w = why('odd@simple.biz');
    assert.equal(w.length, 1);
    assert.match(
      w[0],
      /^lead: NPD is ≈₱98\d\.\d\d lower, and no line of HRIS's paystub accounts for it\. HRIS pays: no Tech Allowance · no Attendance Incentive · no Performance Bonus \(KPI\)\.$/,
    );
  });
});

describe('Mismatch — NPD’s own lines', () => {
  it('two NPD lines where one alone is HRIS’s figure: NPD has them twice', () => {
    const { why } = explain({
      hrisRows: [hris('dup@simple.biz', 250 * FX)],
      paste: 'dup@simple.biz\t250.00\ndup@simple.biz\t250.00',
    });
    assert.deepEqual(why('dup@simple.biz'), [
      'found: NPD lists them on 2 lines (line 1 and line 2), added together. line 1 alone matches HRIS, so NPD looks to have them twice.',
    ]);
  });

  it('another NPD line for them was skipped, labelled with its NPD row on a feed', () => {
    const feed = [
      'NPD locked sheets, week 2026-09-27: All Departments v3, HSL v5\tWork Email\tPHP USD Conversion',
      'All Departments row 1\tsk@simple.biz\t$100.00',
      'HSL row 40\tsk@simple.biz\t#VALUE!',
    ].join('\n');
    const { why } = explain({ hrisRows: [hris('sk@simple.biz', 300 * FX)], paste: feed });
    assert.match(why('sk@simple.biz')[0], /^found: Another NPD line for them was skipped \(HSL row 40\): "#VALUE!" is not a dollar amount/);
  });
});

// ─── Not in NPD ───────────────────────────────────────────────────────────────

describe('Not in NPD', () => {
  it('NPD’s line for them was skipped', () => {
    const feed = [
      'NPD locked sheets, week 2026-09-27: All Departments v3, HSL v5\tWork Email\tPHP USD Conversion',
      'All Departments row 2\tother@simple.biz\t$10.00',
      'All Departments row 431\trheyr@simple.biz\t#N/A',
    ].join('\n');
    const { why } = explain({ hrisRows: [hris('rheyr@simple.biz', 9000)], paste: feed, facts: { 'rheyr@simple.biz': facts() } });
    assert.match(why('rheyr@simple.biz')[0], /^found: NPD has a line for them that was skipped \(All Departments row 431\): "#N\/A" is not a dollar amount/);
  });

  it('paid in COP, and NPD lists none of the week’s COP-paid people', () => {
    const { why } = explain({
      hrisRows: [hris('arturoa@simple.biz', 7727.82), hris('soniaa@simple.biz', 6673.32), hris('ph@simple.biz', 250 * FX)],
      paste: 'ph@simple.biz\t250.00',
      facts: {
        'arturoa@simple.biz': facts({ settlement: 'COP', department: 'Client VA' }),
        'soniaa@simple.biz': facts({ settlement: 'COP', department: 'Client VA' }),
        'ph@simple.biz': facts(),
      },
    });
    assert.deepEqual(why('arturoa@simple.biz'), [
      "found: Paid in COP (Colombia). NPD lists none of this week's 2 COP-paid people.",
    ]);
  });

  it('a final paycheck and a first paycheck', () => {
    const { why } = explain({
      hrisRows: [hris('leaver@simple.biz', 5000), hris('newbie@simple.biz', 4000), hris('x@simple.biz', 100 * FX)],
      paste: 'x@simple.biz\t100.00',
      facts: {
        'leaver@simple.biz': facts({ finalPay: { offboardedAt: '2026-09-30T10:00:00Z' } }),
        'newbie@simple.biz': facts({ firstPaycheck: true, startDate: '09/29/26' }),
      },
    });
    assert.deepEqual(why('leaver@simple.biz'), ['found: Final paycheck: offboarded Sep 30, 2026. NPD may have taken them off already.']);
    assert.deepEqual(why('newbie@simple.biz'), [
      'found: First paycheck: their first Hubstaff hours are this week (start date 09/29/26). NPD may not have added them yet.',
    ]);
  });

  it('HRIS pays ₱0.00 (no pay rate on file)', () => {
    const { why } = explain({
      hrisRows: [hris('jamesls@simple.biz', 0), hris('x@simple.biz', 100 * FX)],
      paste: 'x@simple.biz\t100.00',
      facts: { 'jamesls@simple.biz': facts({ regularRate: null, totalHours: 12.72 }) },
    });
    assert.deepEqual(why('jamesls@simple.biz'), [
      'found: HRIS pays ₱0.00 this week (no pay rate on file), so there is nothing for NPD to list.',
    ]);
  });

  it('nothing known: a lead naming NPD’s tab for their department', () => {
    const { why } = explain({
      hrisRows: [hris('mariab@simple.biz', 9216.32), hris('hsl@simple.biz', 9000), hris('x@simple.biz', 100 * FX)],
      paste: 'x@simple.biz\t100.00',
      facts: {
        'mariab@simple.biz': facts({ totalHours: 44.63 }),
        'hsl@simple.biz': facts({ isHsl: true, department: 'Hogan Smith Law' }),
      },
    });
    assert.deepEqual(why('mariab@simple.biz'), [
      "lead: NPD has no line for this work email. HRIS pays them in Lead Gen (44.63h). Look for them on NPD's All Departments tab under another address or name.",
    ]);
    assert.match(why('hsl@simple.biz')[0], /on NPD's HSL tab/);
  });

  it('a tiny week is a lead', () => {
    const { why } = explain({
      hrisRows: [hris('cyruss@simple.biz', 65.48), hris('x@simple.biz', 100 * FX)],
      paste: 'x@simple.biz\t100.00',
      facts: { 'cyruss@simple.biz': facts({ totalHours: 0.37 }) },
    });
    assert.equal(why('cyruss@simple.biz')[0], 'lead: Only 0.37h this week (₱65.48). NPD may have left out a small payout.');
  });
});

// ─── Not in HRIS ──────────────────────────────────────────────────────────────

describe('Not in HRIS', () => {
  const base = { hrisRows: [hris('kaner@simple.biz', 250 * FX)], paste: 'stranger@simple.biz\t12.00' };

  it('waits for the roster lookup, and says so (Export waits too)', () => {
    const { why, reasons } = explain({ ...base, identities: { state: 'loading' } });
    assert.deepEqual(why('stranger@simple.biz'), ['pending: Looking this address up in HRIS…']);
    assert.equal(hrisNpdReasonsPending(reasons), true);
  });

  it('a failed lookup says it failed — never "not on the roster"', () => {
    const { why } = explain({ ...base, identities: { state: 'error', message: 'HTTP 502.' } });
    const w = why('stranger@simple.biz');
    assert.equal(w[0], "lead: Couldn't check HRIS's roster for this address: HTTP 502.");
    assert.ok(!w.some((x) => /not on the roster/.test(x)));
  });

  it('no one has the address, with a one-letter typo lead to a Not in NPD row', () => {
    const { why } = explain({
      hrisRows: [hris('kaner@simple.biz', 250 * FX)],
      paste: 'kanr@simple.biz\t250.00',
      identities: { state: 'ready', byEmail: { 'kanr@simple.biz': [] } },
    });
    assert.deepEqual(why('kanr@simple.biz'), [
      'found: No one in HRIS has this address: it is not on the roster, active or offboarded.',
      'lead: Did NPD mean kaner@simple.biz? It is 1 letter off and shows as Not in NPD.',
    ]);
  });

  it('their personal email: both rows say so, and both stay what they are (never a join)', () => {
    const { why, rowOf } = explain({
      hrisRows: [hris('kaner@simple.biz', 250 * FX)],
      paste: 'kane.personal@gmail.com\t250.00',
      identities: {
        state: 'ready',
        byEmail: {
          'kane.personal@gmail.com': [
            match({ name: 'Reroma, Kane', workEmail: 'kaner@simple.biz', personalEmail: 'kane.personal@gmail.com', matchedBy: 'personal' }),
          ],
        },
      },
    });
    assert.equal(rowOf('kane.personal@gmail.com').status, 'not_in_hris');
    assert.equal(rowOf('kaner@simple.biz').status, 'not_in_npd');
    assert.deepEqual(why('kane.personal@gmail.com'), [
      "found: This is Reroma, Kane's personal email. HRIS pays them as kaner@simple.biz, which shows as Not in NPD: NPD used the wrong address.",
    ]);
    assert.deepEqual(why('kaner@simple.biz'), [
      'found: NPD lists them as kane.personal@gmail.com (their personal email), not their work email. That line shows as Not in HRIS.',
    ]);
  });

  it('offboarded before this week, with the reason, and no hours', () => {
    const { why } = explain({
      hrisRows: [hris('kaner@simple.biz', 250 * FX)],
      paste: 'kaner@simple.biz\t250.00\njazminer@simple.biz\t111.68',
      identities: {
        state: 'ready',
        byEmail: {
          'jazminer@simple.biz': [
            match({
              name: 'Roa, Sajda "Jazmine"',
              workEmail: 'jazminer@simple.biz',
              department: 'hsl:hearing_prep_mail_sorting',
              offboardedAt: '2026-09-24T12:59:16.032+00:00',
              offboardedReason: 'resigned',
            }),
          ],
        },
      },
    });
    assert.deepEqual(why('jazminer@simple.biz'), [
      'found: Roa, Sajda "Jazmine" was offboarded Sep 24, 2026 (resigned), before this week.',
      'found: No Hubstaff hours this week under any of their addresses, so HRIS has nothing to pay them.',
    ]);
  });

  it('on the roster with no hours; on the roster WITH hours is only a lead', () => {
    const ids: HrisNpdIdentityState = {
      state: 'ready',
      byEmail: {
        'brad@simple.biz': [match({ name: 'Maxwell, Brad', workEmail: 'brad@simple.biz', department: 'Sales', startDate: '05/18/20' })],
      },
    };
    const none = explain({ ...base, paste: 'brad@simple.biz\t0.00', identities: ids });
    assert.deepEqual(none.why('brad@simple.biz'), [
      'found: Maxwell, Brad is on the roster (Sales, start date 05/18/20) but has no Hubstaff hours this week under any of their addresses, so HRIS has nothing to pay.',
      "lead: NPD's figure for them is $0.00.",
    ]);
    const some = explain({ ...base, paste: 'brad@simple.biz\t10.00', identities: ids, timesheet: ['brad@simple.biz'] });
    assert.match(some.why('brad@simple.biz')[0], /^lead: Maxwell, Brad is on the roster \(Sales\) and has Hubstaff hours this week \(brad@simple\.biz\), but no payable row\. Check the Final Pay table\.$/);
  });

  it('asks the lookup about exactly the Not in HRIS addresses, and nothing while held', () => {
    const { comparison } = explain({ ...base, paste: 'kaner@simple.biz\t250.00\nB@x.com\t1.00\na@x.com\t2.00' });
    assert.deepEqual(hrisNpdIdentityEmails(comparison), ['a@x.com', 'b@x.com']);
    const held = compareHrisNpd({ hrisRows: [], npdRows: parseNpdPaste('a@x.com\t1.00').rows, fxRate: FX, hrisState: 'pending' });
    assert.deepEqual(hrisNpdIdentityEmails(held), []);
  });
});

// ─── General ──────────────────────────────────────────────────────────────────

describe('Why — general rules', () => {
  it('nothing while the verdicts are held (loading, a failed source, FX 0)', () => {
    for (const compare of [
      { hrisState: 'pending' as const },
      { hrisState: 'unavailable' as const, unavailableSources: ['additions' as const] },
      { fxRate: 0 },
    ]) {
      const parse = parseNpdPaste('a@simple.biz\t1.00\nb@simple.biz\t2.00');
      const comparison = compareHrisNpd({ hrisRows: [hris('a@simple.biz', 500)], npdRows: parse.rows, fxRate: FX, hrisState: 'settled', ...compare });
      const reasons = explainHrisNpd({
        comparison,
        parse,
        sourceText: '',
        fxRate: compare.fxRate ?? FX,
        facts: new Map(),
        paystubs: new Map(),
        identities: READY_NONE,
        timesheetEmails: new Set(),
        weekStart: null,
      });
      assert.equal(reasons.size, 0, JSON.stringify(compare));
    }
  });

  it('a Match has no reason', () => {
    const { reasons, rowOf } = explain({ hrisRows: [hris('kaner@simple.biz', 250 * FX)], paste: 'kaner@simple.biz\t250.00' });
    assert.equal(rowOf('kaner@simple.biz').status, 'match');
    assert.equal(reasons.size, 0);
  });

  it('reads no NPD column but the two the step reads (npd-dashboard.md "Two columns only")', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/payroll/hris-npd-reasons.ts'), 'utf8');
    assert.doesNotMatch(src, /@\/lib\/npd\//);
    assert.doesNotMatch(src, /tech_bonus|attendance_bonus|performance_bonus|total_pay_php|regular_total_hours/);
  });

  it('strength travels as words: "Likely:" / "Check:" / the fact itself', () => {
    assert.equal(reasonText({ tone: 'likely', text: 'x' }), 'Likely: x');
    assert.equal(reasonText({ tone: 'lead', text: 'x' }), 'Check: x');
    assert.equal(reasonText({ tone: 'found', text: 'x' }), 'x');
    assert.equal(reasonDate('2026-09-24T12:59:16.032+00:00'), 'Sep 24, 2026');
    assert.equal(reasonDate('garbage'), null);
  });
});

// ─── The roster lookup ────────────────────────────────────────────────────────

const gml = (over: Partial<MasterIdentityRow>): MasterIdentityRow => ({
  Name: null,
  Department: null,
  'Work Email': null,
  'Personal Email': null,
  'Alternate Work Email': null,
  'Alternate Work Email 2': null,
  'Start Date': null,
  off_boarded_at: null,
  off_boarded_reason: null,
  ...over,
});

describe('matchNpdIdentities / parseNpdIdentityPayload', () => {
  const rows = [
    gml({ Name: 'Carl Thomas', 'Work Email': 'carlt@simple.biz', 'Personal Email': 'Carla@simple.biz', Department: 'HSL', off_boarded_at: '2026-06-03T13:35:33Z', off_boarded_reason: 'resigned' }),
    gml({ Name: 'Carl Thomas', 'Work Email': 'carlt@simple.biz', 'Personal Email': 'carla@simple.biz', Department: 'Lead Gen', off_boarded_at: '2026-05-31T01:13:47Z', off_boarded_reason: 'resigned' }),
    gml({ Name: 'Thomas, Carla', 'Work Email': ' carla@simple.biz ', 'Alternate Work Email': 'carlat@simple.biz', Department: 'USEE' }),
    gml({ Name: 'Thomas, Carla', 'Work Email': 'carla@simple.biz', 'Alternate Work Email': 'carlat@simple.biz', Department: 'USEE' }),
  ];

  it('every address asked about has an entry; active rows first, then the latest leaver; duplicates once', () => {
    const out = matchNpdIdentities(rows, ['CARLA@simple.biz', 'carlat@simple.biz', 'nobody@simple.biz']);
    assert.deepEqual(Object.keys(out).sort(), ['carla@simple.biz', 'carlat@simple.biz', 'nobody@simple.biz']);
    assert.deepEqual(out['nobody@simple.biz'], []);
    const carla = out['carla@simple.biz'];
    assert.deepEqual(
      carla.map((m) => [m.matchedBy, m.department, m.offboardedAt?.slice(0, 10) ?? 'active']),
      [
        ['work', 'USEE', 'active'],
        ['personal', 'HSL', '2026-06-03'],
        ['personal', 'Lead Gen', '2026-05-31'],
      ],
    );
    assert.equal(out['carlat@simple.biz'][0].matchedBy, 'alternate');
  });

  it('a reply missing any address asked about is refused — absence is not "no one"', () => {
    const asked = ['a@x.com', 'b@x.com'];
    assert.equal(parseNpdIdentityPayload({ byEmail: { 'a@x.com': [] } }, asked), null);
    assert.equal(parseNpdIdentityPayload({ byEmail: { 'a@x.com': [], 'b@x.com': [{ name: 1 }] } }, asked), null);
    assert.equal(parseNpdIdentityPayload(null, asked), null);
    const ok = parseNpdIdentityPayload({ byEmail: { 'a@x.com': [], 'b@x.com': [match({ workEmail: 'b@x.com' })] } }, asked);
    assert.ok(ok);
    assert.equal(ok!['b@x.com'][0].workEmail, 'b@x.com');
  });
});

// ─── Wiring ───────────────────────────────────────────────────────────────────

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

describe('Why — wiring', () => {
  it('the route: POST only, the wizard view grant, the whole master list paged, no writes, a failed read is 502', () => {
    const src = read('app/api/payroll-wizard/npd-identities/route.ts');
    assert.match(src, /export async function POST\(/);
    assert.doesNotMatch(src, /export async function (GET|PUT|PATCH|DELETE)\(/);
    assert.match(src, /requireFeatureAccess\("accounting", "payroll_wizard", "view"\)/);
    assert.match(src, /selectAllPaged<MasterIdentityRow>/);
    assert.match(src, /\.range\(from, to\)/);
    assert.doesNotMatch(src, /\.(insert|update|upsert|delete)\(/);
    assert.match(src, /status: 502/);
    assert.match(src, /NPD_IDENTITY_MAX_EMAILS/);
  });

  it('the wizard explains the SAME comparison and parse the table renders, and hands the reasons to the one panel props object', () => {
    const src = read('src/components/PayrollWizard.tsx');
    const at = src.indexOf('return explainHrisNpd({');
    assert.ok(at > 0, 'explainHrisNpd call not found');
    const call = src.slice(at, src.indexOf('});', at));
    assert.match(call, /comparison: hrisNpdComparison,/);
    assert.match(call, /parse: npdParse,/);
    assert.match(call, /sourceText: npdSourceText,/);
    assert.match(src, /reasons: hrisNpdReasons,/);
    // The lookup runs only while the tab is open, and only for the Not in HRIS addresses.
    assert.match(src, /if \(!hrisNpdOpen \|\| !hrisNpdIdentityKey\) return;/);
    assert.match(src, /hrisNpdIdentityEmails\(hrisNpdComparison\)/);
  });

  it('paused includes roster people with no hours, only when EVERY master row of theirs is in a paused department', () => {
    const src = read('src/components/PayrollWizard.tsx');
    const at = src.indexOf('const npdPausedEmails = useMemo(() => {');
    const body = src.slice(at, src.indexOf('}, [calcResults, employeeDepts, pausedDeptKeys, masterEmployees, customDepartments]);', at));
    assert.ok(body.length > 0);
    assert.match(body, /for \(const emp of masterEmployees\)/);
    assert.match(body, /rows\.every\(/);
    assert.match(body, /normalizeDeptToKey\(label\) \?\?\s*resolveDeptKeyWithRegistry\(label, customDepartments\) \?\?\s*slugifyDeptKey\(label\)/);
    assert.match(body, /emp\.personal_email, emp\.alternate_work_email, emp\.alternate_work_email_2/);
  });

  it('a paused roster person NPD lists is left out, never Not in HRIS — and a payable person never is', () => {
    const parse = parseNpdPaste('brad@simple.biz\t0.00\npaid@simple.biz\t100.00');
    const c = compareHrisNpd({
      hrisRows: [hris('paid@simple.biz', 100 * FX)],
      npdRows: parse.rows,
      fxRate: FX,
      hrisState: 'settled',
      pausedEmails: new Set(['brad@simple.biz', 'paid@simple.biz']),
    });
    assert.deepEqual(c.leftOut.map((l) => [l.workEmail, l.reason]), [['brad@simple.biz', 'paused']]);
    assert.equal(c.rows.find((r) => r.workEmail === 'paid@simple.biz')?.status, 'match');
    assert.ok(!c.rows.some((r) => r.workEmail === 'brad@simple.biz'));
  });
});

// ─── Rendered ─────────────────────────────────────────────────────────────────

describe('Why — rendered', () => {
  function render(reasons: Map<string, Array<{ tone: 'found' | 'likely' | 'lead' | 'pending'; text: string }>>) {
    const parse = parseNpdPaste('kaner@simple.biz\t250.00\nlorar@simple.biz\t200.00\nnpdonly@simple.biz\t12.00');
    const comparison = compareHrisNpd({
      hrisRows: [hris('kaner@simple.biz', 250 * FX), hris('lorar@simple.biz', 279.17 * FX)],
      npdRows: parse.rows,
      fxRate: FX,
      hrisState: 'settled',
    });
    const key = (e: string) => comparison.rows.find((r) => r.workEmail === e)!.key;
    const byKey = new Map([...reasons].map(([e, list]) => [key(e), list]));
    return renderToStaticMarkup(
      React.createElement(HrisNpdComparison, {
        pasteText: '',
        onPasteChange: () => {},
        parse,
        npdFeed: { view: { state: 'loading' }, refreshing: false, lastError: null, checkedAt: null, onRefresh: () => {} },
        comparison,
        fxRate: FX,
        hrisPeople: 2,
        periodLabel: null,
        step: 'output',
        onStepChange: () => {},
        toleranceCents: comparison.toleranceCents,
        onToleranceChange: () => {},
        search: '',
        onSearchChange: () => {},
        filter: 'all',
        onFilterChange: () => {},
        save: { latest: { state: 'ready', meta: null }, disabledReason: null, saving: false, savedThisOutput: false, onSave: () => {} },
        getPaystubs: () => new Map(),
        reasons: byKey,
      }),
    );
  }
  const rowFor = (html: string, email: string) => {
    const rows = html.split('<tr').slice(1).map((r) => `<tr${r.split('</tr>')[0]}`);
    return rows.find((r) => r.includes(email))!;
  };

  it('the reason sits under the person, with its strength in words; still four columns', () => {
    const html = render(
      new Map([
        ['lorar@simple.biz', [{ tone: 'likely' as const, text: "NPD is ₱4,800.00 lower: exactly HRIS's Attendance Incentive ₱4,800.00." }]],
        ['npdonly@simple.biz', [{ tone: 'found' as const, text: 'No one in HRIS has this address.' }]],
      ]),
    );
    assert.equal((html.match(/<th /g) ?? []).length, 4);
    const lora = rowFor(html, 'lorar@simple.biz');
    assert.match(lora, /aria-label="Why"/);
    assert.match(lora, />Likely<\/span>NPD is ₱4,800\.00 lower/);
    assert.match(rowFor(html, 'npdonly@simple.biz'), /No one in HRIS has this address\./);
    assert.doesNotMatch(rowFor(html, 'kaner@simple.biz'), /aria-label="Why"/);
  });

  it('Export CSV waits while a reason waits on the lookup', () => {
    const html = render(new Map([['npdonly@simple.biz', [{ tone: 'pending' as const, text: 'Looking this address up in HRIS…' }]]]));
    assert.match(html, /disabled="" title="Still looking up who the Not in HRIS addresses belong to\."/);
    assert.match(rowFor(html, 'npdonly@simple.biz'), /Looking this address up in HRIS…/);
  });
});
