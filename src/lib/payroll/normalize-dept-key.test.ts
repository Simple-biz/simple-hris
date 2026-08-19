import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeptToKey } from './normalize-dept-key';
import {
  overrideDeptLabel,
  applyDeptOverrideToRawRow,
  SALES_ASSISTANT_LABEL,
} from '../departments/dept-email-overrides';

// ── the Sales / Sales Assistant split (2026-07-27) ──────────────────────────
// Guards the one-line fold that used to read `sales: 'sales_assistant'`.
// If either assertion breaks, the two departments have silently re-merged.

test('Sales and Sales Assistant resolve to DIFFERENT payroll keys', () => {
  assert.equal(normalizeDeptToKey('Sales'), 'sales');
  assert.equal(normalizeDeptToKey('sales'), 'sales');
  assert.equal(normalizeDeptToKey('Sales Assistant'), 'sales_assistant');
  assert.equal(normalizeDeptToKey('sales assistant'), 'sales_assistant');
  assert.notEqual(normalizeDeptToKey('Sales'), normalizeDeptToKey('Sales Assistant'));
});

test('long-standing folds still hold', () => {
  assert.equal(normalizeDeptToKey('Edit Team'), 'edit');
  assert.equal(normalizeDeptToKey('Accounting Team'), 'accounting');
  assert.equal(normalizeDeptToKey('Callbacks'), 'callback');
  assert.equal(normalizeDeptToKey('SmartClicks/Sterling'), 'smart_staff');
  assert.equal(normalizeDeptToKey('hsl:intake_specialist'), 'hogan_smith_law');
  assert.equal(normalizeDeptToKey('Unknown Dept'), null);
});

test('a plain HSL sub-team display name is NOT HSL membership', () => {
  // Kane's ruling, 2026-08-19 (merging hsl-kpi-gml-roster): normalizeDeptToKey IS
  // the HSL family key — week model, +P15/h weekend premium, dept-scoped bonus
  // matching (hsl-subdepartments.md §11) — so membership is never INFERRED from a
  // bare label. Placement is `hsl:<key>` (§1); a bare label is not a placement.
  // Wiring matchHslSubDeptKey in as a fallback here would have moved three live
  // NON-HSL people onto HSL pay: cjm@ / jamec@ / ellyt@, master cell
  // "Executive Assistants" (measured 2026-08-19). Do not "complete" this map.
  assert.equal(normalizeDeptToKey('Case Managers'), null);
  assert.equal(normalizeDeptToKey('case managers'), null);
  assert.equal(normalizeDeptToKey('SSD Medical Records'), null);
  assert.equal(normalizeDeptToKey('Executive Assistants'), null);
  // Regression: the namespaced form and the generic tag must still resolve.
  assert.equal(normalizeDeptToKey('hsl:intake_specialist'), 'hogan_smith_law');
  assert.equal(normalizeDeptToKey('HSL'), 'hogan_smith_law');
});

test('an HSL branch name that collides with an existing top-level department label keeps its ORIGINAL mapping', () => {
  // "Callback Team" is both HSL_DEPTS.callback_team.name AND a pre-existing
  // top-level department in the generic map — the map must keep winning. 14 live
  // active people sat on this exact label on 2026-08-19, none of them HSL.
  assert.equal(normalizeDeptToKey('Callback Team'), 'callback');
  assert.equal(normalizeDeptToKey('callback team'), 'callback');
});

test('a stale/unrecognized hsl:<key> tag still buckets as hogan_smith_law', () => {
  assert.equal(normalizeDeptToKey('hsl:not_a_real_key'), 'hogan_smith_law');
});

// ── the PH email override list ───────────────────────────────────────────────

test('override rewrites the ambiguous "Sales" label for PH cohort emails', () => {
  assert.equal(overrideDeptLabel('Sales', 'mar@simple.biz'), SALES_ASSISTANT_LABEL);
  assert.equal(overrideDeptLabel('sales', 'LARAT@simple.biz'), SALES_ASSISTANT_LABEL); // case-insensitive
  // any-email match: work email misses, personal email hits
  assert.equal(overrideDeptLabel('Sales', 'other@x.com', 'jcr@simple.biz'), SALES_ASSISTANT_LABEL);
});

test('override leaves non-cohort and non-Sales labels alone', () => {
  assert.equal(overrideDeptLabel('Sales', 'dee@simple.biz'), 'Sales'); // US team stays Sales
  assert.equal(overrideDeptLabel('HR', 'mar@simple.biz'), 'HR'); // transfers win — never fights another label
  assert.equal(overrideDeptLabel(null, 'mar@simple.biz'), null); // no label is not membership
  assert.equal(overrideDeptLabel('Sales Assistant', 'mar@simple.biz'), 'Sales Assistant'); // already right
});

test('raw-row helper rewrites Department only when the override applies', () => {
  const ph = { Department: 'Sales', 'Work Email': 'vine@simple.biz', 'Personal Email': null };
  assert.equal(applyDeptOverrideToRawRow(ph).Department, SALES_ASSISTANT_LABEL);
  const us = { Department: 'Sales', 'Work Email': 'brad@simple.biz', 'Personal Email': null };
  assert.equal(applyDeptOverrideToRawRow(us), us); // untouched rows come back identical
});

test('override + normalize compose to the intended keys end to end', () => {
  const key = (label: string | null, email: string) =>
    normalizeDeptToKey(overrideDeptLabel(label, email));
  assert.equal(key('Sales', 'gladysp@simple.biz'), 'sales_assistant'); // PH
  assert.equal(key('Sales', 'randy@simple.biz'), 'sales'); // US
});
