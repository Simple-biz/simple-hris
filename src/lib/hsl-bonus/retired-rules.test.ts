import test from 'node:test';
import assert from 'node:assert/strict';
import { HSL_DEPTS, calcBonus, type HslDeptKey } from './schema';
import { HSL_RETIRED_RULES, hslRuleForKey } from './retired-rules';
import { catalogInputLabel, catalogOnKey, catalogVarKey } from './catalog-bonus';

const retiredDepts = Object.keys(HSL_RETIRED_RULES) as HslDeptKey[];

test('retired rules exist only for branches that moved to the Library', () => {
  // A retired list on a branch that still scores in code would mean one of two
  // things, both wrong: its rules were deleted without the §7d flag, or a label
  // table is quietly describing rules that still pay.
  assert.deepEqual(
    [...retiredDepts].sort(),
    ['attestation', 'callback_team', 'care_team', 'case_managers', 'collections', 'filing_specialist', 'intake_specialist', 'medical_records', 'post_hearing_prep'],
  );
  for (const k of retiredDepts) {
    assert.equal(HSL_DEPTS[k].rulesFromCatalog, true, `${k} has retired rules but is not catalog-scored`);
  }
});

test('a retired key never shadows a live rule, and a live rule always wins the lookup', () => {
  for (const k of retiredDepts) {
    const live = new Set(HSL_DEPTS[k].rules.map((r) => r.key));
    for (const r of HSL_RETIRED_RULES[k] ?? []) assert.equal(live.has(r.key), false, `${k}.${r.key}`);
  }
  const liveRule = { type: 'per_unit', key: 'portal_login', label: 'LIVE', rate: 1 } as const;
  assert.deepEqual(hslRuleForKey('medical_records', 'portal_login', [liveRule]), { rule: liveRule, retired: false });
});

test('retired rules are DISPLAY ONLY — the branch scores ₱0 from them', () => {
  // The whole point: these explain a past week, they never pay one.
  for (const k of retiredDepts) {
    const kpi: Record<string, number> = {};
    for (const r of HSL_RETIRED_RULES[k] ?? []) kpi[r.key] = 30;
    assert.equal(calcBonus(kpi, HSL_DEPTS[k], false), 0, k);
  }
});

test('Medical Records RFC stays MONEY in a past week, not a count', () => {
  const found = hslRuleForKey('medical_records', 'rfc_form', HSL_DEPTS.medical_records.rules);
  assert.equal(found?.retired, true);
  assert.equal(found?.rule.type, 'manual');
  assert.equal(hslRuleForKey('medical_records', 'not_a_key', HSL_DEPTS.medical_records.rules), null);
});

test('the pre-cutover rates are recorded as they were paid', () => {
  const rate = (dept: HslDeptKey, key: string) => {
    const r = hslRuleForKey(dept, key, HSL_DEPTS[dept].rules)?.rule;
    return r && r.type === 'per_unit' ? r.rate : null;
  };
  assert.equal(rate('medical_records', 'portal_login'), 100); // ₱100 vs ₱250 UNRESOLVED — recorded as paid
  assert.equal(rate('care_team', 'church_attendees'), 50);
  assert.equal(rate('callback_team', 'transferred_calls'), 50);
  assert.equal(rate('callback_team', 'signups_from_transfers'), 250);
  assert.equal(rate('case_managers', 'ppl'), 100);
  assert.equal(rate('case_managers', 'ssa_gov'), 250);
  // Filing's retired ladder is the ORIGINAL 30/40/50 — the one every saved row was scored with.
  const filing = hslRuleForKey('filing_specialist', 'attested_cases', [])?.rule;
  assert.equal(filing?.type === 'tiered' ? filing.tiers[1]!.min : null, 30);
  // A past week's ₱2,500 tick still reads as the ₱2,500 it was paid.
  const flat = (dept: HslDeptKey, key: string) => {
    const r = hslRuleForKey(dept, key, HSL_DEPTS[dept].rules)?.rule;
    return r && r.type === 'flat' ? r.amount : null;
  };
  assert.equal(flat('collections', 'monthly_flat'), 2500);
  assert.equal(flat('post_hearing_prep', 'monthly_bonus'), 2500);
  assert.equal(rate('collections', 'converted_referral'), 250);
  assert.equal(rate('post_hearing_prep', 'five_star_survey'), 250);
  const att = hslRuleForKey('attestation', 'attested_cases', [])?.rule;
  assert.equal(att?.type === 'tiered' ? att.tiers[1]!.min : null, 25);
});

test('catalogInputLabel names a Library input by its variable, never by the bonus id', () => {
  assert.equal(catalogInputLabel(catalogVarKey('bonus_muedkigzlphjghb3', 'Five_Star_Reviews')), 'Five Star Reviews');
  assert.equal(catalogInputLabel(catalogVarKey('b1', 'PPL')), 'PPL');
  assert.equal(catalogInputLabel(catalogOnKey('b1')), null, 'the on/off flag is not a metric');
  assert.equal(catalogInputLabel('portal_login'), undefined, 'not a catalog key');
});
