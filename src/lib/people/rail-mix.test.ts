import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPayoutComplete,
  isWalletRail,
  payoutRequirementFor,
  resolveEffectivePayoutProcessor,
} from '@/lib/employee/payout-completeness';
import {
  buildRailMix,
  buildRailMixByDepartment,
  NO_DEPARTMENT,
  type RailAssignment,
} from './rail-mix';

/**
 * These pin the People → Bank changes KPI band. Both cards are rail-shaped: the
 * first counts who each send-from rail carries, the second how many of those are
 * payable on it. No bank names — see bank-preferred-routing.md §10.
 *
 * The band's whole claim to trust is that it folds the SAME resolution the roster
 * chip and the Missing-bank-info list use, so the rail resolution is pinned here
 * too, one case per drift class from the 2026-08-10 People-vs-PD audit.
 */

// ── Which rail (card 1) ────────────────────────────────────────────────────

test('rail follows PD precedence: bank_preferred outranks the Disbursement pick', () => {
  const rail = resolveEffectivePayoutProcessor(
    { bank_preferred: 'hurupay', preferred_processor: 'wires' },
    { bankPreferredRaw: 'Wise' },
  );
  assert.equal(rail, 'hurupay');
});

test('rail falls through to the legacy rates-sheet cell', () => {
  assert.equal(resolveEffectivePayoutProcessor({}, { bankPreferredRaw: 'x1153' }), 'wires');
});

test('no rail at all is unrouted, and unrouted is never payable', () => {
  assert.equal(resolveEffectivePayoutProcessor({ bank_name: 'BDO', account_number: '9' }), null);

  const mix = buildRailMix([{ rail: null, payable: true }]);
  assert.equal(mix.unrouted, 1);
  assert.equal(mix.routed, 0);
  assert.equal(mix.payable, 0, 'an unrouted person cannot be paid, whatever they carry');
});

// ── Which rails get a row ──────────────────────────────────────────────────

test('a retired rail with payees on it keeps its row', () => {
  const mix = buildRailMix([
    { rail: 'wise', payable: true },
    { rail: 'jeeves', payable: true },
  ]);
  const keys = mix.rails.map((r) => r.key);
  assert.ok(keys.includes('wise'), 'Wise is retired but carries live payees');
  assert.ok(keys.includes('jeeves'), 'Jeeves is retired but carries live payees');
});

test('a rail that is BOTH retired and empty is dropped (Wepay)', () => {
  const mix = buildRailMix([{ rail: 'wires', payable: true }]);
  assert.equal(
    mix.rails.some((r) => r.key === 'wepay'),
    false,
  );
});

test('still-offered rails show at zero rather than vanishing', () => {
  const mix = buildRailMix([{ rail: 'wires', payable: true }]);
  const byKey = new Map(mix.rails.map((r) => [r.key, r.count]));
  assert.equal(byKey.get('hurupay'), 0);
  assert.equal(byKey.get('higlobe'), 0);
  assert.equal(byKey.get('wires'), 1);
});

test('Wepay returns the moment one payee lands on it — dropped by rule, not by name', () => {
  const mix = buildRailMix([{ rail: 'wepay', payable: false }]);
  assert.equal(
    mix.rails.some((r) => r.key === 'wepay'),
    true,
  );
});

test('rails sort by headcount, then name — deterministic', () => {
  const mix = buildRailMix([
    { rail: 'wise', payable: true },
    { rail: 'wise', payable: true },
    { rail: 'wires', payable: true },
    { rail: 'higlobe', payable: true },
  ]);
  assert.deepEqual(
    mix.rails.filter((r) => r.count > 0).map((r) => [r.label, r.count]),
    [
      ['Wise', 2],
      ['Higlobe', 1],
      ['Wires', 1],
    ],
  );
});

// ── Payable per rail (card 2) ──────────────────────────────────────────────

test('payable counts per rail, never above that rail headcount', () => {
  const mix = buildRailMix([
    { rail: 'wires', payable: true },
    { rail: 'wires', payable: true },
    { rail: 'wires', payable: false },
    { rail: 'hurupay', payable: true },
  ]);
  const wires = mix.rails.find((r) => r.key === 'wires');
  assert.ok(wires);
  assert.equal(wires.count, 3);
  assert.equal(wires.payable, 2);
  for (const r of mix.rails) assert.ok(r.payable <= r.count, `${r.label} payable exceeds its count`);
});

test('a rail carrying nobody reports zero payable, not an undefined ratio', () => {
  const mix = buildRailMix([{ rail: 'wires', payable: true }]);
  const hurupay = mix.rails.find((r) => r.key === 'hurupay');
  assert.ok(hurupay);
  assert.equal(hurupay.count, 0);
  assert.equal(hurupay.payable, 0);
});

test('the requirement caption matches what isPayoutComplete actually checks', () => {
  // Wallet rails: the wallet email is enough, wire details are not.
  assert.equal(payoutRequirementFor('hurupay'), 'wallet email');
  assert.equal(isPayoutComplete({ bank_preferred: 'hurupay', hurupay_email: 'a@b.com' }), true);
  assert.equal(
    isPayoutComplete({ bank_preferred: 'hurupay', bank_name: 'BDO', account_number: '1' }),
    false,
    'wire details never substitute for a wallet deposit',
  );

  // HiGlobe needs both halves.
  assert.equal(payoutRequirementFor('higlobe'), 'email + account name');
  assert.equal(isPayoutComplete({ bank_preferred: 'higlobe', higlobe_email: 'a@b.com' }), false);
  assert.equal(
    isPayoutComplete({ bank_preferred: 'higlobe', higlobe_email: 'a@b.com', higlobe_account_name: 'A B' }),
    true,
  );

  // Bank rails, Wise included: payouts land in the payee's bank account.
  assert.equal(payoutRequirementFor('wise'), 'bank + account');
  assert.equal(isPayoutComplete({ bank_preferred: 'wise', wise_email: 'a@b.com' }), false);
  assert.equal(
    isPayoutComplete({ bank_preferred: 'wise', bank_name: 'Metrobank', account_number: '1' }),
    true,
  );
  assert.equal(payoutRequirementFor('wires'), 'bank + account');
  assert.equal(payoutRequirementFor('jeeves'), 'bank + account');
});

test('wallet classification derives from the requirement, so the two agree', () => {
  assert.equal(isWalletRail('hurupay'), true);
  assert.equal(isWalletRail('wepay'), true);
  assert.equal(isWalletRail('higlobe'), true);
  assert.equal(isWalletRail('wise'), false, 'Wise pays into a bank account, not a wallet');
  assert.equal(isWalletRail('wires'), false);
  assert.equal(isWalletRail('jeeves'), false);

  const mix = buildRailMix([{ rail: 'wise', payable: true }]);
  const wise = mix.rails.find((r) => r.key === 'wise');
  assert.equal(wise?.wallet, false);
});

test('either bank slot makes a bank-rail payee payable (PD pickFirst falls back)', () => {
  assert.equal(
    isPayoutComplete({ bank_preferred: 'wires', alt_bank_name: 'UnionBank', alt_account_number: '7' }),
    true,
  );
});

// ── Arithmetic both cards are read against ─────────────────────────────────

test('the mix balances: total = routed + unrouted, routed = wallet + bankRail', () => {
  const people: RailAssignment[] = [
    { rail: 'hurupay', payable: true },
    { rail: 'hurupay', payable: false },
    { rail: 'higlobe', payable: true },
    { rail: 'wires', payable: true },
    { rail: 'wise', payable: false },
    { rail: null, payable: false },
  ];
  const mix = buildRailMix(people);

  assert.equal(mix.total, 6);
  assert.equal(mix.total, mix.routed + mix.unrouted);
  assert.equal(mix.routed, mix.wallet + mix.bankRail);
  assert.equal(mix.wallet, 3, 'hurupay ×2 + higlobe');
  assert.equal(mix.bankRail, 2, 'wires + wise');
  assert.equal(
    mix.routed,
    mix.rails.reduce((s, r) => s + r.count, 0),
  );
  assert.equal(
    mix.payable,
    mix.rails.reduce((s, r) => s + r.payable, 0),
  );
  assert.equal(mix.payable, 3);
});

test('an empty roster produces zeros, not NaN or a phantom leader', () => {
  const mix = buildRailMix([]);
  assert.equal(mix.total, 0);
  assert.equal(mix.routed, 0);
  assert.equal(mix.unrouted, 0);
  assert.equal(mix.payable, 0);
  assert.equal(mix.wallet, 0);
  assert.equal(mix.bankRail, 0);
  // The still-offered rails still hold rows, all zero.
  assert.ok(mix.rails.length > 0);
  for (const r of mix.rails) {
    assert.equal(r.count, 0);
    assert.equal(r.payable, 0);
  }
});

// ── Per-department folds ───────────────────────────────────────────────────

test('buildRailMixByDepartment folds each department separately', () => {
  const byDept = buildRailMixByDepartment([
    { department: 'Sales', rail: 'wires', payable: true },
    { department: 'Sales', rail: 'hurupay', payable: false },
    { department: 'HSL', rail: 'wise', payable: true },
  ]);
  assert.equal(byDept.Sales.total, 2);
  assert.equal(byDept.Sales.payable, 1);
  assert.equal(byDept.HSL.total, 1);
  assert.equal(byDept.HSL.bankRail, 1);
});

test('a blank or null department buckets under NO_DEPARTMENT, never dropped', () => {
  const byDept = buildRailMixByDepartment([
    { department: null, rail: null, payable: false },
    { department: '   ', rail: 'hurupay', payable: true },
    { department: 'Sales', rail: 'wires', payable: true },
  ]);
  assert.equal(byDept[NO_DEPARTMENT].total, 2);
  const grandTotal = Object.values(byDept).reduce((s, m) => s + m.total, 0);
  assert.equal(grandTotal, 3, 'every person lands in exactly one department bucket');
});

test('department folds sum back to the org-wide fold', () => {
  const people = [
    { department: 'Sales', rail: 'wires', payable: true },
    { department: 'HSL', rail: 'wise', payable: false },
    { department: 'HSL', rail: 'higlobe', payable: true },
    { department: null, rail: null, payable: false },
  ] as const;
  const whole = buildRailMix(people.map((p) => ({ rail: p.rail, payable: p.payable })));
  const parts = Object.values(buildRailMixByDepartment(people));

  assert.equal(
    parts.reduce((s, m) => s + m.total, 0),
    whole.total,
  );
  assert.equal(
    parts.reduce((s, m) => s + m.routed, 0),
    whole.routed,
  );
  assert.equal(
    parts.reduce((s, m) => s + m.payable, 0),
    whole.payable,
  );
  assert.equal(
    parts.reduce((s, m) => s + m.wallet, 0),
    whole.wallet,
  );
  assert.equal(
    parts.reduce((s, m) => s + m.bankRail, 0),
    whole.bankRail,
  );
});
