/**
 * The Payment Catalog stores the currency it is given — COP included.
 *
 * Item 373 (2026-10-07). The editor offered PHP / USD / COP for both rates and KPI bonuses,
 * but `upsertPayStructure` and `upsertBonus` (and the bonus row mapper) coerced every
 * non-USD currency to PHP. A Colombian's 22,200 COP/hr was therefore stored, and paid, as
 * ₱22,200/hr, about 52× their pay; "Lead Gen (COP)" (=Appts*14000) paid 14,000 PESOS an
 * appointment. Kane ruled the figures COP and chose COP-denominated structures, so the two
 * halves of bonus-catalog.md §5.7 ship together:
 *
 *  1. every catalog read/write keeps COP (`toPayCurrency`);
 *  2. only a PESO structure is pushed to the PHP-denominated rate history / cache / sheets
 *     (`syncRateHistory`), otherwise the fix in 1 writes 22,200 into the peso history;
 *  3. the peso-only rate route refuses a person whose structure is not in pesos, instead of
 *     re-denominating it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toPayCurrency } from './pay-structure';

/** Source with line endings normalised to LF (the working tree is CRLF on Windows). */
const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

test('toPayCurrency keeps every supported currency, COP included', () => {
  assert.equal(toPayCurrency('PHP'), 'PHP');
  assert.equal(toPayCurrency('USD'), 'USD');
  assert.equal(toPayCurrency('COP'), 'COP');
});

test('toPayCurrency reads a legacy or unrecognised value as PHP', () => {
  assert.equal(toPayCurrency(null), 'PHP');
  assert.equal(toPayCurrency(undefined), 'PHP');
  assert.equal(toPayCurrency(''), 'PHP');
  assert.equal(toPayCurrency('EUR'), 'PHP');
  // The DB CHECK constrains upper-case codes; a lower-case value is not one of them.
  assert.equal(toPayCurrency('cop'), 'PHP');
});

test('no catalog read or write path hand-rolls a USD-or-PHP currency', () => {
  for (const rel of ['src/lib/supabase/pay-structures-db.ts', 'src/lib/supabase/bonus-catalog-db.ts']) {
    const src = read(rel);
    assert.ok(
      !/===\s*'USD'\s*\?\s*'USD'\s*:\s*'PHP'/.test(src),
      `${rel}: a USD-or-PHP ternary drops COP — use toPayCurrency`,
    );
    assert.ok(src.includes('toPayCurrency('), `${rel}: must narrow currencies through toPayCurrency`);
  }
  const structures = read('src/lib/supabase/pay-structures-db.ts');
  assert.ok(
    structures.includes('currency: toPayCurrency(s.currency)'),
    'upsertPayStructure writes the submitted currency',
  );
  assert.ok(structures.includes('currency: toPayCurrency(r.currency)'), 'mapRow reads the stored currency');
  const bonuses = read('src/lib/supabase/bonus-catalog-db.ts');
  assert.ok(bonuses.includes('currency: toPayCurrency(bonus.currency)'), 'upsertBonus writes the submitted currency');
  assert.equal(
    bonuses.split('currency: toPayCurrency(r.currency)').length - 1,
    2,
    'both bonus row mappers (definition + version) read the stored currency',
  );
});

test('only a PESO structure reaches the PHP-denominated rate history, cache and sheets', () => {
  const src = read('app/api/payment-catalog/pay-structures/route.ts');
  const start = src.indexOf('async function syncRateHistory(');
  assert.ok(start > 0, 'syncRateHistory must exist');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const gate = body.indexOf("if (s.currency === 'PHP') {");
  assert.ok(gate > 0, "syncRateHistory gates its peso writes on currency === 'PHP'");
  assert.ok(!body.includes("s.currency !== 'USD'"), "a !== 'USD' gate lets COP into the peso history");
  for (const write of [
    'insertRateHistoryRow(',
    'updateEmployeeRates(',
    'updateEmployeeRateInSheet(',
    'updateHslPayPlanRate(',
    ".from('employee_rate_history')",
  ]) {
    const at = body.indexOf(write);
    assert.ok(at > gate, `${write} must sit inside the PHP-only gate`);
  }
});

test('the peso-only rate route refuses a non-peso structure before writing anything', () => {
  const src = read('app/api/update-employee-rates/route.ts');
  const check = src.indexOf('listEmployeeStructuresForEmail(');
  assert.ok(check > 0, 'the route looks up the Pay Structure (emails compared in JS)');
  assert.ok(/st\.currency !== 'PHP'/.test(src), 'a USD/COP hourly structure is refused');
  assert.ok(src.includes('status: 409'), 'the refusal is a 409 naming Payment Catalog');
  for (const write of [".from('employee_rate_history')", 'insertRateHistoryRow(', 'updateEmployeeRates({']) {
    const at = src.indexOf(write);
    assert.ok(at > check, `${write} must come after the currency check`);
  }
});
