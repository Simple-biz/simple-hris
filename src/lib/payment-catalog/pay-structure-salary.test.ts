import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { formatSalary, payBasisOf, validatePayStructure, type PayStructure } from './pay-structure';

// docs/features/salaried-pay-basis.md — the write-side rules for a salary structure.

const SALARY: PayStructure = {
  id: 'pay_x',
  scope: 'employee',
  departmentKey: 'lead_gen',
  employeeEmail: 'ana@simple.biz',
  regularRate: 0,
  currency: 'PHP',
  payBasis: 'salary',
  salaryPeriod: 'week',
  salaryAmount: 25000,
};

test('a weekly PHP or USD employee salary with no hourly figures is valid', () => {
  assert.deepEqual(validatePayStructure(SALARY), { ok: true });
  assert.deepEqual(validatePayStructure({ ...SALARY, currency: 'USD', salaryAmount: 500 }), { ok: true });
});

test('a DEPARTMENT salary is refused — a salary is a fact about a person (ruling §2)', () => {
  const r = validatePayStructure({ ...SALARY, scope: 'department', employeeEmail: undefined });
  assert.equal(r.ok, false);
});

test('a daily or monthly salary is refused until the pay-run ruling exists (NEEDS 1/2)', () => {
  assert.equal(validatePayStructure({ ...SALARY, salaryPeriod: 'month' }).ok, false);
  assert.equal(validatePayStructure({ ...SALARY, salaryPeriod: 'day' }).ok, false);
});

test('a COP salary is refused (the write path stores COP as PHP, §5.7)', () => {
  assert.equal(validatePayStructure({ ...SALARY, currency: 'COP' }).ok, false);
});

test('a salary carrying an hourly or OT rate is refused — untaught readers must price ₱0', () => {
  assert.equal(validatePayStructure({ ...SALARY, regularRate: 175 }).ok, false);
  assert.equal(validatePayStructure({ ...SALARY, otRate: 262.5 }).ok, false);
});

test('a salary with no or a negative amount is refused', () => {
  assert.equal(validatePayStructure({ ...SALARY, salaryAmount: undefined }).ok, false);
  assert.equal(validatePayStructure({ ...SALARY, salaryAmount: -1 }).ok, false);
});

test('an hourly structure carrying salary figures is refused; a plain hourly one is unchanged', () => {
  const hourly: PayStructure = { id: 'p', scope: 'employee', departmentKey: 'lead_gen', employeeEmail: 'a@x.com', regularRate: 175, currency: 'PHP' };
  assert.deepEqual(validatePayStructure(hourly), { ok: true });
  assert.equal(validatePayStructure({ ...hourly, salaryAmount: 1 }).ok, false);
  assert.equal(validatePayStructure({ ...hourly, payBasis: 'hourly', salaryPeriod: 'week' }).ok, false);
});

test('payBasisOf reads a pre-migration row as hourly; formatSalary never says /hr', () => {
  assert.equal(payBasisOf({}), 'hourly');
  assert.equal(payBasisOf({ payBasis: 'salary' }), 'salary');
  assert.equal(formatSalary(25000, 'week', 'PHP'), '₱25,000.00/wk');
  assert.equal(formatSalary(500, 'week', 'USD'), '$500.00/wk');
});
