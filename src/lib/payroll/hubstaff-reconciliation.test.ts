import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isHubstaffExemptDept, isHubstaffReconExcluded } from './hubstaff-reconciliation';

// The exempt list is matched against RAW master-list Department labels, and those
// labels get cohort qualifiers appended over time. Measured on the 2026-08-09
// week: `Site Building` had become `Site Building (US - Freelance)` (20 people,
// 0 with Hubstaff hours) + `Site Building (PH - Freelancer)` (13, 0 with hours),
// so 33 people the list intends to excuse were reported as unexplained gaps.

test('the plain exempt labels stay exempt', () => {
  for (const d of ['SMM Freelancer', 'Site Building', 'Sales', 'Sales Assistant', 'USEE']) {
    assert.equal(isHubstaffExemptDept(d), true, d);
  }
});

test('a trailing cohort qualifier does not un-exempt a dept', () => {
  assert.equal(isHubstaffExemptDept('Site Building (US - Freelance)'), true);
  assert.equal(isHubstaffExemptDept('Site Building (PH - Freelancer)'), true);
  // Casing / spacing around the qualifier must not matter either.
  assert.equal(isHubstaffExemptDept('  site building   (ph - freelancer)  '), true);
});

// Kane's ruling 2026-08-21 (Q1): Lead Gen is TRACKED. 135 of its 343 active
// people logged hours in the 2026-08-09 week, so a no-hours Lead Gen person is a
// reminder to check their status, NOT an expected absence. Never exempt it.
test('Lead Gen is NOT exempt — Kane 2026-08-21', () => {
  assert.equal(isHubstaffExemptDept('Lead Gen'), false);
  assert.equal(isHubstaffExemptDept('Lead Gen (PH)'), false);
});

// Negative control for the qualifier pass: it may only ever re-admit a label
// whose BASE is already in the set. A tracked dept stays tracked however it is
// qualified — otherwise the second pass would be a blanket exemption.
test('the qualifier pass never exempts a dept that was not already exempt', () => {
  for (const d of [
    'AI/API Team',
    'AI/API Team (Core)',
    'Edit Team (Night)',
    'Client VA (US)',
    'hsl:intake_specialist',
    'Manager',
  ]) {
    assert.equal(isHubstaffExemptDept(d), false, d);
  }
});

test('a nested-looking or unclosed qualifier is not treated as one', () => {
  // Only a well-formed trailing "(...)" is stripped; anything else is the label.
  assert.equal(isHubstaffExemptDept('Site Building (US'), false);
  assert.equal(isHubstaffExemptDept('(Site Building)'), false);
});

test('empty / missing department is never exempt', () => {
  assert.equal(isHubstaffExemptDept(null), false);
  assert.equal(isHubstaffExemptDept(undefined), false);
  assert.equal(isHubstaffExemptDept(''), false);
  assert.equal(isHubstaffExemptDept('   '), false);
});

test('retired-seat exclusion still matches case-insensitively', () => {
  assert.equal(isHubstaffReconExcluded('seungyong@simple.biz'), true);
  assert.equal(isHubstaffReconExcluded('  SeungYong@Simple.biz '), true);
  assert.equal(isHubstaffReconExcluded('jvincec@simple.biz'), false);
  assert.equal(isHubstaffReconExcluded(null), false);
});
