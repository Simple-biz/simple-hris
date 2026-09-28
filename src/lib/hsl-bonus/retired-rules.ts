// HSL rules that were DELETED from code when a branch moved to the Bonus
// Library (`rulesFromCatalog`, hsl-subdepartments.md §7d). DISPLAY ONLY.
//
// Why this exists: a week scored before the cutover still carries these keys
// in `kpi_data` (`portal_login`, `rfc_form`, `attested_cases`, …). Everything
// that EXPLAINS a past week — Employee KPI Results, Admin Penny — used to look
// the key up in `HSL_DEPTS[dept].rules`. Once the rules are gone that lookup
// finds nothing, so a key falls back to its raw name and loses its rate. Worse,
// a `manual` rule's value is a PESO amount, and without its rule it reads as a
// COUNT (Medical Records' "RFC" ₱350 would render as "Rfc Form × 350").
//
// These entries are never scored. Nothing here is a `DeptConfig` and nothing
// passes them to `calcBonus`. `calculated_bonus` is frozen at save and it is
// what the wizard dispatches, so these labels change no amount. A test pins
// that no retired key shadows a LIVE rule key, so a live rule always wins.
//
// Each list is the branch's rule set as it stood when its last code-scored
// week was saved. Filing Specialist's is the ORIGINAL 30/40/50 ladder: the
// 20/30/40 bands lived in code for one commit (b3dc6a98) and were never
// deployed, so no saved row was ever scored with them.
//
// CLIENT-SAFE: data only.

import type { BonusRule, HslDeptKey } from './schema';

export const HSL_RETIRED_RULES: Partial<Record<HslDeptKey, readonly BonusRule[]>> = {
  // 2026-09-22 (Kane): scored from the "Intake" Library bonus since week 2026-09-13.
  intake_specialist: [
    { type: 'per_unit', key: 'signed_rep_docs', label: 'Signed Rep Docs', rate: 250 },
    { type: 'per_unit', key: 'five_star_reviews', label: '5-Star Reviews', rate: 100 },
  ],
  // 2026-09-22 (Kane): scored from the "Filing Team" Library bonus since week 2026-09-13.
  filing_specialist: [
    { type: 'per_unit', key: 'portal_login', label: 'Patient Portal Login', rate: 100 },
    { type: 'per_unit', key: 'bbb_reviews', label: 'BBB Reviews', rate: 250 },
    {
      type: 'tiered',
      key: 'attested_cases',
      label: 'Attested Cases',
      tiers: [
        { min: 0, max: 29, rate: 0 },
        { min: 30, max: 39, rate: 50 },
        { min: 40, max: 49, rate: 75 },
        { min: 50, max: null, rate: 100 },
      ],
    },
    { type: 'per_unit', key: 'converted_referral', label: 'Converted Referral', rate: 250 },
  ],
  // 2026-09-28 (Kane: "Delete the HARD CODED Formulas in the KPI CALCULATOR").
  // Last code-scored week for all five: 2026-09-13.
  medical_records: [
    { type: 'per_unit', key: 'portal_login', label: 'Patient Portal Log Ins', rate: 100 },
    { type: 'manual', key: 'rfc_form', label: 'RFC' },
  ],
  care_team: [
    { type: 'per_unit', key: 'church_attendees', label: 'Church Attendees', rate: 50 },
  ],
  callback_team: [
    { type: 'per_unit', key: 'transferred_calls', label: 'Successfully Transferred Calls', rate: 50 },
    { type: 'per_unit', key: 'signups_from_transfers', label: 'Sign ups from Transferred Calls', rate: 250 },
  ],
  attestation: [
    {
      type: 'tiered',
      key: 'attested_cases',
      label: 'Attested Cases',
      tiers: [
        { min: 0, max: 24, rate: 0 },
        { min: 25, max: 34, rate: 50 },
        { min: 35, max: 49, rate: 75 },
        { min: 50, max: null, rate: 100 },
      ],
    },
    { type: 'per_unit', key: 'referral_leads', label: 'Referral Leads', rate: 250 },
    { type: 'per_unit', key: 'ssa_gov', label: 'SSA.Gov', rate: 250 },
  ],
  // 2026-09-28, Kane ruling (b): the Library replaces these even though it drops
  // the ₱2,500 flats and the ₱3,500 cap. Last code-scored weeks: Collections
  // 2026-09-13, Pre/Post-Hearing 2026-09-06. A past week's tick still reads as
  // its ₱2,500 here — the amount it was PAID, not a live rule.
  collections: [
    { type: 'flat', key: 'monthly_flat', label: 'Monthly Flat Bonus', amount: 2500, managerOnly: true },
    { type: 'per_unit', key: 'converted_referral', label: 'Converted Referral', rate: 250 },
  ],
  post_hearing_prep: [
    { type: 'per_unit', key: 'five_star_survey', label: '5-Star Survey', rate: 250 },
    { type: 'per_unit', key: 'portal_login', label: 'Portal Login', rate: 100 },
    { type: 'flat', key: 'monthly_bonus', label: 'Monthly Bonus', amount: 2500, cadence: 'monthly', exemptFromMonthlyMax: true },
  ],
  case_managers: [
    { type: 'per_unit', key: 'reviews', label: 'Reviews', rate: 250 },
    { type: 'per_unit', key: 'rfc', label: 'RFC', rate: 250 },
    { type: 'per_unit', key: 'ppl', label: 'PPL', rate: 100 },
    { type: 'per_unit', key: 'dme', label: 'DME', rate: 250 },
    { type: 'per_unit', key: 'task', label: 'Task', rate: 250 },
    { type: 'per_unit', key: 'referral_leads', label: 'Referral Leads', rate: 250 },
    { type: 'per_unit', key: 'ssa_gov', label: 'SSA.Gov', rate: 250 },
  ],
};

/**
 * The rule that explains `key` in a saved row of `deptKey`: the LIVE rule if
 * one exists, else the retired one. `retired` tells the caller the key is no
 * longer scored, so a reader is never told a deleted rule still pays.
 */
export function hslRuleForKey(
  deptKey: string,
  key: string,
  liveRules: readonly BonusRule[] | undefined,
): { rule: BonusRule; retired: boolean } | null {
  const live = liveRules?.find((r) => r.key === key);
  if (live) return { rule: live, retired: false };
  const old = HSL_RETIRED_RULES[deptKey as HslDeptKey]?.find((r) => r.key === key);
  return old ? { rule: old, retired: true } : null;
}
