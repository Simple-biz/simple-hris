import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAddressHolders } from './paystub-address-holders';
import { nameKey } from '@/lib/payroll/paystub-delivery-address';

/**
 * The fold behind the paystub delivery guard (Open item 432). The krisd@ shape:
 * the current holder's master row is active, and the previous holder exists only
 * as a ledger row (her master row is gone).
 */
const gml = (id: string, name: string, work: string, personal: string | null, offAt: string | null, alt?: string) => ({
  id,
  Name: name,
  'Work Email': work,
  'Alternate Work Email': alt ?? null,
  'Alternate Work Email 2': null,
  'Personal Email': personal,
  off_boarded_at: offAt,
});
const ledger = (id: number, name: string, work: string, personal: string) => ({ id, name, work_email: work, personal_email: personal });

test('active master row is CURRENT, ledger row is PREVIOUS (krisd@)', () => {
  const h = buildAddressHolders(
    new Set(['krisd@simple.biz']),
    [gml('g1', 'Dolz, Kris Alilyn "Alilyn"', 'KrisD@simple.biz', ' Dolz@Example.com ', null)],
    [ledger(1, 'Diez, Marjorie Kriestyl "Kris"', 'krisd@simple.biz', 'diez@example.com')],
  );
  assert.deepEqual(h.get('krisd@simple.biz'), {
    activeRows: 1,
    current: ['dolz@example.com'],
    currentNames: [nameKey('Dolz, Kris Alilyn')],
    previous: [{ email: 'diez@example.com', names: [nameKey('Diez, Marjorie Kriestyl "Kris"')] }],
  });
});

test('an off-boarded master row counts as a PREVIOUS holder, with its name', () => {
  const h = buildAddressHolders(
    new Set(['maryt@simple.biz']),
    [
      gml('g1', 'Tudtud, Mary Angelie', 'maryt@simple.biz', 'tudtud@example.com', null),
      gml('g2', 'Tronco, Mary', 'maryt@simple.biz', 'tronco@example.com', '2026-05-04'),
    ],
    [ledger(9, 'Tronco, Mary "Mary"', 'maryt@simple.biz', 'tronco@example.com')],
  );
  const m = h.get('maryt@simple.biz')!;
  assert.deepEqual(m.current, ['tudtud@example.com']);
  assert.deepEqual(m.previous, [{ email: 'tronco@example.com', names: [nameKey('Tronco, Mary')] }], 'one name, recorded twice');
});

test('an ALTERNATE work email makes its active row a current holder', () => {
  const h = buildAddressHolders(new Set(['kevin@simple.biz']), [gml('g1', 'Kevin T', 'kevt@simple.biz', 'kev@example.com', null, 'kevin@simple.biz')], []);
  assert.equal(h.get('kevin@simple.biz')?.activeRows, 1);
  assert.deepEqual(h.get('kevin@simple.biz')?.current, ['kev@example.com']);
});

test('an active row with no mailable personal email still counts as a holder', () => {
  const h = buildAddressHolders(new Set(['a@simple.biz']), [gml('g1', 'A B', 'a@simple.biz', 'not an email', null)], []);
  assert.equal(h.get('a@simple.biz')?.activeRows, 1);
  assert.deepEqual(h.get('a@simple.biz')?.current, []);
});

test('a row returned by two column queries is counted once', () => {
  const row = gml('g1', 'A B', 'a@simple.biz', 'a@example.com', null, 'a@simple.biz');
  const h = buildAddressHolders(new Set(['a@simple.biz']), [row, row], []);
  assert.equal(h.get('a@simple.biz')?.activeRows, 1);
});

test('rows for addresses nobody asked about are ignored', () => {
  const h = buildAddressHolders(new Set(['a@simple.biz']), [gml('g1', 'B C', 'b@simple.biz', 'b@example.com', null)], [
    ledger(2, 'Old One', 'b@simple.biz', 'old@example.com'),
  ]);
  assert.equal(h.size, 0);
});
