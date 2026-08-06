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
  {
    id: 'pay_dept_hsl_parent',
    scope: 'department',
    departmentKey: 'hogan_smith_law',
    regularRate: 100,
    otRate: 150,
    currency: 'PHP',
  },
  {
    id: 'pay_dept_hsl_intake',
    scope: 'department',
    departmentKey: 'hsl:intake_specialist',
    regularRate: 140,
    otRate: 155,
    currency: 'PHP',
  },
  {
    id: 'pay_dept_custom_sub',
    scope: 'department',
    departmentKey: 'medical_billing:intake_team',
    regularRate: 210,
    otRate: 315,
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

// ── Sub-department base rates (namespaced keys, 2026-08) ────────────────────
// A department with sub-departments carries its base rates ON the subs:
// `hsl:<sub>` for the built-in HSL teams, `<parentKey>:<subKey>` for in-app
// departments created with sub-departments. The namespaced lookup must win
// BEFORE normalizeDeptToKey collapses hsl:* to the parent bucket.

test('an hsl:<sub> label resolves its OWN base rate ahead of the parent', () => {
  const r = resolveDeptCatalogRate(index, 'hsl:intake_specialist', FX);
  assert.equal(r?.regNative, 140);
  assert.equal(r?.otNative, 155);
  // Sloppy casing/whitespace still hits the same structure.
  assert.equal(resolveDeptCatalogRate(index, '  HSL:Intake_Specialist ', FX)?.regNative, 140);
});

test('sub-team labels without their own structure fall back to the parent HSL base', () => {
  assert.equal(resolveDeptCatalogRate(index, 'hsl:collections', FX)?.regNative, 100);
});

test('plain HSL labels still resolve the parent base', () => {
  assert.equal(resolveDeptCatalogRate(index, 'HSL', FX)?.regNative, 100);
  assert.equal(resolveDeptCatalogRate(index, 'Hogan Smith Law', FX)?.regNative, 100);
});

test('with the parent base removed, sub rows still resolve and plain HSL is null', () => {
  const noParent = buildCatalogRateIndex(STRUCTURES.filter((s) => s.id !== 'pay_dept_hsl_parent'));
  assert.equal(resolveDeptCatalogRate(noParent, 'hsl:intake_specialist', FX)?.regNative, 140);
  assert.equal(resolveDeptCatalogRate(noParent, 'HSL', FX), null);
});

test('in-app sub-department keys resolve their own base rate', () => {
  const r = resolveDeptCatalogRate(index, 'medical_billing:intake_team', FX);
  assert.equal(r?.regNative, 210);
  assert.equal(r?.source, 'department');
  // The parent label keeps resolving nothing here (no parent structure) —
  // sub rates never leak onto the parent key.
  assert.equal(resolveDeptCatalogRate(index, 'Medical Billing', FX), null);
});
