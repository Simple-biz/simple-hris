/**
 * Bonus Library bonuses on an HSL sub-team (Kane, 2026-09-22).
 *
 * The load-bearing claims: a catalog bonus folds into `calculated_bonus` and so
 * rides the existing HSL money path (no `bonus_catalog_applied` row, no `hsl:`
 * key in the payable set); its `kpi_data` keys can never collide with a schema
 * rule key; a non-PHP bonus is NOT paid because the HSL card has no FX; and the
 * bare family label is not a target.
 *
 * Run:  npx tsx --test src/lib/hsl-bonus/catalog-bonus.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HSL_CATALOG_KPI_PREFIX,
  calcHslCatalogBonus,
  calcHslCatalogTotal,
  catalogBonusVariables,
  catalogOnKey,
  catalogVarKey,
  hslCatalogBonusesFor,
  isScoreableOnHsl,
  withoutCatalogKeys,
} from './catalog-bonus';
import { HSL_DEPTS, HSL_DEPT_KEYS, calcBonus } from './schema';
import type { BonusAssignment, BonusDef } from '@/lib/bonus-catalog/types';

const flat = (over: Partial<BonusDef> = {}): BonusDef =>
  ({ id: 'b_flat', name: 'Spot Award', kind: 'flat', amount: 1500, currency: 'PHP', cadence: 'weekly', ...over }) as BonusDef;
const formula = (over: Partial<BonusDef> = {}): BonusDef =>
  ({
    id: 'b_form',
    name: 'Per Signup',
    kind: 'formula',
    formula: '=signups * 250',
    currency: 'PHP',
    cadence: 'weekly',
    ...over,
  }) as BonusDef;

const deptAssign = (bonusId: string, departmentKey: string, over: Partial<BonusAssignment> = {}): BonusAssignment =>
  ({ id: `a_${bonusId}`, bonusId, scope: 'department', departmentKey, ...over }) as BonusAssignment;

test('catalog keys can NEVER collide with a schema rule key', () => {
  for (const key of HSL_DEPT_KEYS) {
    for (const rule of HSL_DEPTS[key].rules) {
      assert.equal(
        rule.key.startsWith(HSL_CATALOG_KPI_PREFIX),
        false,
        `${key}.${rule.key} collides with the catalog namespace`,
      );
    }
  }
  assert.equal(catalogOnKey('b1'), 'catalog:b1');
  assert.equal(catalogVarKey('b1', 'signups'), 'catalog:b1:signups');
});

test('a sub-team assignment reaches the card; the BARE family never does', () => {
  const bonuses = [flat()];
  const got = hslCatalogBonusesFor({
    subLabel: 'hsl:intake_specialist',
    employeeEmail: 'a@simple.biz',
    assignments: [deptAssign('b_flat', 'hsl:intake_specialist')],
    bonuses,
  });
  assert.equal(got.length, 1);
  assert.equal(got[0]!.bonus.id, 'b_flat');

  // Bare family / parent key: no card to score it on -> not included.
  for (const bare of ['hogan_smith_law', 'HSL', 'Hogan Smith Law']) {
    assert.deepEqual(
      hslCatalogBonusesFor({
        subLabel: 'hsl:intake_specialist',
        employeeEmail: 'a@simple.biz',
        assignments: [deptAssign('b_flat', bare)],
        bonuses,
      }),
      [],
      `${bare} must not reach a sub-team card`,
    );
  }
  // A sibling sub-team's assignment does not leak.
  assert.deepEqual(
    hslCatalogBonusesFor({
      subLabel: 'hsl:intake_specialist',
      employeeEmail: 'a@simple.biz',
      assignments: [deptAssign('b_flat', 'hsl:filing_specialist')],
      bonuses,
    }),
    [],
  );
});

test('exclusions and per-employee assignments resolve across a person aliases', () => {
  const bonuses = [flat()];
  const excluded = hslCatalogBonusesFor({
    subLabel: 'hsl:intake_specialist',
    employeeEmail: 'personal@gmail.com',
    aliases: ['work@simple.biz'],
    assignments: [deptAssign('b_flat', 'hsl:intake_specialist', { excludedEmails: ['WORK@simple.biz'] })],
    bonuses,
  });
  assert.deepEqual(excluded, [], 'an exclusion recorded under the work email must hold');

  const individual = hslCatalogBonusesFor({
    subLabel: 'hsl:intake_specialist',
    employeeEmail: 'personal@gmail.com',
    aliases: ['work@simple.biz'],
    assignments: [
      { id: 'a1', bonusId: 'b_flat', scope: 'employee', departmentKey: 'hsl:intake_specialist', employeeEmail: 'work@simple.biz' } as BonusAssignment,
    ],
    bonuses,
  });
  assert.equal(individual.length, 1);
  assert.equal(individual[0]!.individual, true);
});

test('monthly bonuses appear only in the final payroll week', () => {
  const bonuses = [flat({ id: 'b_m', cadence: 'monthly' })];
  const assignments = [deptAssign('b_m', 'hsl:intake_specialist')];
  const inFinal = hslCatalogBonusesFor({
    subLabel: 'hsl:intake_specialist',
    employeeEmail: 'a@simple.biz',
    assignments,
    bonuses,
    periodStart: '2026-09-27',
  });
  const notFinal = hslCatalogBonusesFor({
    subLabel: 'hsl:intake_specialist',
    employeeEmail: 'a@simple.biz',
    assignments,
    bonuses,
    periodStart: '2026-09-06',
  });
  assert.equal(inFinal.length + notFinal.length, 1, 'exactly one of the two weeks may show it');
});

test('amounts: flat pays when ticked, formula reads its namespaced vars', () => {
  const b = flat();
  assert.equal(calcHslCatalogBonus({}, b), 0, 'unticked pays nothing');
  assert.equal(calcHslCatalogBonus({ [catalogOnKey('b_flat')]: true }, b), 1500);

  const f = formula();
  assert.deepEqual(catalogBonusVariables(f), ['signups']);
  const kpi = { [catalogOnKey('b_form')]: true, [catalogVarKey('b_form', 'signups')]: 4 };
  assert.equal(calcHslCatalogBonus(kpi, f), 1000);
  // A blank/absent variable reads 0, never NaN.
  assert.equal(calcHslCatalogBonus({ [catalogOnKey('b_form')]: true }, f), 0);
  // A broken formula pays 0 rather than throwing into the card.
  assert.equal(calcHslCatalogBonus({ [catalogOnKey('b_x')]: true }, formula({ id: 'b_x', formula: '=)(' })), 0);
});

test('a NON-PHP bonus is never paid — the HSL card has no FX', () => {
  const usd = flat({ id: 'b_usd', currency: 'USD', amount: 50 });
  assert.equal(isScoreableOnHsl(usd), false);
  assert.equal(
    calcHslCatalogBonus({ [catalogOnKey('b_usd')]: true }, usd),
    0,
    'paying 50 as if it were pesos, or converting at an unstated rate, are both worse than 0',
  );
  const got = hslCatalogBonusesFor({
    subLabel: 'hsl:intake_specialist',
    employeeEmail: 'a@simple.biz',
    assignments: [deptAssign('b_usd', 'hsl:intake_specialist')],
    bonuses: [usd],
  });
  assert.equal(got.length, 1, 'it is still SHOWN, so the manager can see why it pays nothing');
  assert.equal(got[0]!.scoreable, false);
});

test('the catalog total is ADDITIVE to calcBonus and outside monthlyMax', () => {
  const dept = HSL_DEPTS.post_hearing_prep; // has monthlyMax 3500
  assert.notEqual(dept.monthlyMax, undefined);
  // Rules alone, capped.
  const kpiRules = { five_star_survey: 100 };
  const ruleTotal = calcBonus(kpiRules, dept, false, { periodStart: '2026-09-06' });
  assert.equal(ruleTotal, dept.monthlyMax, 'the rule side is capped as before');

  const b = flat();
  const list = [{ bonus: b, scoreable: true, individual: false }];
  const kpi = { ...kpiRules, [catalogOnKey('b_flat')]: true };
  assert.equal(calcHslCatalogTotal(kpi, list), 1500);
  // calcBonus is untouched by the catalog keys — no double counting, no cap change.
  assert.equal(calcBonus(kpi, dept, false, { periodStart: '2026-09-06' }), ruleTotal);
});

test('removing an assignment strips its stale inputs so they cannot keep paying', () => {
  const kpi = {
    signed_rep_docs: 3,
    [catalogOnKey('keep')]: true,
    [catalogVarKey('keep', 'x')]: 2,
    [catalogOnKey('gone')]: true,
    [catalogVarKey('gone', 'y')]: 9,
  };
  const next = withoutCatalogKeys(kpi, ['keep']);
  assert.equal(next.signed_rep_docs, 3, 'schema keys are untouched');
  assert.equal(next[catalogOnKey('keep')], true);
  assert.equal(catalogOnKey('gone') in next, false);
  assert.equal(catalogVarKey('gone', 'y') in next, false);
  // Nothing to strip returns the SAME object, so callers can skip a state update.
  assert.equal(withoutCatalogKeys(kpi, ['keep', 'gone']), kpi);
});
