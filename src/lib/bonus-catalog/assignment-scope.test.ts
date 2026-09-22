/**
 * Sub-team-targeted bonus assignments (2026-09-21).
 *
 * The rule under test: a bonus assigned to `lead_gen:nurture` reaches ONLY the
 * members whose raw master cell is that sub-team, lands on the Lead Gen card,
 * and never produces a namespaced applied row. A bonus assigned to the bare
 * department still reaches everyone.
 *
 * Run:  npx tsx --test src/lib/bonus-catalog/assignment-scope.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignmentParentKey,
  assignmentReachesMember,
  assignmentScopeCell,
  buildCommonScopeIndex,
  isDeadBonusTargetKey,
} from './assignment-scope';

test('parent key: a sub-team assignment lands on its department card', () => {
  assert.equal(assignmentParentKey('lead_gen:nurture'), 'lead_gen');
  assert.equal(assignmentParentKey('Lead Gen:Nurture'), 'lead_gen');
  assert.equal(assignmentParentKey('lead_gen'), 'lead_gen');
  assert.equal(assignmentParentKey('hsl:intake_specialist'), 'hogan_smith_law');
  // An in-app registry key has no alias entry and stays itself — unchanged.
  assert.equal(assignmentParentKey('executive_assistants'), 'executive_assistants');
});

test('scope cell: only a namespaced key under a REAL department restricts', () => {
  assert.equal(assignmentScopeCell('lead_gen:nurture'), 'lead_gen:nurture');
  assert.equal(assignmentScopeCell('Lead_Gen:Nurture'), 'lead_gen:nurture', 'lower-cased to match cells');
  assert.equal(assignmentScopeCell('lead_gen'), null, 'bare = department-wide');
  assert.equal(assignmentScopeCell('executive_assistants:x'), null, 'unknown parent = unchanged, department-wide');
  assert.equal(assignmentScopeCell(''), null);
});

test('reach: department-wide reaches everyone; a sub-team reaches its cell only', () => {
  assert.equal(assignmentReachesMember(null, 'Lead Gen'), true);
  assert.equal(assignmentReachesMember(null, undefined), true, 'an external with no cell still gets dept-wide bonuses');
  assert.equal(assignmentReachesMember('lead_gen:nurture', 'lead_gen:nurture'), true);
  assert.equal(assignmentReachesMember('lead_gen:nurture', 'LEAD_GEN:NURTURE'), true);
  assert.equal(assignmentReachesMember('lead_gen:nurture', 'lead_gen:outbound'), false);
  assert.equal(assignmentReachesMember('lead_gen:nurture', 'Lead Gen'), false, 'a bare-cell person is NOT in the sub-team');
  assert.equal(assignmentReachesMember('lead_gen:nurture', undefined), false, 'no known cell never qualifies — fail closed');
  assert.equal(assignmentReachesMember('lead_gen:nurture', ''), false);
});

test('scope index: per parent, per bonus; a bare assignment makes the bonus department-wide', () => {
  const idx = buildCommonScopeIndex([
    { scope: 'department', departmentKey: 'lead_gen:nurture', bonusId: 'b1' },
    { scope: 'department', departmentKey: 'lead_gen:outbound', bonusId: 'b1' },
    { scope: 'department', departmentKey: 'lead_gen:nurture', bonusId: 'b2' },
    { scope: 'department', departmentKey: 'lead_gen', bonusId: 'b2' }, // bare too -> wide
    { scope: 'department', departmentKey: 'qc', bonusId: 'b3' },
    { scope: 'employee', departmentKey: 'lead_gen:nurture', bonusId: 'b4' }, // ignored: not department scope
  ]);
  assert.deepEqual([...idx.get('lead_gen')!.get('b1')!].sort(), ['lead_gen:nurture', 'lead_gen:outbound']);
  assert.equal(idx.get('lead_gen')!.has('b2'), false, 'bare + sub-team = unrestricted');
  assert.equal(idx.has('qc'), false, 'a department with only bare assignments has no restrictions');
});

test('dead targets INVERTED 2026-09-22: the BARE family is dead, sub-teams are live', () => {
  // Was: every hsl:* refused, because the HSL card did not read the catalog.
  // Now: the card scores a sub-team assignment as an extra rule folded into
  // calculated_bonus (hsl-bonus/catalog-bonus.ts), so sub-teams are real targets.
  assert.equal(isDeadBonusTargetKey('hsl:intake_specialist'), false);
  assert.equal(isDeadBonusTargetKey('hsl:spanish_intake'), false, 'a DATA HSL team is live too');
  assert.equal(isDeadBonusTargetKey('lead_gen:nurture'), false);
  assert.equal(isDeadBonusTargetKey('lead_gen'), false);
  // The bare family has NO card of its own — the calculator is per sub-team —
  // so a bonus assigned there is drawn by nothing. It used to be offered and
  // silently dead; refusing it is the tightening this change earns.
  assert.equal(isDeadBonusTargetKey('hogan_smith_law'), true);
  assert.equal(isDeadBonusTargetKey('HSL'), true);
  assert.equal(isDeadBonusTargetKey('Hogan Smith Law'), true);
  assert.equal(isDeadBonusTargetKey(''), false);
});
