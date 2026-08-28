/**
 * Pins the Payment Catalog department-name resolver used by the Payroll Wizard's
 * step-6 PAB review (and anywhere else that shows a department to a human).
 *
 * The rule it protects: a raw slug is never a label. `lead_gen` is a key;
 * "Lead Gen" is what a person reads. A catalog-only department carries its own
 * registered name, and a NAMESPACED sub-department key must not be humanized as
 * one string — `medical_billing:intake_team` would become "Medical
 * billing:intake Team".
 *
 * Run: npx tsx --test src/lib/departments/dept-identity.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCatalogDeptNameMap,
  catalogDeptName,
  catalogDeptNameFrom,
  humanizeDeptKey,
} from './dept-identity';

const REGISTRY = [
  {
    key: 'medical_billing',
    name: 'Medical Billing',
    subDepartments: [
      { key: 'intake_team', name: 'Intake Team' },
      { key: 'claims', name: 'Claims' },
    ],
  },
  { key: 'special_projects', name: 'Special Projects & R&D', subDepartments: [] },
];

test('registry names win over humanizing the slug', () => {
  const names = buildCatalogDeptNameMap(REGISTRY);
  // The humanizer cannot reproduce this one — punctuation is lost in the slug.
  assert.equal(catalogDeptNameFrom('special_projects', names), 'Special Projects & R&D');
  assert.notEqual(humanizeDeptKey('special_projects'), 'Special Projects & R&D');
});

test('namespaced sub-department keys resolve to "Parent — Sub"', () => {
  const names = buildCatalogDeptNameMap(REGISTRY);
  assert.equal(catalogDeptNameFrom('medical_billing:intake_team', names), 'Medical Billing — Intake Team');
  assert.equal(catalogDeptNameFrom('medical_billing:claims', names), 'Medical Billing — Claims');
  // Humanizing the whole slug is the failure this prevents.
  assert.match(humanizeDeptKey('medical_billing:intake_team'), /:/);
});

test('an unregistered sub-key still names its registered parent', () => {
  const names = buildCatalogDeptNameMap(REGISTRY);
  // A sub-team added to the pay structure but not yet to the registry must not
  // fall all the way back to a mangled slug.
  assert.equal(catalogDeptNameFrom('medical_billing:brand_new', names), 'Medical Billing');
});

test('built-in departments still resolve with no registry at all', () => {
  // The wizard renders before the registry fetch lands; an empty map must
  // degrade to the built-in list, never to a raw key.
  const empty = new Map<string, string>();
  for (const key of ['lead_gen', 'hogan_smith_law']) {
    const withEmpty = catalogDeptNameFrom(key, empty);
    assert.equal(withEmpty, catalogDeptName(key));
    assert.ok(!withEmpty.includes('_'), `"${withEmpty}" still looks like a slug`);
  }
  assert.equal(catalogDeptNameFrom('lead_gen', null), catalogDeptName('lead_gen'));
});

test('HSL keeps its own formatting and never shows the hsl: prefix', () => {
  const names = buildCatalogDeptNameMap(REGISTRY);
  const label = catalogDeptNameFrom('hsl:filing_specialist', names);
  assert.ok(!label.toLowerCase().startsWith('hsl:'), `"${label}" leaked the raw prefix`);
  assert.match(label, /^HSL/);
});

test('empty and nullish keys are empty strings, not "Undefined"', () => {
  assert.equal(catalogDeptNameFrom(null), '');
  assert.equal(catalogDeptNameFrom(undefined), '');
  assert.equal(catalogDeptNameFrom('   '), '');
});

test('the map skips entries with no key or no name rather than storing blanks', () => {
  const names = buildCatalogDeptNameMap([
    { key: 'ok_dept', name: 'OK Dept', subDepartments: [{ key: '', name: 'Nameless' }] },
    { key: '', name: 'No Key', subDepartments: [] },
    { key: 'no_name', name: '   ', subDepartments: [] },
  ]);
  assert.deepEqual([...names.keys()], ['ok_dept']);
  // A blank-named department falls through to the normal resolution path.
  assert.equal(catalogDeptNameFrom('no_name', names), catalogDeptName('no_name'));
});
