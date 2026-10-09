import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decidePaystubDeliveryAddress,
  guardPaystubEntries,
  nameKey,
  sameName,
  statementNameOf,
  withheldReasonText,
  type AddressHolders,
} from './paystub-delivery-address';

/**
 * Open item 432 (Kane ruled (b), 2026-10-09). A recycled work email's rates row
 * still carried the PREVIOUS holder's personal email, which wins the wizard's
 * first tier, so statements went to ex-employees. The shapes below are measured
 * production cases; the addresses are placeholders, not the real inboxes.
 */
const DOLZ = 'dolz@example.com';
const DIEZ = 'diez@example.com';
const holders = (h: Partial<AddressHolders> & Pick<AddressHolders, 'current' | 'previous'>): AddressHolders => ({
  activeRows: 1,
  currentNames: [],
  ...h,
});
// krisd@: Dolz holds it (since 09-08); Diez left under it on 01-12.
const krisd = holders({
  current: [DOLZ],
  currentNames: [nameKey('Dolz, Kris Alilyn "Alilyn"')],
  previous: [{ email: DIEZ, names: [nameKey('Diez, Marjorie Kriestyl "Kris"')] }],
});

test('a statement named for the current holder, carrying the previous holder\'s address, is re-pointed', () => {
  assert.deepEqual(decidePaystubDeliveryAddress(DIEZ, krisd, 'Dolz, Kris Alilyn "Alilyn"'), { kind: 'replace', to: DOLZ });
  assert.deepEqual(decidePaystubDeliveryAddress('  Diez@Example.com ', krisd, 'Kris Alilyn Dolz'), { kind: 'replace', to: DOLZ });
});

test('the previous holder\'s OWN statement keeps their address (settling an old held week)', () => {
  assert.deepEqual(decidePaystubDeliveryAddress(DIEZ, krisd, 'Marjorie Kriestyl Diez'), { kind: 'keep' });
});

test('overlapping holders (aaronr@): the leaver\'s own statements stay theirs, the new holder\'s are re-pointed', () => {
  // Ramilo started 08-03 while Ramo worked on until 10-06. A date cannot tell them apart.
  const RAMO = 'ramo@example.com';
  const RAMILO = 'ramilo@example.com';
  const aaronr = holders({
    current: [RAMILO],
    currentNames: [nameKey('ramilo, Aaron Simon "Simon"')],
    previous: [
      { email: RAMO, names: [nameKey('Ramo, Aaron Christopher "Christopher"')] },
      { email: RAMILO, names: [nameKey('ramilo, Aaron Simon "Simon"')] },
    ],
  });
  assert.deepEqual(decidePaystubDeliveryAddress(RAMO, aaronr, 'Ramo, Aaron Christopher "Christopher"'), { kind: 'keep' });
  assert.deepEqual(decidePaystubDeliveryAddress(RAMO, aaronr, 'Aaron Christopher Ramo'), { kind: 'keep' });
  assert.deepEqual(decidePaystubDeliveryAddress(RAMO, aaronr, 'ramilo, Aaron Simon "Simon"'), { kind: 'replace', to: RAMILO });
});

test('a shared surname is still two people (rodneys@: Rodney Clark vs Rodney Ken Sarmiento)', () => {
  const KEN = 'ken@example.com';
  const CLARK = 'clark@example.com';
  const rodneys = holders({
    current: [CLARK],
    currentNames: [nameKey('Sarmiento, Rodney Clark "Clark"')],
    previous: [{ email: KEN, names: [nameKey('Sarmiento, Rodney Ken "Ken"')] }],
  });
  assert.deepEqual(decidePaystubDeliveryAddress(KEN, rodneys, 'Sarmiento, Rodney Clark "Clark"'), { kind: 'replace', to: CLARK });
  assert.deepEqual(decidePaystubDeliveryAddress(KEN, rodneys, 'Rodney Ken Sarmiento'), { kind: 'keep' });
  // "Rodney Sarmiento" fits both men: never guess.
  assert.deepEqual(decidePaystubDeliveryAddress(KEN, rodneys, 'Rodney Sarmiento'), { kind: 'withhold', reason: 'statement_holder_unknown' });
});

test('a rehire whose old rows carry the same name is one person, and gets the current address', () => {
  const jebr = holders({
    current: ['now@example.com'],
    currentNames: [nameKey('Ravanilla, Jeb Patrick  "Jeb"')],
    previous: [{ email: 'then@example.com', names: [nameKey('Ravanilla, "Jeb" Patrick')] }],
  });
  assert.deepEqual(decidePaystubDeliveryAddress('then@example.com', jebr, 'Jeb Patrick Ravanilla'), { kind: 'replace', to: 'now@example.com' });
});

test('the current holder\'s own address is kept, whatever the name says', () => {
  assert.deepEqual(decidePaystubDeliveryAddress(DOLZ, krisd, 'Marjorie Kriestyl Diez'), { kind: 'keep' });
  assert.deepEqual(decidePaystubDeliveryAddress(DOLZ, krisd, null), { kind: 'keep' });
});

test('an address unknown to both sides is kept (a changed personal email is not this rule)', () => {
  assert.deepEqual(decidePaystubDeliveryAddress('new@example.com', krisd, null), { kind: 'keep' });
});

test('no active holder: nobody to prefer, the proposal stands', () => {
  const left = holders({ activeRows: 0, current: [], previous: [{ email: DIEZ, names: [] }] });
  assert.deepEqual(decidePaystubDeliveryAddress(DIEZ, left, 'Kris Alilyn Dolz'), { kind: 'keep' });
});

test('a previous holder\'s address on a statement named for nobody we know: withheld', () => {
  assert.deepEqual(decidePaystubDeliveryAddress(DIEZ, krisd, 'Kris Derder'), { kind: 'withhold', reason: 'statement_holder_unknown' });
  assert.deepEqual(decidePaystubDeliveryAddress(DIEZ, krisd, null), { kind: 'withhold', reason: 'statement_holder_unknown' });
  assert.deepEqual(decidePaystubDeliveryAddress(DIEZ, krisd, 'Kris'), { kind: 'withhold', reason: 'statement_holder_unknown' });
});

test('the current holder has no address, or more than one: withheld, never the previous holder', () => {
  const none = { ...krisd, current: [] };
  assert.deepEqual(decidePaystubDeliveryAddress(DIEZ, none, 'Kris Alilyn Dolz'), { kind: 'withhold', reason: 'current_holder_has_no_address' });
  const two = { ...krisd, current: ['a@example.com', 'b@example.com'] };
  assert.deepEqual(decidePaystubDeliveryAddress(DIEZ, two, 'Kris Alilyn Dolz'), { kind: 'withhold', reason: 'current_holder_ambiguous' });
});

test('an unmailable or empty proposal is left to the missing-address path', () => {
  assert.deepEqual(decidePaystubDeliveryAddress('kris alilyn dolz', krisd, 'Kris Alilyn Dolz'), { kind: 'keep' });
  assert.deepEqual(decidePaystubDeliveryAddress(null, krisd, 'Kris Alilyn Dolz'), { kind: 'keep' });
  assert.deepEqual(decidePaystubDeliveryAddress(DIEZ, undefined, 'Kris Alilyn Dolz'), { kind: 'keep' });
});

test('sameName: containment with two shared tokens, never one', () => {
  assert.equal(sameName(nameKey('Aireen Pinili'), nameKey('Pinili, Aireen Grace "Grace"')), true);
  assert.equal(sameName(nameKey('KC LYN ROPAL'), nameKey('Ropal, Kc Lyn "Lyn"')), true);
  assert.equal(sameName(nameKey('Marasigan, Ma. Lany "Lany"'), nameKey('Marasigan, Ma Lany')), true, 'a period is not a token');
  assert.equal(sameName(nameKey('James Violanta'), nameKey('Villacampa, Nino James "James"')), false);
  assert.equal(sameName(nameKey('Kris'), nameKey('Kris Alilyn Dolz')), false);
  assert.equal(sameName([], nameKey('Kris Alilyn Dolz')), false);
});

test('statementNameOf prefers the payload name (what the email prints)', () => {
  assert.equal(statementNameOf({ recipient_name: 'Row', payload: { name: 'Payload' } }), 'Payload');
  assert.equal(statementNameOf({ recipient_name: 'Row', payload: null }), 'Row');
  assert.equal(statementNameOf({}), null);
});

test('guard rewrites the payload AND the column together, and reports by work email', () => {
  const map = new Map([['krisd@simple.biz', krisd]]);
  const { entries, outcomes } = guardPaystubEntries(
    [
      { recipient_email: 'KrisD@simple.biz', personal_email: DIEZ, payload: { name: 'Dolz, Kris Alilyn "Alilyn"', personal_email: DIEZ, pay_php: { final: 1 } } },
      { recipient_email: 'other@simple.biz', personal_email: 'x@example.com', payload: { personal_email: 'x@example.com' } },
    ],
    map,
  );
  assert.equal(entries[0].personal_email, DOLZ);
  assert.equal(entries[0].payload?.personal_email, DOLZ);
  assert.deepEqual(entries[0].payload?.pay_php, { final: 1 }, 'the money is never touched');
  assert.equal(entries[1].personal_email, 'x@example.com');
  assert.deepEqual(outcomes, [{ recipient_email: 'krisd@simple.biz', kind: 'replace' }]);
});

test('guard judges the PAYLOAD address, which is the one n8n mails', () => {
  const { entries } = guardPaystubEntries(
    [{ recipient_email: 'krisd@simple.biz', recipient_name: 'Kris Alilyn Dolz', personal_email: DOLZ, payload: { personal_email: DIEZ } }],
    new Map([['krisd@simple.biz', krisd]]),
  );
  assert.equal(entries[0].payload?.personal_email, DOLZ);
  assert.equal(entries[0].personal_email, DOLZ);
});

test('a withheld entry is staged with no address at all', () => {
  const { entries, outcomes } = guardPaystubEntries(
    [{ recipient_email: 'krisd@simple.biz', recipient_name: 'Kris Derder', personal_email: DIEZ, payload: { personal_email: DIEZ } }],
    new Map([['krisd@simple.biz', krisd]]),
  );
  assert.equal(entries[0].personal_email, null);
  assert.equal(entries[0].payload?.personal_email, null);
  assert.deepEqual(outcomes, [{ recipient_email: 'krisd@simple.biz', kind: 'withhold', reason: 'statement_holder_unknown' }]);
});

test('guard leaves a kept entry as the same object', () => {
  const e = { recipient_email: 'krisd@simple.biz', personal_email: DOLZ, payload: { personal_email: DOLZ } };
  const { entries, outcomes } = guardPaystubEntries([e], new Map([['krisd@simple.biz', krisd]]));
  assert.equal(entries[0], e);
  assert.deepEqual(outcomes, []);
});

test('the withheld text names the work email and never a personal one', () => {
  for (const r of ['current_holder_has_no_address', 'current_holder_ambiguous', 'statement_holder_unknown'] as const) {
    const t = withheldReasonText('krisd@simple.biz', r);
    assert.match(t, /krisd@simple\.biz/);
    assert.doesNotMatch(t, /example\.com/);
  }
});
