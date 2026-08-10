import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hslSubDeptLabel,
  hslSubKeyFromRaw,
  isHslSubDeptLabel,
  isHslFamilyLabel,
  formatDeptLabel,
  deptCellMatchesSource,
  deptCellSatisfiesTarget,
} from './hsl-subdept';

test('hslSubKeyFromRaw parses canonical and sloppy labels', () => {
  assert.equal(hslSubKeyFromRaw('hsl:intake_specialist'), 'intake_specialist');
  assert.equal(hslSubKeyFromRaw('  HSL:Intake_Specialist '), 'intake_specialist');
  assert.equal(hslSubKeyFromRaw('hsl:not_a_team'), null); // unknown sub-key
  assert.equal(hslSubKeyFromRaw('HSL'), null); // family label, not a sub-team
  assert.equal(hslSubKeyFromRaw(null), null);
});

test('hslSubDeptLabel round-trips through hslSubKeyFromRaw', () => {
  assert.equal(hslSubDeptLabel('collections'), 'hsl:collections');
  assert.equal(hslSubKeyFromRaw(hslSubDeptLabel('case_managers')), 'case_managers');
});

test('isHslFamilyLabel covers every variant the master list actually carries', () => {
  // The four sub labels live on the roster today, plus the two family spellings.
  assert.ok(isHslFamilyLabel('HSL'));
  assert.ok(isHslFamilyLabel('hsl'));
  assert.ok(isHslFamilyLabel('Hogan Smith Law'));
  assert.ok(isHslFamilyLabel('hogan_smith_law'));
  assert.ok(isHslFamilyLabel('hsl:intake_specialist'));
  assert.ok(isHslFamilyLabel('hsl:filing_specialist'));
  assert.ok(isHslFamilyLabel('hsl:case_managers'));
  assert.ok(isHslFamilyLabel('hsl:attestation'));
  // An unknown sub-key is STILL HSL — normalizeDeptToKey collapses any hsl:*
  // prefix, so a typo'd sub-team must not silently drop out of the HSL cohort.
  assert.ok(isHslFamilyLabel('hsl:not_a_team'));
  assert.equal(isHslFamilyLabel('Lead Gen'), false);
  assert.equal(isHslFamilyLabel(''), false);
  assert.equal(isHslFamilyLabel(null), false);
});

test('formatDeptLabel prettifies sub-teams and passes everything else through', () => {
  assert.equal(formatDeptLabel('hsl:intake_specialist'), 'HSL — Intake Specialist');
  assert.equal(formatDeptLabel('hsl:ssd_medical_records'), 'HSL — SSD Medical Records');
  assert.equal(formatDeptLabel('Lead Gen'), 'Lead Gen');
  assert.equal(formatDeptLabel('Hogan Smith Law'), 'Hogan Smith Law');
  assert.equal(formatDeptLabel(null), '');
  // An unknown sub-key has no display name — show the family, not the raw slug.
  assert.equal(formatDeptLabel('hsl:not_a_team'), 'HSL — not_a_team');
});

test('deptCellMatchesSource is HSL-family-aware and synonym-aware', () => {
  // A sub-team cell IS an HSL row when moving someone out of "HSL".
  assert.ok(deptCellMatchesSource('hsl:intake_specialist', 'HSL'));
  assert.ok(deptCellMatchesSource('HSL', 'hsl:collections'));
  assert.ok(deptCellMatchesSource('Hogan Smith Law', 'hsl:intake_specialist'));
  // Existing synonym behavior (deptMatchKey parity).
  assert.ok(deptCellMatchesSource('Callbacks', 'Callback Team'));
  // Different families never match.
  assert.equal(deptCellMatchesSource('Lead Gen', 'HSL'), false);
  // Unknown labels compare raw.
  assert.ok(deptCellMatchesSource('Medical Billing', 'medical billing'));
  assert.equal(deptCellMatchesSource('Medical Billing', 'Site Building'), false);
});

test('deptCellSatisfiesTarget requires EXACT cell for a sub-team target', () => {
  assert.ok(deptCellSatisfiesTarget('hsl:intake_specialist', 'hsl:intake_specialist'));
  assert.ok(deptCellSatisfiesTarget('HSL:Intake_Specialist', 'hsl:intake_specialist'));
  // Plain-HSL cell does NOT satisfy a sub-team target (that's the relabel we want).
  assert.equal(deptCellSatisfiesTarget('HSL', 'hsl:intake_specialist'), false);
  assert.equal(deptCellSatisfiesTarget('hsl:collections', 'hsl:intake_specialist'), false);
  // A sub-team cell DOES satisfy a plain-HSL target (never clobber a sub label
  // back to the generic family label).
  assert.ok(deptCellSatisfiesTarget('hsl:intake_specialist', 'HSL'));
  assert.ok(deptCellSatisfiesTarget('hsl:intake_specialist', 'Hogan Smith Law'));
  // Non-HSL targets keep family semantics.
  assert.ok(deptCellSatisfiesTarget('Callbacks', 'Callback Team'));
  assert.equal(deptCellSatisfiesTarget('Lead Gen', 'Callback Team'), false);
});
