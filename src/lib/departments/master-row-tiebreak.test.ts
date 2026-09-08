/**
 * Pins the duplicate-master-row tie-break.
 *
 * A person with an `hsl:*` row AND a non-HSL row is graded for PAB by whichever
 * row wins. If this regresses to first-occurrence-wins, 138 active people go
 * back to being graded under whichever rule the query happened to return first.
 *
 * Run: npx tsx --test src/lib/departments/master-row-tiebreak.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isAmbiguousDeptPair, pickMasterRowForWorkEmail } from './master-row-tiebreak';

const row = (department: string | null) => ({ department });

test('no incumbent — the candidate wins', () => {
  const c = row('Lead Gen');
  assert.equal(pickMasterRowForWorkEmail(undefined, c), c);
});

test('HSL displaces a non-HSL incumbent (reat@: Lead Gen indexed first)', () => {
  const first = row('Lead Gen');
  const hsl = row('hsl:callback_team');
  assert.equal(pickMasterRowForWorkEmail(first, hsl), hsl);
});

test('HSL keeps the win when it was indexed first (order cannot change the verdict)', () => {
  const hsl = row('hsl:filing_specialist');
  const other = row('Client - VA');
  assert.equal(pickMasterRowForWorkEmail(hsl, other), hsl);
});

test('the verdict is the SAME whichever order the rows arrive — that is the whole point', () => {
  const hsl = row('hsl:intake_specialist');
  const lead = row('Lead Gen');
  const forward = pickMasterRowForWorkEmail(pickMasterRowForWorkEmail(undefined, hsl), lead);
  const reverse = pickMasterRowForWorkEmail(pickMasterRowForWorkEmail(undefined, lead), hsl);
  assert.equal(forward.department, 'hsl:intake_specialist');
  assert.equal(reverse.department, 'hsl:intake_specialist');
});

test('"Hogan Smith Law" spelled out counts as HSL, not just the hsl: prefix', () => {
  assert.equal(pickMasterRowForWorkEmail(row('Lead Gen'), row('Hogan Smith Law')).department, 'Hogan Smith Law');
});

test('two non-HSL rows keep first-occurrence-wins — unchanged behaviour', () => {
  const first = row('Lead Gen');
  assert.equal(pickMasterRowForWorkEmail(first, row('Client - VA')), first);
});

test('a null department never displaces a real one', () => {
  const first = row('Lead Gen');
  assert.equal(pickMasterRowForWorkEmail(first, row(null)), first);
  assert.equal(pickMasterRowForWorkEmail(row(null), row('hsl:attestation')).department, 'hsl:attestation');
});

test('ambiguity = the pair disagrees about the PAB rule', () => {
  assert.equal(isAmbiguousDeptPair('hsl:callback_team', 'Lead Gen'), true);
  assert.equal(isAmbiguousDeptPair('Lead Gen', 'hsl:callback_team'), true);
  // Two non-HSL depts are bad data but grade identically — not a pay ambiguity.
  assert.equal(isAmbiguousDeptPair('Lead Gen', 'Client - VA'), false);
  // Two HSL sub-departments likewise.
  assert.equal(isAmbiguousDeptPair('hsl:attestation', 'hsl:collections'), false);
});
