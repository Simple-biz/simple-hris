/**
 * Payment Dispatch must never pay one person through another person's bank row.
 * Cases are the live data of 2026-10-05 (audit items 344 / 353).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bankBelongsToSomeoneElse, personNameTokens, surnameTokens } from './bank-owner-hold';
import { decidePayoutPrefill } from '../hr/payout-prefill-owner';

const hold = (
  workEmail: string,
  payee: { name: string | null; personalEmail: string | null } | null,
  bank: { name: string | null; personalEmail: string | null; workEmail?: string | null } | null,
) =>
  bankBelongsToSomeoneElse({
    workEmail,
    payee,
    bank: bank ? { workEmail: bank.workEmail ?? workEmail, name: bank.name, personalEmail: bank.personalEmail } : null,
  });

test('a recycled address with no master row yet is held — the Tudtud case', () => {
  assert.equal(
    hold('maryt@simple.biz', { name: 'Mary Angelie Tudtud', personalEmail: null }, { name: 'Tan, Mary Jean P. "Jean', personalEmail: 'tan@x.com' }),
    true,
  );
});

test('a previous holder still fronting a live person is held — markp@ and michaelc@', () => {
  assert.equal(
    hold('markp@simple.biz', { name: 'Pahunang, Mark Anthony "Anthony"', personalEmail: 'a@x.com' }, { name: 'Pardillo, Mark "Mark”', personalEmail: 'b@x.com' }),
    true,
  );
  assert.equal(
    hold('michaelc@simple.biz', { name: 'Cuyos, Michael John "MJ"', personalEmail: 'a@x.com' }, { name: 'Michael Jolo Carpio', personalEmail: 'b@x.com' }),
    true,
  );
});

test('the same person with a variant personal email is NOT held (16 of 19 on 2026-10-05)', () => {
  const same: Array<[string, string]> = [
    ['Lim, Breynald John "Brey"', 'Lim Breynald John "Brey"'],
    ['Torres, Rea "Rea"', 'Rea De Torres'],
    ['Sarmiento, Rodney Clark "Clark"', 'Rodney Ken Sarmiento'],
    ['Lepley, Teal', 'Teal Lepley'],
    ['Bencito, Rhocel "Rhocel"', 'Bencito, Rhocel'],
    ['Giducos, John Roy "Roy"', 'Giducos, John Roy "Roy"'],
  ];
  for (const [payeeName, bankName] of same) {
    assert.equal(
      hold('x@simple.biz', { name: payeeName, personalEmail: 'old@x.com' }, { name: bankName, personalEmail: 'new@x.com' }),
      false,
      `${payeeName} vs ${bankName}`,
    );
  }
});

test('matching personal emails are never held, whatever the names say', () => {
  assert.equal(
    hold('x@simple.biz', { name: 'Totally Different', personalEmail: 'Same@X.com ' }, { name: 'Someone Else', personalEmail: 'same@x.com' }),
    false,
  );
});

test('a name that is not a person name proves nothing', () => {
  assert.equal(hold('adrianp@simple.biz', { name: 'Pabalan, Mark', personalEmail: 'a@x.com' }, { name: 'adrianp@simple.biz', personalEmail: 'b@x.com' }), false);
  assert.equal(hold('x@simple.biz', { name: '', personalEmail: 'a@x.com' }, { name: 'Someone Else', personalEmail: 'b@x.com' }), false);
});

test('no payee identity, no bank row, or a row keyed by personal email → no hold', () => {
  assert.equal(hold('x@simple.biz', null, { name: 'A B', personalEmail: 'a@x.com' }), false);
  assert.equal(hold('x@simple.biz', { name: 'A B', personalEmail: 'a@x.com' }, null), false);
  assert.equal(
    hold('x@simple.biz', { name: 'Cruz, Ana', personalEmail: 'a@x.com' }, { name: 'Reyes, Bea', personalEmail: 'b@x.com', workEmail: 'b@x.com' }),
    false,
  );
});

test('name helpers', () => {
  assert.deepEqual(surnameTokens('De Torres, Rea'), ['torres']);
  assert.deepEqual(surnameTokens('Rea De Torres'), ['torres']);
  assert.equal(personNameTokens('someone@simple.biz'), null);
  assert.ok(personNameTokens('Pardillo, Mark "Mark”')?.has('pardillo'));
});

test('promote never writes a hire’s bank details onto another person’s row', () => {
  assert.equal(decidePayoutPrefill(null, 'hire@x.com'), 'insert');
  assert.equal(decidePayoutPrefill({ personalEmail: ' Hire@X.com' }, 'hire@x.com'), 'update');
  assert.equal(decidePayoutPrefill({ personalEmail: 'tan@x.com' }, 'hire@x.com'), 'refuse');
  assert.equal(decidePayoutPrefill({ personalEmail: null }, 'hire@x.com'), 'refuse');
  assert.equal(decidePayoutPrefill({ personalEmail: 'hire@x.com' }, null), 'refuse');
});

test('promote routes its pre-fill through decidePayoutPrefill and the queue applies the hold', () => {
  const promote = readFileSync(join(process.cwd(), 'src/lib/supabase/hr-pending-employees.ts'), 'utf8');
  assert.match(promote, /decidePayoutPrefill\(/);
  assert.match(promote, /\.select\("employee_id, personal_email"\)/);
  const builders = readFileSync(join(process.cwd(), 'src/components/payroll-clerk/mock-queue.ts'), 'utf8');
  assert.match(builders, /bankBelongsToSomeoneElse\(/);
  assert.match(builders, /reasons: \['bank_owner_mismatch'\]/);
  const queue = readFileSync(join(process.cwd(), 'src/components/payroll-clerk/useDispatchQueue.ts'), 'utf8');
  const hold = queue.indexOf('applyBankOwnerHold(');
  assert.ok(hold > 0, 'useDispatchQueue must apply the hold');
  // Applied after the last overlay (the Wise reroute), so nothing re-adds `payable`.
  assert.ok(hold > queue.indexOf('applySmallWiresWiseReroute(r.payable)'), 'hold must run after the reroute');
});

test('a held row loses its Pay button and keeps the payee name', async () => {
  const { applyBankOwnerHold } = await import('../../components/payroll-clerk/mock-queue');
  const row = {
    id: 'maryt@simple.biz', processor: 'hurupay', name: 'Tan, Mary Jean', email: 'maryt@simple.biz',
    amountUSD: 97.28, amountPHP: 6077.75, amountCOP: null, payCurrency: 'PHP', countryCurrency: null,
    initialPayUSD: null, initialPayPHP: null, pabBonusPHP: 0, techBonusPHP: 0, bonusTotalPHP: 0,
    otherBonusesPHP: 0, adjustmentPHP: 0, orphanagePayPHP: 0, mesaDeductionPHP: 0, mesaDisbursementPHP: 0,
    valuesSource: 'snapshot', totalHours: 34.73, otHours: 0, bankPreferredRaw: 'hurupay',
    departmentKey: 'lead_gen', departmentName: 'Lead Gen', details: {},
  } as never;
  const ids = new Map([['maryt@simple.biz', { work_email: 'maryt@simple.biz', name: 'Tan, Mary Jean', personal_email: 'tan@x.com' }]]) as never;
  const out = applyBankOwnerHold([row], [], ids, { 'maryt@simple.biz': { name: 'Mary Angelie Tudtud', personalEmail: null } });
  assert.equal(out.pending.length, 0);
  assert.equal(out.excluded.length, 1);
  assert.deepEqual(out.excluded[0].reasons, ['bank_owner_mismatch']);
  assert.equal(out.excluded[0].payable, null);
  assert.equal(out.excluded[0].name, 'Mary Angelie Tudtud');
  assert.equal(out.held, 1);
  const none = applyBankOwnerHold([row], [], ids, undefined);
  assert.equal(none.pending.length, 1, 'no identity map → nobody held, queue never blanked');
});
