import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { NPD_COLUMNS, type NpdSheetKind } from './columns';
import {
  NPD_DEFAULT_FORMULAS,
  applyFormulasToEdit,
  checkStoredFormula,
  columnLetter,
  evaluateRow,
  formatSheetNumber,
  parseSheetNumber,
  parseUsdPerPhp,
  recomputeAfterSettingsChange,
  recomputeRow,
  referencedKeys,
  toDisplayFormula,
  toStoredFormula,
  type FormulaRow,
  type NpdFormulaContext,
} from './formulas';

const ALL = NPD_COLUMNS.all_departments;
const HSL = NPD_COLUMNS.hsl;
const NO_CTX: NpdFormulaContext = { columnFormulas: {}, rate: null };
const RATE: NpdFormulaContext = { columnFormulas: {}, rate: 0.0162575 };

function row(sheet: NpdSheetKind, cells: Record<string, string>, extra: Partial<FormulaRow> = {}): FormulaRow {
  const cols = NPD_COLUMNS[sheet];
  return { id: 'r1', values: cols.map((c) => cells[c.key] ?? ''), overrides: [], formulas: {}, ...extra };
}
const at = (sheet: NpdSheetKind, r: FormulaRow, key: string) => r.values[NPD_COLUMNS[sheet].findIndex((c) => c.key === key)];

describe('parseSheetNumber reads cells the way the sheet does', () => {
  test('numbers in every shape a copy from Google Sheets produces', () => {
    for (const [raw, n] of [
      ['40', 40],
      ['₱1,234.56', 1234.56],
      ['$20.00', 20],
      ['-100.00', -100],
      ['(100.00)', -100],
      ['−100', -100],
      ['PHP 100', 100],
      ['.5', 0.5],
    ] as const) {
      const v = parseSheetNumber(raw);
      assert.ok(v.ok && v.n === n, `${raw} → ${n}`);
    }
  });

  test('empty is 0; a space or a word is TEXT, not a number and not an error', () => {
    const e = parseSheetNumber('');
    assert.ok(e.ok && e.n === 0);
    for (const raw of [' ', 'Salary', '1,23,4', '12abc']) {
      const v = parseSheetNumber(raw);
      assert.ok(v.ok && typeof v.s === 'string', raw);
    }
  });

  test('an error cell passes its own error', () => {
    const v = parseSheetNumber('#N/A');
    assert.ok(!v.ok && v.err === '#N/A');
  });
});

describe('formulas: typed in the sheet’s notation, stored by column key', () => {
  test('=H5*1.5 in row 5 is stored as ={regular_rate}*1.5 and shown back the same', () => {
    const h = columnLetter(ALL.findIndex((c) => c.key === 'regular_rate'));
    assert.equal(h, 'H');
    const stored = toStoredFormula('=H5*1.5', 5, ALL);
    assert.equal(stored, '={regular_rate}*1.5');
    assert.equal(toDisplayFormula(stored, 5, ALL), '=H5*1.5');
    assert.equal(toDisplayFormula(stored, 12, ALL), '=H12*1.5', 'a stored formula follows its row');
  });

  test('functions, RATE, ranges and lower case are accepted', () => {
    assert.equal(toStoredFormula('=max(0, g3-40)', 3, ALL), '=MAX(0,{regular_total_hours}-40)');
    assert.equal(toStoredFormula('=X3*rate', 3, ALL), '={total_pay_php}*RATE');
    assert.equal(toStoredFormula('=SUM(S3:V3)', 3, ALL), '=SUM({tech_bonus}:{additional_bonus})');
  });

  test('refused: another row, a column off the sheet, another tab, an unknown function or name', () => {
    assert.throws(() => toStoredFormula('=H4*1.5', 5, ALL), /row 4/);
    assert.throws(() => toStoredFormula('=ZZ5*1.5', 5, ALL), /not on this sheet/);
    assert.throws(() => toStoredFormula("='7/6 hours'!A5", 5, ALL), /this sheet/);
    assert.throws(() => toStoredFormula('=VLOOKUP(H5)', 5, ALL), /not an NPD function/);
    assert.throws(() => toStoredFormula('=H5*BONUS', 5, ALL), /Unknown name/);
    assert.throws(() => toStoredFormula('H5*1.5', 5, ALL), /starts with "="/);
    assert.throws(() => toStoredFormula('=(H5*1.5', 5, ALL), /not closed/);
  });

  test('checkStoredFormula is what the route trusts', () => {
    assert.equal(checkStoredFormula('={regular_rate}*1.5', 'all_departments'), null);
    assert.match(checkStoredFormula('={mf_rate}*1.5', 'all_departments') ?? '', /Unknown column/);
    assert.match(checkStoredFormula('=1+', 'all_departments') ?? '', /ends too soon/);
    assert.match(checkStoredFormula(`=${'1+'.repeat(300)}1`, 'all_departments') ?? '', /limited/);
  });
});

describe('the defaults ARE the Google Sheet’s formulas (2026-10-01)', () => {
  // The sheet's own letters for each NPD key, per tab, read the same day.
  const SHEET_LETTERS: Record<NpdSheetKind, Record<string, string>> = {
    all_departments: {
      regular_total_hours: 'AC', regular_rate: 'AD', ot_total_hours: 'AE', ot_rate: 'AF', hours_until_ot: 'AG',
      orphan_total_hours: 'AH', orphan_hours_total_pay: 'AI', midweek_new_rate_total_hours: 'AJ', midweek_new_hourly_rate: 'AK',
      total_hourly_pay: 'AM', mesa_contribution: 'AN', tech_bonus: 'AP', attendance_bonus: 'AQ', performance_bonus: 'AR',
      additional_bonus: 'AS', total_pay_php: 'AU', php_usd_conversion: 'AV',
    },
    hsl: {
      mf_total_hours: 'AA', mf_rate: 'AB', we_hours: 'AC', hogan_we_rate: 'AD', total_ot_hours: 'AE', ot_differential: 'AF',
      hours_until_ot: 'AG', orphan_total_hours: 'AH', orphan_hours_total_pay: 'AI', midweek_new_rate_total_hours: 'AJ',
      midweek_transition_hourly_rate: 'AK', total_hourly_pay: 'AM', mesa_contribution: 'AN', tech_bonus: 'AP',
      attendance_bonus: 'AQ', performance_bonus: 'AR', additional_bonus: 'AS', total_pay_php: 'AU', php_usd_conversion: 'AV',
    },
  };

  for (const sheet of ['all_departments', 'hsl'] as const) {
    test(`${sheet}: each default, in the sheet's letters, is the sheet's formula character for character`, () => {
      for (const d of NPD_DEFAULT_FORMULAS[sheet]) {
        assert.equal(checkStoredFormula(d.formula, sheet), null, `${d.key} parses`);
        if (d.key === 'php_usd_conversion') {
          assert.equal(d.formula, '={total_pay_php}*RATE');
          continue;
        }
        const asSheet = d.formula.replace(/\{([a-z0-9_]+)\}/g, (_, k: string) => SHEET_LETTERS[sheet][k] ?? `?${k}`);
        const expected = d.sheet.replace(/^[A-Z]+ /, '').replace(/ \(AO.*$/, '');
        // The one difference on record: the sheet's +AO (Orphan pay), which NPD does not have.
        assert.equal(asSheet, expected.replace('+AO', ''), d.key);
      }
    });
  }
});

describe('All Departments figures', () => {
  const base = { regular_total_hours: '40', regular_rate: '₱265.00', ot_total_hours: '2.5' };

  test('OT Rate, Hours Until OT and Total Hourly Pay', () => {
    const r = evaluateRow('all_departments', row('all_departments', base), NO_CTX);
    assert.equal(r.ot_rate!.text, '397.50');
    assert.equal(r.hours_until_ot!.text, '0.00');
    assert.equal(r.total_hourly_pay!.text, '11,593.75'); // 40×265 + 2.5×397.5
  });

  test('Total Pay PHP adds the bonuses and MESA as typed (−100), and USD uses RATE', () => {
    const r = evaluateRow(
      'all_departments',
      row('all_departments', { ...base, tech_bonus: '500', attendance_bonus: '₱300.00', mesa_contribution: '-100.00' }),
      RATE,
    );
    assert.equal(r.total_pay_php!.text, '12,293.75');
    assert.equal(r.php_usd_conversion!.text, formatSheetNumber(12293.75 * 0.0162575, 'usd'));
    assert.equal(r.php_usd_conversion!.text, '$199.87');
  });

  test('no rate → USD is blank (not $0.00, not an error)', () => {
    const r = evaluateRow('all_departments', row('all_departments', base), NO_CTX);
    assert.equal(r.php_usd_conversion!.kind, 'blank');
  });

  test('Orphan Hours Total Pay: under 40, crossing 40, already at 40', () => {
    const pay = (hours: string, orphan: string) =>
      evaluateRow('all_departments', row('all_departments', { regular_total_hours: hours, regular_rate: '100', orphan_total_hours: orphan }), NO_CTX)
        .orphan_hours_total_pay!.text;
    assert.equal(pay('30', '5'), '500.00'); // all at the regular rate
    assert.equal(pay('38', '5'), '650.00'); // 2 at 100 + 3 at 150
    assert.equal(pay('40', '5'), '750.00'); // all at the OT rate
  });

  test('"Salary" in the hours: Hours Until OT is 0 (text ranks above numbers) and pay is #VALUE!, like the sheet', () => {
    const r = evaluateRow('all_departments', row('all_departments', { regular_total_hours: 'Salary', regular_rate: '100' }), NO_CTX);
    assert.equal(r.hours_until_ot!.text, '0.00');
    assert.equal(r.total_hourly_pay!.text, '#VALUE!');
  });

  test('an error input spreads; #N/A stays #N/A', () => {
    const r = evaluateRow('all_departments', row('all_departments', { regular_total_hours: '#N/A', regular_rate: '100' }), NO_CTX);
    assert.equal(r.hours_until_ot!.text, '#N/A');
  });
});

describe('HSL figures', () => {
  test('WE Rate, OT, Differential and Total Hourly Pay', () => {
    const r = evaluateRow('hsl', row('hsl', { mf_total_hours: '38', mf_rate: '280', we_hours: '6' }), NO_CTX);
    assert.equal(r.hogan_we_rate!.text, '295.00');
    assert.equal(r.total_ot_hours!.text, '4.00');
    assert.equal(r.ot_differential!.text, '140.00');
    assert.equal(r.hours_until_ot!.text, '0.00');
    assert.equal(r.total_hourly_pay!.text, '12,970.00'); // 38×280 + 6×295 + 4×140
  });
});

describe('the evaluator', () => {
  const ctxWith = (columnFormulas: Record<string, string>): NpdFormulaContext => ({ columnFormulas, rate: null });

  test('IF is lazy: an error in the branch not taken does not spread', () => {
    const r = evaluateRow('all_departments', row('all_departments', { regular_rate: '#N/A', name: 'x' }), ctxWith({ tech_bonus: '=IF(1>0,5,{regular_rate})' }));
    assert.equal(r.tech_bonus!.text, '5.00');
  });

  test('a formula that reaches itself is #REF!', () => {
    const r = evaluateRow('all_departments', row('all_departments', { name: 'x' }), ctxWith({ tech_bonus: '={attendance_bonus}+1', attendance_bonus: '={tech_bonus}+1' }));
    assert.equal(r.tech_bonus!.text, '#REF!');
  });

  test('a range skips empty cells and text; ÷0 is #DIV/0!', () => {
    const r = evaluateRow(
      'all_departments',
      row('all_departments', { tech_bonus: '10', attendance_bonus: 'n/a', performance_bonus: '' , additional_bonus: '5' }),
      ctxWith({ total_pay_us_workers: '=SUM({tech_bonus}:{additional_bonus})', hris: '=1/0' }),
    );
    assert.equal(r.total_pay_us_workers!.text, '$15.00');
    assert.equal(r.hris!.text, '#DIV/0!');
  });

  test('"" as a column formula means that column has no formula', () => {
    const r = evaluateRow('all_departments', row('all_departments', { regular_rate: '100' }), ctxWith({ ot_rate: '' }));
    assert.equal(r.ot_rate, undefined);
  });
});

describe('typing over formulas, like the sheet', () => {
  const cols = ALL;
  const idx = (key: string) => cols.findIndex((c) => c.key === key);
  const typed = (r: FormulaRow, key: string, text: string): FormulaRow => {
    const values = [...r.values];
    values[idx(key)] = text;
    return { ...r, values };
  };
  const filled = recomputeRow('all_departments', row('all_departments', { regular_total_hours: '40', regular_rate: '265' }), NO_CTX);

  test('a recomputed row writes each formula figure into its cell', () => {
    assert.equal(at('all_departments', filled, 'ot_rate'), '397.50');
    assert.equal(at('all_departments', filled, 'total_hourly_pay'), '10,600.00');
  });

  test("a paste of the sheet's own figure stays a formula; a different figure is typed over it", () => {
    const [same] = applyFormulasToEdit('all_departments', [filled], [typed(filled, 'ot_rate', '397.50')], NO_CTX);
    assert.deepEqual(same!.overrides, []);
    const [diff] = applyFormulasToEdit('all_departments', [filled], [typed(filled, 'ot_rate', '400')], NO_CTX);
    assert.deepEqual(diff!.overrides, ['ot_rate']);
    assert.equal(at('all_departments', diff!, 'ot_rate'), '400', 'the typed text is kept verbatim');
  });

  test('later formulas read the typed value', () => {
    const withOt = typed(filled, 'ot_total_hours', '2');
    const [r] = applyFormulasToEdit('all_departments', [filled], [typed(withOt, 'ot_rate', '400')], NO_CTX);
    assert.equal(at('all_departments', r!, 'total_hourly_pay'), '11,400.00'); // 40×265 + 2×400
  });

  test('clearing a typed-over cell gives it back to the formula', () => {
    const [over] = applyFormulasToEdit('all_departments', [filled], [typed(filled, 'ot_rate', '400')], NO_CTX);
    const [back] = applyFormulasToEdit('all_departments', [over!], [typed(over!, 'ot_rate', '')], NO_CTX);
    assert.deepEqual(back!.overrides, []);
    assert.equal(at('all_departments', back!, 'ot_rate'), '397.50');
  });

  test('typing =… makes it that cell’s own formula (this row’s references only)', () => {
    const [r] = applyFormulasToEdit('all_departments', [filled], [typed(filled, 'ot_rate', '=H1*2')], NO_CTX);
    assert.equal(r!.formulas.ot_rate, '={regular_rate}*2');
    assert.equal(at('all_departments', r!, 'ot_rate'), '530.00');
    const [bad] = applyFormulasToEdit('all_departments', [filled], [typed(filled, 'tech_bonus', '=H9*2')], NO_CTX);
    assert.equal(bad!.formulas.tech_bonus, undefined, 'another row’s cell is refused');
    assert.equal(at('all_departments', bad!, 'tech_bonus'), '=H9*2', 'and the text stays as typed');
  });

  test('a row with nothing typed in it shows no formula figures', () => {
    const blank = recomputeRow('all_departments', row('all_departments', {}), NO_CTX);
    assert.ok(blank.values.every((v) => v === ''));
  });

  test('setting the rate folds a pasted USD figure that now matches back into the formula', () => {
    const r0 = recomputeRow('all_departments', row('all_departments', { regular_total_hours: '40', regular_rate: '265' }), NO_CTX);
    const [pasted] = applyFormulasToEdit('all_departments', [r0], [typed(r0, 'php_usd_conversion', '$172.33')], NO_CTX);
    assert.deepEqual(pasted!.overrides, ['php_usd_conversion'], 'no rate yet: it can only be a typed value');
    const [after] = recomputeAfterSettingsChange('all_departments', [pasted!], RATE);
    assert.deepEqual(after!.overrides, [], '10,600 × 0.0162575 = 172.33');
    assert.equal(at('all_departments', after!, 'php_usd_conversion'), '$172.33');
  });
});

describe('the PHP→USD rate', () => {
  test('dollars per peso is accepted; pesos per dollar is refused with the conversion', () => {
    assert.deepEqual(parseUsdPerPhp('0.0162575'), { ok: true, rate: 0.0162575 });
    assert.deepEqual(parseUsdPerPhp(''), { ok: true, rate: null });
    const wrong = parseUsdPerPhp('61.51');
    assert.ok(!wrong.ok && /0\.0162575/.test(wrong.error));
    assert.equal(parseUsdPerPhp('0').ok, false);
    assert.equal(parseUsdPerPhp('abc').ok, false);
  });

  test('referencedKeys lists what a formula reads, for the legend under the editor', () => {
    assert.deepEqual(referencedKeys(NPD_DEFAULT_FORMULAS.hsl.find((f) => f.key === 'hogan_we_rate')!.formula), ['mf_rate']);
  });
});

void HSL;
