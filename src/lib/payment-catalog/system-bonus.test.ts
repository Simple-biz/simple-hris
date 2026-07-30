import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCustomSystemBonusCode,
  isDeptEligible,
  makeCustomSystemBonusCode,
  resolveSystemBonuses,
  systemBonusAmountForDept,
  systemBonusBase,
  validateSystemBonus,
  variantForDept,
  type SystemBonus,
} from './system-bonus';

// ── Custom system bonuses (COP / USD variants of PAB + Tech) ────────────────
// A custom row (`pab:<slug>` / `tech:<slug>`) keeps the built-in engine timing
// but overrides the AMOUNT for its department allowlist, converted to PHP at
// the USD-anchored FX rates. These tests pin the resolution semantics every
// pay surface (current-pay, member-monthly-pay, wizard, dashboards) relies on.

const FX = { usdToPhp: 56, usdToCop: 4000 }; // php_per_cop = 0.014

function builtIn(code: 'pab' | 'tech', amount: number, depts: string[]): SystemBonus {
  return {
    code,
    label: code === 'pab' ? 'Perfect Attendance Bonus' : 'Technology Bonus',
    amount,
    currency: 'PHP',
    enabled: true,
    departmentKeys: depts,
  };
}

test('code helpers: base + custom detection + minted codes', () => {
  assert.equal(systemBonusBase('pab'), 'pab');
  assert.equal(systemBonusBase('tech'), 'tech');
  assert.equal(systemBonusBase('pab:col-team-x1'), 'pab');
  assert.equal(systemBonusBase('tech:us-a9'), 'tech');
  assert.equal(systemBonusBase('bogus'), null);

  assert.equal(isCustomSystemBonusCode('pab'), false);
  assert.equal(isCustomSystemBonusCode('pab:col-team-x1'), true);
  assert.equal(isCustomSystemBonusCode('bogus:x'), false);

  const code = makeCustomSystemBonusCode('tech', 'Technology Bonus (US)');
  assert.equal(systemBonusBase(code), 'tech');
  assert.ok(isCustomSystemBonusCode(code));
  assert.ok(validateSystemBonus({
    code,
    label: 'Technology Bonus (US)',
    amount: 35,
    currency: 'USD',
    departmentKeys: ['us_manager_bonus'],
  }).ok);
});

test('variant overrides the built-in amount for its departments only', () => {
  const rows: SystemBonus[] = [
    builtIn('tech', 1850, ['devs', 'qc']),
    {
      code: 'tech:us-team-a1',
      label: 'Technology Bonus (US)',
      amount: 35,
      currency: 'USD',
      enabled: true,
      departmentKeys: ['us_manager_bonus'],
    },
  ];
  const { tech } = resolveSystemBonuses(rows, FX);

  // Built-in departments keep the base PHP amount.
  assert.equal(systemBonusAmountForDept(tech, 'devs'), 1850);
  // Variant department pays $35 converted at usdToPhp.
  assert.equal(systemBonusAmountForDept(tech, 'us_manager_bonus'), 35 * 56);
  assert.equal(variantForDept(tech, 'us_manager_bonus')?.currency, 'USD');

  // The variant is an explicit opt-in: its dept is eligible even though the
  // built-in allowlist omits it; unrelated depts stay excluded.
  assert.equal(isDeptEligible(tech, 'us_manager_bonus'), true);
  assert.equal(isDeptEligible(tech, 'devs'), true);
  assert.equal(isDeptEligible(tech, 'hr'), false);
});

test('COP variant converts through the USD anchor', () => {
  const rows: SystemBonus[] = [
    builtIn('pab', 5000, ['devs']),
    {
      code: 'pab:colombia-b2',
      label: 'PAB (Colombia)',
      amount: 200_000,
      currency: 'COP',
      enabled: true,
      departmentKeys: ['smm'],
    },
  ];
  const { pab } = resolveSystemBonuses(rows, FX);
  // 200,000 COP * (56 / 4000) = 2,800 PHP
  assert.equal(systemBonusAmountForDept(pab, 'smm'), 2800);
  assert.equal(systemBonusAmountForDept(pab, 'devs'), 5000);
});

test('disabled or empty-allowlist variants are ignored', () => {
  const rows: SystemBonus[] = [
    builtIn('pab', 5000, ['devs']),
    {
      code: 'pab:off-c3',
      label: 'Disabled variant',
      amount: 99,
      currency: 'USD',
      enabled: false,
      departmentKeys: ['devs'],
    },
    {
      code: 'pab:empty-d4',
      label: 'No depts',
      amount: 99,
      currency: 'USD',
      enabled: true,
      departmentKeys: [],
    },
  ];
  const { pab } = resolveSystemBonuses(rows, FX);
  assert.equal(pab.variants.length, 0);
  assert.equal(systemBonusAmountForDept(pab, 'devs'), 5000);
});

test('variant still applies when the built-in row is disabled', () => {
  const rows: SystemBonus[] = [
    { ...builtIn('tech', 1850, ['devs']), enabled: false },
    {
      code: 'tech:us-e5',
      label: 'Tech (US)',
      amount: 20,
      currency: 'USD',
      enabled: true,
      departmentKeys: ['us_manager_bonus'],
    },
  ];
  const { tech } = resolveSystemBonuses(rows, FX);
  assert.equal(isDeptEligible(tech, 'devs'), false); // base disabled
  assert.equal(isDeptEligible(tech, 'us_manager_bonus'), true); // variant opt-in
  assert.equal(systemBonusAmountForDept(tech, 'us_manager_bonus'), 20 * 56);
});

test('legacy behavior unchanged: no rows -> defaults, fail-open', () => {
  const { pab, tech } = resolveSystemBonuses([], FX);
  assert.equal(pab.amountPHP, 5000);
  assert.equal(tech.amountPHP, 1850);
  assert.equal(isDeptEligible(pab, 'anything'), true);
  assert.equal(isDeptEligible(pab, null), true);
  assert.equal(systemBonusAmountForDept(pab, null), 5000);
});

test('validation: custom rows need a label and at least one department', () => {
  const base = { code: 'pab:x-f6', amount: 10, currency: 'USD' as const };
  assert.equal(validateSystemBonus({ ...base, label: '', departmentKeys: ['devs'] }).ok, false);
  assert.equal(validateSystemBonus({ ...base, label: 'X', departmentKeys: [] }).ok, false);
  assert.equal(validateSystemBonus({ ...base, label: 'X', departmentKeys: ['devs'] }).ok, true);
  // Built-ins keep the looser rules (empty allowlist allowed = applies to all).
  assert.equal(
    validateSystemBonus({ code: 'pab', label: 'PAB', amount: 5000, currency: 'PHP', departmentKeys: [] }).ok,
    true,
  );
  // Unknown/malformed codes are rejected.
  assert.equal(
    validateSystemBonus({ code: 'bogus', label: 'X', amount: 1, currency: 'PHP', departmentKeys: [] }).ok,
    false,
  );
  assert.equal(
    validateSystemBonus({ code: 'pab:Bad Slug!', label: 'X', amount: 1, currency: 'PHP', departmentKeys: ['devs'] }).ok,
    false,
  );
});
