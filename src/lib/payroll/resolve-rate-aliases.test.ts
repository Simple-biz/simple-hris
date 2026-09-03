/**
 * A RENAMED in-app department keeps its key (slug of the ORIGINAL name). The
 * catalog rate index must therefore resolve the department base for a cell that
 * carries the NEW label too — otherwise the rename silently strips the base
 * rate from anyone placed under it (Edit Department, 2026-09-03).
 *
 * Run:  npx tsx --test src/lib/payroll/resolve-rate-aliases.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogRateIndex, resolveDeptCatalogRate } from './resolve-rate';
import type { PayStructure } from '@/lib/payment-catalog/pay-structure';
import type { DepartmentRegistryEntry } from '@/lib/departments/registry';

const FX = { usdToPhp: 58, usdToCop: 4000 };

const STRUCTURES: PayStructure[] = [
  { id: 'd1', scope: 'department', departmentKey: 'executive_assistants', regularRate: 325, otRate: 487.5, currency: 'PHP' },
  { id: 'd2', scope: 'department', departmentKey: 'accounting', regularRate: 150, otRate: 225, currency: 'PHP' },
];

const renamed: DepartmentRegistryEntry = {
  key: 'executive_assistants',
  name: 'EA Team',
  previousNames: ['Executive Assistants'],
  subDepartments: [],
  members: [],
  createdBy: null,
  createdAt: '2026-07-24T00:00:00.000Z',
};

test('without the registry, only the ORIGINAL label reaches the base (the pre-rename behaviour)', () => {
  const index = buildCatalogRateIndex(STRUCTURES);
  assert.equal(resolveDeptCatalogRate(index, 'Executive Assistants', FX)?.regNative, 325);
  assert.equal(resolveDeptCatalogRate(index, 'EA Team', FX), null);
  assert.equal(index.aliasKeys, undefined);
});

test('with the registry, the NEW label resolves the same base — and the old one still does', () => {
  const index = buildCatalogRateIndex(STRUCTURES, [renamed]);
  assert.equal(resolveDeptCatalogRate(index, 'EA Team', FX)?.regNative, 325);
  assert.equal(resolveDeptCatalogRate(index, 'ea team', FX)?.regNative, 325);
  assert.equal(resolveDeptCatalogRate(index, 'Executive Assistants', FX)?.regNative, 325);
  assert.equal(resolveDeptCatalogRate(index, 'executive_assistants', FX)?.regNative, 325);
});

test('aliases never displace a built-in or an existing structure key', () => {
  const shady: DepartmentRegistryEntry = { ...renamed, previousNames: ['Accounting'] };
  const index = buildCatalogRateIndex(STRUCTURES, [shady]);
  // The alias map skipped "accounting"; the built-in still resolves its own row.
  assert.equal(resolveDeptCatalogRate(index, 'Accounting', FX)?.regNative, 150);
  // byDeptKey is untouched — aliases live in their own map.
  assert.equal(index.byDeptKey.size, 2);
});

test('an unrenamed registry department adds no aliases', () => {
  const plain: DepartmentRegistryEntry = { ...renamed, name: 'Executive Assistants', previousNames: undefined };
  const index = buildCatalogRateIndex(STRUCTURES, [plain]);
  assert.equal(index.aliasKeys, undefined);
});
