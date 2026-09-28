import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/* HSL KPI Rankings are ordered by the stored `calculated_bonus` (the card's whole pay), so
 * this read selects it. The projection STRING is pinned so it only changes on purpose, and
 * every value this module returns must come out of `toClientPayload` (counts + positions)
 * — `hsl-kpi-money-order.test.ts` proves that shape carries no peso. */

const SRC = readFileSync(path.join(__dirname, 'hsl-kpi-rankings.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('HSL KPI Rankings read', () => {
  it('the entry projection is exactly these six columns', () => {
    const m = /HSL_ENTRY_SELECT\s*=\s*'([^']*)'/.exec(SRC);
    assert.ok(m, 'expected the projection constant to be findable');
    assert.equal(m[1], 'period_start, period_end, period_type, employee_email, kpi_data, calculated_bonus');
  });

  it('the full read goes through that constant, weekly only; the probe and the catalog read select no pay', () => {
    assert.match(CODE, /from\('hsl_bonus_entries'\)\s*\.select\(HSL_ENTRY_SELECT\)\s*\.eq\('department', branch\)\s*\.eq\('period_type', 'weekly'\)/);
    assert.equal((CODE.match(/from\('hsl_bonus_entries'\)/g) ?? []).length, 2, 'the probe + the full read');
    assert.match(CODE, /from\('bonus_catalog_bonuses'\)\.select\('id, kind, formula'\)/);
    for (const [, arg] of CODE.matchAll(/\.select\(([^)]*)\)/g)) {
      assert.doesNotMatch(arg!, /\*/, `select(${arg}) must not read every column`);
      if (!arg!.includes('HSL_ENTRY_SELECT')) {
        assert.doesNotMatch(arg!, /amount|calculated_bonus/, `select(${arg}) must not read pay`);
      }
    }
  });

  it('the weekly payload is only ever toClientPayload(…) — never the loaded data', () => {
    const fn = CODE.slice(CODE.indexOf('export async function getHslKpiRankings'), CODE.indexOf('export async function getHslKpiDailyRankings'));
    const returns = [...fn.matchAll(/return\s+([^;]+);/g)].map((m) => m[1]!.trim());
    assert.ok(returns.length > 0);
    for (const r of returns) assert.match(r, /^(toClientPayload\(|empty\()/, `unexpected return: ${r}`);
  });

  it('ranks All only: neither order is given a metric', () => {
    const calls = [...CODE.matchAll(/buildMoneyOrder\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]!);
    assert.equal(calls.length, 2);
    for (const c of calls) assert.match(c, /metrics:\s*\[\]/);
  });

  it('the daily payload returns days and positions only', () => {
    const fn = CODE.slice(CODE.indexOf('export async function getHslKpiDailyRankings'));
    const returns = [...fn.matchAll(/return\s+(\{[\s\S]*?\});/g)].map((m) => m[1]!);
    assert.ok(returns.length >= 2);
    for (const r of returns) {
      assert.doesNotMatch(r, /\.\.\.|money|amount|calculated|loaded\.data/, `a daily return carries more than days/order/error: ${r}`);
    }
    assert.match(fn, /days:\s*days\.map\(\(d\)\s*=>\s*\(\{\s*email:\s*d\.email,\s*weekStart:\s*d\.weekStart,\s*days:\s*d\.days\s*\}\)\)/);
  });

  it('pages past the 1,000-row cap (Intake is 2,306 rows) and ranks on the HSL family roster', () => {
    assert.match(CODE, /selectAllPaged<HslEntryMoneyRow>/);
    assert.match(CODE, /departmentMatchesManagedAssignments\(e\.department, \[railKey\]\)/);
  });
});
