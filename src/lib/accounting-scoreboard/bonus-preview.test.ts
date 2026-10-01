/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/bonus-preview.test.ts
 *
 * The formula is the live Payment Catalog "Dancing Queen Bonus" (v1, read 2026-10-01). The weeks
 * are what `bonus_catalog_applied` paid, so the preview is proven against real pay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWeek, pickPreviewBonus, previewBoth, type FormulaBonus } from './bonus-preview';

const DANCING_QUEEN = `=SUM(
  IF(Monday>=30, 450, IF(Monday>=22, 300, IF(Monday>=17, 200, 0))),
  IF(Tuesday>=30, 450, IF(Tuesday>=22, 300, IF(Tuesday>=17, 200, 0))),
  IF(Wednesday>=30, 450, IF(Wednesday>=22, 300, IF(Wednesday>=17, 200, 0))),
  IF(Thursday>=30, 450, IF(Thursday>=22, 300, IF(Thursday>=17, 200, 0))),
  IF(Friday>=30, 450, IF(Friday>=22, 300, IF(Friday>=17, 200, 0)))
)`;

const bonus = (over: Partial<FormulaBonus> = {}): FormulaBonus => ({
  id: 'bonus_dq',
  name: 'Dancing Queen Bonus',
  formula: DANCING_QUEEN,
  version: 1,
  currency: 'PHP',
  ...over,
});

test('the live formula reproduces what HRIS paid on the points it was given', () => {
  // [period_start, Mon..Fri as applied, amount paid per person]
  const paid: Array<[string, number[], number]> = [
    ['2026-08-02', [30, 30, 17, 23, 17], 1600],
    ['2026-08-09', [34, 31, 30, 23, 30], 2100],
    ['2026-08-16', [25, 31, 29, 32, 36], 1950],
    ['2026-08-23', [32, 30, 31, 33, 30], 2250],
    ['2026-08-30', [22, 29, 17, 23, 32], 1550],
    ['2026-09-06', [0, 31, 31, 34, 33], 1800],
    ['2026-09-13', [31, 30, 31, 31, 22], 2100],
    ['2026-09-20', [32, 32, 32, 30, 30], 2250],
  ];
  for (const [week, days, amount] of paid) {
    assert.equal(evaluateWeek(DANCING_QUEEN, days), amount, week);
  }
});

test('the preview shows both readings and never picks one', () => {
  // Week of Sep 21: points 32,31,32,30,30 vs accounts 32,20,19,27,28 (the collections log).
  const days = [
    { points: 32, accounts: 32 },
    { points: 31, accounts: 20 },
    { points: 32, accounts: 19 },
    { points: 30, accounts: 27 },
    { points: 30, accounts: 28 },
  ];
  assert.deepEqual(previewBoth(DANCING_QUEEN, days), { byPoints: 2250, byAccounts: 1450 });
});

test('the one Accounting formula bonus that reads only Monday–Friday is picked', () => {
  const v = pickPreviewBonus([bonus()]);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.bonus.name, 'Dancing Queen Bonus');
});

test('a formula reading any other variable is refused (it would silently read 0)', () => {
  const v = pickPreviewBonus([bonus({ formula: '=Monday + Saturday' })]);
  assert.equal(v.ok, false);
});

test('none, an invalid formula, or two candidates are refusals with a reason', () => {
  assert.equal(pickPreviewBonus([]).ok, false);
  assert.equal(pickPreviewBonus([bonus({ formula: '=IF(' })]).ok, false);
  const two = pickPreviewBonus([bonus(), bonus({ id: 'b2', name: 'Second' })]);
  assert.equal(two.ok, false);
  if (!two.ok) assert.match(two.reason, /will not guess/);
});

test('evaluateWeek needs exactly five days', () => {
  assert.throws(() => evaluateWeek(DANCING_QUEEN, [1, 2, 3]), /5 day values/);
});
