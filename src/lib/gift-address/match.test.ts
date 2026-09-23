/**
 * Which person a typed address is, and which inbox gets the code.
 *
 * The properties these protect: an alternate work email reaches its owner (the
 * travis@ = arcyb@ lockout, 2026-09-23), the identity is always the PRIMARY, a
 * code never goes to a non-company inbox, and an ambiguous alternate is refused
 * rather than guessed.
 *
 * Run:  npx tsx --test src/lib/gift-address/match.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTypedEmail, type RosterEmailRow } from './match';

function row(p: Partial<RosterEmailRow>): RosterEmailRow {
  return {
    name: 'Someone',
    workEmail: null,
    personalEmail: null,
    alternateWorkEmail: null,
    alternateWorkEmail2: null,
    startDate: '6/17/24',
    ...p,
  };
}

const arcy = row({
  name: 'Bucu, Arcy R. "Arcy"',
  workEmail: 'arcyb@simple.biz',
  personalEmail: 'rcbucu0312@gmail.com',
  alternateWorkEmail: 'travis@simple.biz',
});

test('an alternate work email resolves to its owner and receives the code itself', () => {
  const m = resolveTypedEmail('Travis@Simple.biz ', [arcy]);
  assert.ok(m);
  assert.equal(m.workEmail, 'arcyb@simple.biz');
  assert.equal(m.deliverTo, 'travis@simple.biz');
  assert.equal(m.matchedOn, 'alternate_work_email');
});

test('the second alternate column is read too', () => {
  const r = row({ workEmail: 'a@simple.biz', alternateWorkEmail2: 'alias@simple.biz' });
  const m = resolveTypedEmail('alias@simple.biz', [r]);
  assert.equal(m?.workEmail, 'a@simple.biz');
  assert.equal(m?.deliverTo, 'alias@simple.biz');
});

test('the primary work email still delivers to itself', () => {
  const m = resolveTypedEmail('arcyb@simple.biz', [arcy]);
  assert.equal(m?.deliverTo, 'arcyb@simple.biz');
  assert.equal(m?.matchedOn, 'work_email');
});

test('a personal email NEVER receives the code — it goes to the primary', () => {
  const m = resolveTypedEmail('rcbucu0312@gmail.com', [arcy]);
  assert.equal(m?.workEmail, 'arcyb@simple.biz');
  assert.equal(m?.deliverTo, 'arcyb@simple.biz');
  assert.equal(m?.matchedOn, 'personal_email');
});

test('an alternate cell holding a non-company address delivers to the primary', () => {
  const r = row({ workEmail: 'b@simple.biz', alternateWorkEmail: 'b.personal@gmail.com' });
  const m = resolveTypedEmail('b.personal@gmail.com', [r]);
  assert.equal(m?.workEmail, 'b@simple.biz');
  assert.equal(m?.deliverTo, 'b@simple.biz');
});

test("a person's own Work Email outranks being someone else's alternate", () => {
  const owner = row({ workEmail: 'steve@simple.biz' });
  const other = row({ workEmail: 'stevenx@simple.biz', alternateWorkEmail: 'steve@simple.biz' });
  const m = resolveTypedEmail('steve@simple.biz', [other, owner]);
  assert.equal(m?.workEmail, 'steve@simple.biz');
  assert.equal(m?.matchedOn, 'work_email');
});

test('an alternate claimed by two different people is refused, not guessed', () => {
  const a = row({ workEmail: 'one@simple.biz', alternateWorkEmail: 'shared@simple.biz' });
  const b = row({ workEmail: 'two@simple.biz', alternateWorkEmail2: 'shared@simple.biz' });
  assert.equal(resolveTypedEmail('shared@simple.biz', [a, b]), null);
});

test('two rows for the SAME person sharing an alternate still resolve', () => {
  const a = row({ workEmail: 'one@simple.biz', alternateWorkEmail: 'alias@simple.biz' });
  const b = row({ workEmail: 'ONE@simple.biz', alternateWorkEmail: 'alias@simple.biz' });
  assert.equal(resolveTypedEmail('alias@simple.biz', [a, b])?.workEmail, 'one@simple.biz');
});

test('a row with no primary Work Email can never match, even on its alternate', () => {
  const r = row({ workEmail: '  ', alternateWorkEmail: 'orphan@simple.biz' });
  assert.equal(resolveTypedEmail('orphan@simple.biz', [r]), null);
});

test('nobody, blank input and a near-miss all resolve to null', () => {
  assert.equal(resolveTypedEmail('nobody@simple.biz', [arcy]), null);
  assert.equal(resolveTypedEmail('   ', [arcy]), null);
  assert.equal(resolveTypedEmail('travis@simple.biz.evil.com', [arcy]), null);
});
