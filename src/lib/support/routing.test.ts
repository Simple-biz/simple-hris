import test from 'node:test';
import assert from 'node:assert/strict';
import { steerForCategory, describeSteeredSubjects, STEERED_SUBJECTS } from './routing';
import { SUPPORT_CATEGORIES } from './types';

test('nothing is ever refused — every category is accepted', () => {
  for (const c of SUPPORT_CATEGORIES) {
    const steer = steerForCategory(c);
    assert.ok(
      steer.kind === 'accept' || steer.kind === 'accept_with_notice',
      `${c} produced ${steer.kind}`,
    );
  }
});

test('time adjustments carry the restriction Carla asked for', () => {
  const steer = steerForCategory('hours_time_adjustment');
  assert.equal(steer.kind, 'accept_with_notice');
  if (steer.kind !== 'accept_with_notice') return;
  assert.match(steer.notice, /already been approved/i);
  assert.match(steer.notice, /My Hours/);
  assert.match(steer.notice, /support cannot approve one for you/i);
});

test('the restriction is a notice, not a rejection', () => {
  // The whole steer vocabulary has no refusing member. Adding one is a policy
  // change and would fail this test, which is the point.
  const kinds = SUPPORT_CATEGORIES.map((c) => steerForCategory(c).kind);
  assert.equal(kinds.includes('refuse' as never), false);
});

test('ordinary categories say nothing extra', () => {
  for (const c of ['pay_payslip', 'gmail', 'hubstaff', 'roboform', 'other'] as const) {
    assert.equal(steerForCategory(c).kind, 'accept');
  }
});

test('schedules and time off are named as manager questions', () => {
  const sentence = describeSteeredSubjects();
  assert.match(sentence, /schedule/i);
  assert.match(sentence, /time off/i);
  assert.match(sentence, /manager/i);
});

test('the steer sentence still invites the unsure to ask', () => {
  // A person who does not know who to ask is exactly who must not be turned away.
  assert.match(describeSteeredSubjects(), /not sure who to go to/i);
});

test('the sentence is built from the list, so the list is the only place to edit', () => {
  for (const { subject } of STEERED_SUBJECTS) {
    assert.match(describeSteeredSubjects(), new RegExp(subject.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
