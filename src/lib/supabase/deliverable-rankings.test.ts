import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/* PM Team's Rankings are ordered by bonus pesos (Kane, 2026-09-26: *"based on their
 * Bonus … without displaying it"*), so this is the one My Team read that selects
 * `amount`. The projection STRING is pinned so it only changes on purpose, and every
 * value this module returns must come out of `toClientPayload` (counts + positions) —
 * the serialization test in `deliverable-money-order.test.ts` proves that shape carries
 * no peso. */

const SRC = readFileSync(path.join(__dirname, 'deliverable-rankings.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('KPI Rankings read', () => {
  it('the applied projection is exactly these seven columns', () => {
    const m = /DELIVERABLE_APPLIED_SELECT\s*=\s*'([^']*)'/.exec(SRC);
    assert.ok(m, 'expected the projection constant to be findable');
    assert.equal(m[1], 'period_start, period_end, employee_email, bonus_id, bonus_name, vars, amount');
  });

  it('the full read goes through that constant; the probes and catalog reads select no pay', () => {
    assert.match(CODE, /from\('bonus_catalog_applied'\)\s*\.select\(DELIVERABLE_APPLIED_SELECT\)/);
    // The full read + three one-row probes (any row · appointments · SP), which read period_start only.
    assert.equal((CODE.match(/from\('bonus_catalog_applied'\)/g) ?? []).length, 4);
    assert.equal((CODE.match(/\.select\('period_start'\)/g) ?? []).length, 3);
    // The catalog: `bonus_catalog_bonuses` HAS an `amount` column (fixed bonuses) — never read it.
    assert.match(CODE, /from\('bonus_catalog_bonuses'\)\.select\('id, kind, formula'\)/);
    assert.match(CODE, /from\('bonus_catalog_assignments'\)\s*\.select\('bonus_id, scope, department_key, shared_team'\)/);
    for (const [, arg] of CODE.matchAll(/\.select\(([^)]*)\)/g)) {
      assert.doesNotMatch(arg!, /\*/, `select(${arg}) must not read every column`);
      if (!arg!.includes('DELIVERABLE_APPLIED_SELECT')) {
        assert.doesNotMatch(arg!, /amount/, `select(${arg}) must not read pay`);
      }
    }
  });

  it('the weekly payload is only ever toClientPayload(…) — never the loaded data', () => {
    const fn = CODE.slice(CODE.indexOf('export async function getDeliverableRankings'), CODE.indexOf('export async function getDeliverableDailyRankings'));
    const returns = [...fn.matchAll(/return\s+([^;]+);/g)].map((m) => m[1]!.trim());
    assert.ok(returns.length > 0);
    for (const r of returns) assert.match(r, /^(toClientPayload\(|empty\()/, `unexpected return: ${r}`);
  });

  it('the daily payload returns days and positions only', () => {
    const fn = CODE.slice(CODE.indexOf('export async function getDeliverableDailyRankings'));
    const returns = [...fn.matchAll(/return\s+(\{[\s\S]*?\});/g)].map((m) => m[1]!);
    assert.ok(returns.length >= 2);
    for (const r of returns) {
      assert.doesNotMatch(r, /\.\.\.|money|amount|loaded\.data/, `a daily return carries more than days/order/error: ${r}`);
      const keys = [...r.matchAll(/(\w+):/g)].map((m) => m[1]).filter((k) => !['email', 'weekStart'].includes(k!));
      assert.deepEqual([...new Set(keys)].sort(), ['days', 'error', 'order'].filter((k) => keys.includes(k)).sort());
    }
    assert.match(fn, /days:\s*daysRes\.days\.map\(\(d\)\s*=>\s*\(\{\s*email:\s*d\.email,\s*weekStart:\s*d\.weekStart,\s*days:\s*d\.days\s*\}\)\)/);
  });

  it('pages past the 1,000-row cap (PM Team is 7,121 rows)', () => {
    assert.match(CODE, /selectAllPaged<AppliedMoneyRow>/);
  });
});
