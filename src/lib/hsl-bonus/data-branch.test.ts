/**
 * A DATA HSL sub-team as a scoreable branch (Kane, 2026-09-22).
 *
 * The claims worth pinning: a data branch has NO rules (so it pays only what an
 * accountant assigned), it can never shadow a code team, and with nothing
 * assigned it reads "no work" so Payroll Readiness auto-Readies it instead of
 * holding the KPI dimension at draft forever.
 *
 * Run:  npx tsx --test src/lib/hsl-bonus/data-branch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dataBranchConfig,
  dataBranchHasWork,
  hslBranchConfigs,
  hslBranchKeys,
  isDataBranchKey,
} from './data-branch';
import { HSL_DEPTS, HSL_DEPT_KEYS, calcBonus, hslDeptAutoDispatches } from './schema';
import type { BonusAssignment, BonusDef } from '@/lib/bonus-catalog/types';

const SUB = { key: 'healthcare_specialist', name: 'Healthcare Specialist' };

const bonus = (over: Partial<BonusDef> = {}): BonusDef =>
  ({ id: 'b1', name: 'Spot', kind: 'flat', amount: 500, currency: 'PHP', cadence: 'weekly', ...over }) as BonusDef;
const assign = (departmentKey: string, over: Partial<BonusAssignment> = {}): BonusAssignment =>
  ({ id: 'a1', bonusId: 'b1', scope: 'department', departmentKey, ...over }) as BonusAssignment;

test('a data branch is a real config with NO rules — it pays only what is assigned', () => {
  const cfg = dataBranchConfig(SUB);
  assert.equal(cfg.key, 'healthcare_specialist');
  assert.equal(cfg.name, 'Healthcare Specialist');
  assert.equal(cfg.cadence, 'weekly');
  assert.deepEqual(cfg.rules, [], 'the HSL programme defines no KPI for it');
  // With no rules the schema engine contributes nothing, whatever is in kpi_data.
  assert.equal(calcBonus({ signed_rep_docs: 99, anything: 5 }, cfg, false), 0);
  assert.equal(cfg.noKpi, undefined, 'it is scoreable — it just has no RULES');
});

test('code vs data is decidable, and a data key can never shadow a code team', () => {
  assert.equal(isDataBranchKey('healthcare_specialist'), true);
  assert.equal(isDataBranchKey('intake_specialist'), false);
  for (const k of HSL_DEPT_KEYS) assert.equal(isDataBranchKey(k), false);

  // A data entry naming a code team is DROPPED, not merged — shadowing would
  // redirect Intake's real rules to an empty config.
  const configs = hslBranchConfigs([{ key: 'intake_specialist', name: 'Hijack' }, SUB]);
  assert.equal(configs.intake_specialist!.name, HSL_DEPTS.intake_specialist.name);
  // STRONGER than the old `rules.length > 0` witness, which quietly stopped
  // meaning anything on 2026-09-22 when intake_specialist became
  // rulesFromCatalog and its rules array went empty — a hijack would have
  // sailed through. Identity is the real property: the code config survives
  // WHOLE, not merely with a non-empty field.
  assert.equal(configs.intake_specialist, HSL_DEPTS.intake_specialist, 'the code config survives, by identity');
  assert.equal(configs.intake_specialist!.rulesFromCatalog, true);
  // And a code team that DOES carry rules still keeps them.
  // attestation, not filing_specialist: filing joined the catalog-scored shape
  // hours after this line was written, which is exactly how the ORIGINAL witness
  // went vacuous. Pick a dept whose rules are the point of its existence.
  const withRules = hslBranchConfigs([{ key: 'attestation', name: 'Hijack' }, SUB]);
  assert.equal(withRules.attestation, HSL_DEPTS.attestation);
  assert.equal(withRules.attestation!.rules.length > 0, true, 'the code rules survive');
  assert.equal(configs.healthcare_specialist!.name, 'Healthcare Specialist');
});

test('branch order: the 14 code teams first, then data, no duplicates', () => {
  const keys = hslBranchKeys([SUB, { key: 'intake_specialist', name: 'dupe' }, SUB]);
  assert.deepEqual(keys.slice(0, HSL_DEPT_KEYS.length), [...HSL_DEPT_KEYS]);
  assert.deepEqual(keys.slice(HSL_DEPT_KEYS.length), ['healthcare_specialist']);
  assert.deepEqual(hslBranchKeys([]), [...HSL_DEPT_KEYS]);
});

test('no assignment = no work, so Readiness auto-Readies instead of holding at draft', () => {
  const bonuses = [bonus()];
  assert.equal(
    dataBranchHasWork({ subKey: 'healthcare_specialist', assignments: [], bonuses }),
    false,
    'an empty branch must not hold the 25%-weight KPI dimension forever',
  );
  assert.equal(
    dataBranchHasWork({
      subKey: 'healthcare_specialist',
      assignments: [assign('hsl:healthcare_specialist')],
      bonuses,
    }),
    true,
  );
  // A sibling's assignment is not this branch's work.
  assert.equal(
    dataBranchHasWork({
      subKey: 'healthcare_specialist',
      assignments: [assign('hsl:intake_specialist')],
      bonuses,
    }),
    false,
  );
  // A per-employee assignment counts as work even though it reaches one person.
  assert.equal(
    dataBranchHasWork({
      subKey: 'healthcare_specialist',
      assignments: [assign('hsl:healthcare_specialist', { scope: 'employee', employeeEmail: 'a@simple.biz' })],
      bonuses,
    }),
    true,
  );
});

test('a MONTHLY bonus is not work outside its final payroll week', () => {
  const bonuses = [bonus({ cadence: 'monthly' })];
  const assignments = [assign('hsl:healthcare_specialist')];
  const final = dataBranchHasWork({ subKey: 'healthcare_specialist', assignments, bonuses, periodStart: '2026-09-27' });
  const mid = dataBranchHasWork({ subKey: 'healthcare_specialist', assignments, bonuses, periodStart: '2026-09-06' });
  assert.notEqual(final, mid, 'exactly one of the two weeks may count it as work');
});

// ── The Payroll Wizard's payable set (2026-09-22, audit item 159) ────────────
// The wizard built it as `HSL_DEPT_KEYS.filter(k => hslDeptAutoDispatches(HSL_DEPTS[k]))`,
// so a data branch's entries were never fetched and it paid ₱0. It is now built
// from the branch configs; these two tests pin both halves of that.

const payableFrom = (subs: { key: string; name: string }[]) => {
  const configs = hslBranchConfigs(subs);
  return hslBranchKeys(subs).filter((k) => {
    const cfg = configs[k];
    return !!cfg && hslDeptAutoDispatches(cfg);
  });
};

test('with NO data sub-teams the payable set is byte-identical to the old one', () => {
  const before = HSL_DEPT_KEYS.filter((k) => hslDeptAutoDispatches(HSL_DEPTS[k]));
  assert.deepEqual(payableFrom([]), [...before], 'todays production behaviour must not move');
});

test('a DATA branch IS payable — that is the whole bug', () => {
  const payable = payableFrom([SUB]);
  assert.equal(payable.includes('healthcare_specialist'), true);
  // It qualifies on the ordinary weekly rule, not a special case.
  assert.equal(hslDeptAutoDispatches(dataBranchConfig(SUB)), true);
  // And it is ADDITIVE: no code team dropped out.
  for (const k of HSL_DEPT_KEYS.filter((k) => hslDeptAutoDispatches(HSL_DEPTS[k]))) {
    assert.equal(payable.includes(k), true, `${k} must still be payable`);
  }
});

test('a MONTHLY code team stays OFF the payable set (manual Adjustment card)', () => {
  const payable = payableFrom([SUB]);
  const manualMonthly = HSL_DEPT_KEYS.filter((k) => !hslDeptAutoDispatches(HSL_DEPTS[k]));
  assert.equal(manualMonthly.length > 0, true, 'the fixture needs at least one manual monthly dept');
  for (const k of manualMonthly) {
    assert.equal(payable.includes(k), false, `${k} is hand-keyed into Adjustment — auto-paying it is double-pay`);
  }
});
