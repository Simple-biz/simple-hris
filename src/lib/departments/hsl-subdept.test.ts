import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HSL_FAMILY_DEPT_LABEL,
  hslSubDeptLabel,
  hslSubKeyFromRaw,
  isHslSubDeptLabel,
  isHslFamilyLabel,
  formatDeptLabel,
  collapseHslFamilyLabel,
  isPlaceableDeptLabel,
  hslSubDeptOptions,
  deptCellMatchesSource,
  deptCellSatisfiesTarget,
  HSL_PLACEMENT_ONLY_SUB_KEYS,
  HSL_PLACEMENT_ONLY_SUB_TEAMS,
  isHslKpiDeptKey,
  isHslPlacementOnlySubKey,
  hslSubTeamName,
} from './hsl-subdept';
import { HSL_DEPT_KEYS, HSL_DEPTS } from '@/lib/hsl-bonus/schema';

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

test('collapseHslFamilyLabel leaves exactly ONE HSL entry in a picker list', () => {
  // Every label the live roster carries collapses to the same single entry.
  for (const raw of [
    'HSL',
    'hsl',
    'Hogan Smith Law',
    'hogan_smith_law',
    'hsl:intake_specialist',
    'hsl:filing_specialist',
    'hsl:case_managers',
    'hsl:attestation',
    'hsl:not_a_team',
  ]) {
    assert.equal(collapseHslFamilyLabel(raw), HSL_FAMILY_DEPT_LABEL);
  }
  // Non-HSL labels are untouched — this must never become a general rewriter.
  assert.equal(collapseHslFamilyLabel('Lead Gen'), 'Lead Gen');
  assert.equal(collapseHslFamilyLabel('  Callback Team '), 'Callback Team');
  assert.equal(collapseHslFamilyLabel('Sales Assistant'), 'Sales Assistant');
  assert.equal(collapseHslFamilyLabel(null), '');

  // The whole point: a roster holding five HSL spellings yields one option.
  const roster = ['HSL', 'hsl:intake_specialist', 'hsl:attestation', 'Lead Gen', 'Hogan Smith Law'];
  const options = [...new Set(roster.map(collapseHslFamilyLabel))];
  assert.deepEqual(options, ['HSL', 'Lead Gen']);
});

test('isPlaceableDeptLabel refuses a bare HSL but accepts every sub-team', () => {
  // The whole point of the two-step: "HSL" alone is not a placement.
  assert.equal(isPlaceableDeptLabel('HSL'), false);
  assert.equal(isPlaceableDeptLabel('hsl'), false);
  assert.equal(isPlaceableDeptLabel('Hogan Smith Law'), false);
  assert.equal(isPlaceableDeptLabel('hogan_smith_law'), false);
  assert.equal(isPlaceableDeptLabel(''), false);
  assert.equal(isPlaceableDeptLabel('   '), false);
  assert.equal(isPlaceableDeptLabel(null), false);
  for (const key of HSL_DEPT_KEYS) {
    assert.ok(isPlaceableDeptLabel(hslSubDeptLabel(key)), `hsl:${key} must be placeable`);
  }
  // Case/whitespace sloppiness still counts as a real sub-team.
  assert.ok(isPlaceableDeptLabel(' HSL:Intake_Specialist '));
  // An unknown sub-key is NOT placeable — it would resolve no rate row and is
  // almost certainly a typo or a stale access grant leaking in.
  assert.equal(isPlaceableDeptLabel('hsl:not_a_team'), false);
  // Every non-HSL department is unaffected.
  assert.ok(isPlaceableDeptLabel('Lead Gen'));
  assert.ok(isPlaceableDeptLabel('Callback Team'));
  assert.ok(isPlaceableDeptLabel('Executive Assistants'));
});

test('the two sub-team keyspaces stay disjoint — a placement-only team NEVER gains a calculator', () => {
  // This is the load-bearing assertion of the whole split. Simple Texting was
  // deleted from HSL_DEPT_KEYS on 2026-08-04 at Kane's explicit request, and
  // Carla scores both of these under the Callback Team calculator. If someone
  // "helpfully" adds either key to HSL_DEPT_KEYS later, they get a duplicate
  // calculator card AND a permanent draft row in Payroll Readiness → KPI
  // Submissions that pins the readiness score under 100 every week. Fail loudly.
  for (const key of HSL_PLACEMENT_ONLY_SUB_KEYS) {
    assert.equal(
      isHslKpiDeptKey(key),
      false,
      `${key} must NOT be in HSL_DEPT_KEYS — it is scored under ${HSL_PLACEMENT_ONLY_SUB_TEAMS[key].scoredUnder}, not by its own calculator`,
    );
  }
  for (const key of HSL_DEPT_KEYS) {
    assert.equal(isHslPlacementOnlySubKey(key), false, `${key} owns a calculator; it is not placement-only`);
  }
  // The calculator each placement-only team rides must actually exist — a
  // dangling `scoredUnder` would mean nobody can score them at all.
  for (const key of HSL_PLACEMENT_ONLY_SUB_KEYS) {
    const under = HSL_PLACEMENT_ONLY_SUB_TEAMS[key].scoredUnder;
    assert.ok(isHslKpiDeptKey(under), `${key}.scoredUnder=${under} must be a real KPI dept`);
    assert.ok(HSL_DEPTS[under], `${under} must have a calculator config`);
  }
  // Both teams ride Callback Team, whose rules ARE the bonus Carla described:
  // Successfully Transferred Calls ₱50 + Sign ups from Transferred Calls ₱250.
  const callbackRates = HSL_DEPTS.callback_team.rules.map((r) => ('rate' in r ? r.rate : null));
  assert.deepEqual(callbackRates, [50, 250]);
});

test('hslSubTeamName resolves a display name from either keyspace', () => {
  assert.equal(hslSubTeamName('intake_specialist'), 'Intake Specialist');
  assert.equal(hslSubTeamName('simple_texting'), 'Simple Texting');
  // The calculator a placement-only team rides also resolves by name.
  assert.equal(hslSubTeamName('callback_team'), HSL_DEPTS.callback_team.name);
});

test('placement-only sub-teams are placeable, parseable and prettily labeled', () => {
  for (const key of HSL_PLACEMENT_ONLY_SUB_KEYS) {
    const label = hslSubDeptLabel(key);
    assert.equal(label, `hsl:${key}`);
    assert.equal(hslSubKeyFromRaw(label), key, 'must round-trip out of a master cell');
    assert.ok(isHslSubDeptLabel(label), 'must count as a specific sub-team, not the bare family');
    assert.ok(isHslFamilyLabel(label), 'must stay inside the HSL cohort (week model, weekend premium)');
    assert.ok(isPlaceableDeptLabel(label), `${label} must be a legal placement`);
    assert.equal(collapseHslFamilyLabel(label), HSL_FAMILY_DEPT_LABEL, 'pickers still show ONE HSL');
    assert.equal(formatDeptLabel(label), `HSL — ${HSL_PLACEMENT_ONLY_SUB_TEAMS[key].name}`);
  }
  // Sloppy casing from a hand-edited sheet cell still resolves.
  assert.equal(hslSubKeyFromRaw(' HSL:Simple_Texting '), 'simple_texting');
  assert.equal(formatDeptLabel('hsl:simple_texting'), 'HSL — Simple Texting');
  // A sub-team TARGET demands the exact cell, placement-only included — a plain
  // "HSL" person must still be relabeled, and a sibling is not a no-op.
  assert.equal(deptCellSatisfiesTarget('HSL', 'hsl:simple_texting'), false);
  assert.equal(deptCellSatisfiesTarget('hsl:intake_specialist', 'hsl:simple_texting'), false);
  assert.ok(deptCellSatisfiesTarget('hsl:simple_texting', 'hsl:simple_texting'));
  // ...and moving someone OUT of one is an HSL-family source move.
  assert.ok(deptCellMatchesSource('hsl:simple_texting', 'HSL'));
});

test('hslSubDeptOptions offers every sub-team, canonically valued and prettily labeled', () => {
  const opts = hslSubDeptOptions();
  assert.equal(opts.length, HSL_DEPT_KEYS.length + HSL_PLACEMENT_ONLY_SUB_KEYS.length);
  // Regression witness for the pre-split list: this was absent from every
  // transfer dropdown, onboarding picker, Pay Structure rail and catalog export.
  assert.ok(opts.some((o) => o.value === 'hsl:simple_texting'));
  // Values are the canonical cell labels; each round-trips back to its key.
  for (const o of opts) {
    assert.ok(isHslSubDeptLabel(o.value), `${o.value} must be a canonical hsl:<key> label`);
    assert.ok(o.label.startsWith('HSL — '), `${o.label} must use the em-dash display form`);
    assert.equal(o.label.includes('hsl:'), false, 'no raw slug may reach a human');
  }
  // No duplicate values, so a <select> can key on them.
  assert.equal(new Set(opts.map((o) => o.value)).size, opts.length);
  assert.ok(opts.some((o) => o.value === 'hsl:intake_specialist'));
});

test('RETIRED sub-team keys stay retired — `lead_nurture` never comes back by accident', () => {
  // Shipped 2026-08-12, withdrawn 2026-08-13. Carla and CJ settled that it named
  // the SAME team as Simple Texting and collided with Lucky's separate Lead
  // Nurture team, so only Simple Texting survives (CJ: "We can use HSL –
  // SimpleTexting to avoid any confusion with Lucky's Lead Nurture Team").
  // Nobody was ever placed in it. Re-adding it re-opens the duplicate-team
  // confusion this removal closed, so it fails here first.
  const RETIRED = ['lead_nurture'] as const;
  for (const key of RETIRED) {
    assert.equal(isHslPlacementOnlySubKey(key), false, `${key} was retired — do not re-add it to HSL_PLACEMENT_ONLY_SUB_KEYS`);
    assert.equal(isHslKpiDeptKey(key), false, `${key} was retired — and it never owned a calculator`);
    const label = `hsl:${key}`;
    // Not a known sub-team, so not a legal NEW placement: the transfer dialog,
    // onboarding picker and placement validation can no longer offer or accept it.
    assert.equal(hslSubKeyFromRaw(label), null, `${label} must not resolve to a sub-team key`);
    assert.equal(isHslSubDeptLabel(label), false, `${label} must not count as a specific sub-team`);
    assert.equal(isPlaceableDeptLabel(label), false, `${label} must be rejected as a new placement`);
    assert.equal(
      hslSubDeptOptions().some((o) => o.value === label),
      false,
      `${label} must not appear in any picker`,
    );
    // Pay safety net: a stale cell is STILL inside the HSL cohort, so the week
    // model, the +₱15/h weekend premium and the parent ₱225 fallback all still
    // apply. A retired key must never strand someone outside HSL or at ₱0.
    assert.ok(isHslFamilyLabel(label), `${label} must stay in the HSL family for pay purposes`);
    assert.equal(collapseHslFamilyLabel(label), HSL_FAMILY_DEPT_LABEL, `${label} still collapses to one HSL`);
    // And it degrades to the raw slug rather than impersonating a live team.
    assert.equal(formatDeptLabel(label), `HSL — ${key}`);
  }
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
