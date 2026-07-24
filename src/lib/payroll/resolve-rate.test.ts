/**
 * Department catalog-rate resolution — especially the in-app department slug
 * fallback ("Executive Assistants" -> "executive_assistants"), which keeps
 * Payroll Readiness / People / live dispatch resolving a custom department's
 * base rate exactly like a built-in one.
 *
 * Run:  npx tsx --test src/lib/payroll/resolve-rate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCatalogRateIndex,
  resolveDeptCatalogRate,
  resolveEmployeeCatalogRate,
} from './resolve-rate';
import type { PayStructure } from '@/lib/payment-catalog/pay-structure';

const FX = { usdToPhp: 58, usdToCop: 4000 };

const STRUCTURES: PayStructure[] = [
  {
    id: 'pay_dept_builtin',
    scope: 'department',
    departmentKey: 'accounting',
    regularRate: 150,
    otRate: 225,
    currency: 'PHP',
  },
  {
    id: 'pay_dept_custom',
    scope: 'department',
    departmentKey: 'executive_assistants',
    regularRate: 325,
    otRate: 487.5,
    currency: 'PHP',
  },
  {
    id: 'pay_emp',
    scope: 'employee',
    departmentKey: 'executive_assistants',
    employeeEmail: 'ellyt@simple.biz',
    regularRate: 425,
    otRate: 637.5,
    currency: 'PHP',
  },
];

const index = buildCatalogRateIndex(STRUCTURES);

test('built-in departments resolve via the alias map', () => {
  const viaName = resolveDeptCatalogRate(index, 'Accounting Team', FX);
  assert.equal(viaName?.regNative, 150);
  const viaKey = resolveDeptCatalogRate(index, 'accounting', FX);
  assert.equal(viaKey?.regNative, 150);
});

test('in-app department labels resolve via the slug fallback', () => {
  const r = resolveDeptCatalogRate(index, 'Executive Assistants', FX);
  assert.equal(r?.regNative, 325);
  assert.equal(r?.otNative, 487.5);
  assert.equal(r?.source, 'department');
  // Already-canonical slug keys keep working too.
  assert.equal(resolveDeptCatalogRate(index, 'executive_assistants', FX)?.regNative, 325);
});

test('unknown departments still resolve to null', () => {
  assert.equal(resolveDeptCatalogRate(index, 'No Such Team', FX), null);
  assert.equal(resolveDeptCatalogRate(index, null, FX), null);
  assert.equal(resolveDeptCatalogRate(index, '  ', FX), null);
});

test('employee scope still wins ahead of the department base (caller chain)', () => {
  const emp = resolveEmployeeCatalogRate(index, ['ellyt@simple.biz'], FX);
  assert.equal(emp?.regNative, 425);
  const dept = resolveDeptCatalogRate(index, 'Executive Assistants', FX);
  assert.equal((emp ?? dept)?.regNative, 425);
});
