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
  resolveDeptLabelForRate,
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

// ── resolveDeptLabelForRate — the HARD HOLD release (2026-08-14) ─────────────
//
// Both payout engines preferred the `employee_hourly_rates."Department"` label
// over the master cell. For HSL that label is hardcoded to "Hogan Smith Law" by
// the rates mirror, which buried the sub-team and made every `hsl:*` base rate
// unreachable. These pin the NARROW fix and, just as importantly, the blast
// radius it deliberately refuses to take on.

test('an HSL master cell beats the flattened rates-row label — the whole point of the release', () => {
  // This is the case the mirror breaks: master names the sub-team, the rates row
  // can only ever say the parent.
  assert.equal(
    resolveDeptLabelForRate('hsl:intake_specialist', 'Hogan Smith Law'),
    'hsl:intake_specialist',
  );
  assert.equal(resolveDeptLabelForRate('hsl:callback_team', 'Hogan Smith Law'), 'hsl:callback_team');
  // A plain family cell is still HSL-family and still wins — it just resolves
  // the parent, which is the correct answer for an unplaced person.
  assert.equal(resolveDeptLabelForRate('HSL', 'Hogan Smith Law'), 'HSL');
});

test('a NON-HSL master label never displaces the rates-row label', () => {
  // Measured regression, 2026-08-14: flipping to master-first for EVERYONE moved
  // carla@ from a ₱175 Lead Gen base to NO base, because her master cell says
  // USEE and USEE has no rate row. The rule states the actual defect (the HSL
  // mirror) rather than a superset of it, so that population is untouched.
  assert.equal(resolveDeptLabelForRate('USEE', 'Lead Gen'), 'Lead Gen');
  assert.equal(resolveDeptLabelForRate('Sales', 'Sales Assistant'), 'Sales Assistant');
  assert.equal(resolveDeptLabelForRate('Client VA', 'PM Team'), 'PM Team');
});

test('resolveDeptLabelForRate falls back rather than returning nothing', () => {
  assert.equal(resolveDeptLabelForRate(null, 'Lead Gen'), 'Lead Gen');
  assert.equal(resolveDeptLabelForRate('Lead Gen', null), 'Lead Gen');
  assert.equal(resolveDeptLabelForRate('  ', '  '), null);
  assert.equal(resolveDeptLabelForRate(null, null), null);
  // An HSL master cell with no rates row at all still resolves the sub-team.
  assert.equal(resolveDeptLabelForRate('hsl:collections', null), 'hsl:collections');
});

test('the release makes a sub-team base reachable that the mirror had buried', () => {
  const cutoverStructures: PayStructure[] = [
    { id: 'p', scope: 'department', departmentKey: 'hogan_smith_law', regularRate: 225, otRate: 337.5, currency: 'PHP' },
    { id: 's', scope: 'department', departmentKey: 'hsl:case_managers', regularRate: 305, otRate: 457.5, currency: 'PHP' },
  ];
  const idx = buildCatalogRateIndex(cutoverStructures);
  // BEFORE: the rates-row label wins → the parent base.
  assert.equal(resolveDeptCatalogRate(idx, 'Hogan Smith Law', FX)?.regNative, 225);
  // AFTER: the master cell wins → the sub-team base.
  assert.equal(
    resolveDeptCatalogRate(idx, resolveDeptLabelForRate('hsl:case_managers', 'Hogan Smith Law'), FX)?.regNative,
    305,
  );
});
