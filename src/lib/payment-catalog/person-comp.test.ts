import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePersonComp,
  parseRateText,
  resolveRosterDeptKey,
  winningRate,
  type PersonCompIndexes,
} from './person-comp';
import { resolveSystemBonuses, type SystemBonus } from './system-bonus';
import type { PayStructure } from './pay-structure';
import type { BonusAssignment } from '@/lib/bonus-catalog/types';

// These pin the rate precedence the payroll engine implements (current-pay.ts).
// The Certificate of Engagement prints whatever winningRate() returns, so a
// regression here would put a wrong rate on a document sent to a bank.

const FX = { usdToPhp: 56, usdToCop: 4000 };

function empStruct(email: string, over: Partial<PayStructure> = {}): PayStructure {
  return {
    id: `emp-${email}`,
    scope: 'employee',
    departmentKey: 'sales_assistant',
    employeeEmail: email,
    regularRate: 300,
    currency: 'PHP',
    ...over,
  };
}

function deptStruct(key: string, over: Partial<PayStructure> = {}): PayStructure {
  return {
    id: `dept-${key}`,
    scope: 'department',
    departmentKey: key,
    regularRate: 150,
    currency: 'PHP',
    ...over,
  };
}

function indexes(over: Partial<PersonCompIndexes> = {}): PersonCompIndexes {
  return {
    structByEmail: new Map(),
    deptStructByKey: new Map(),
    sheetRateByEmail: new Map(),
    resolvedSystem: resolveSystemBonuses([], FX),
    systemBonuses: [],
    assignments: [],
    customDepartments: [],
    ...over,
  };
}

const SUBJECT = {
  email: 'juan@simple.biz',
  aliases: ['juan@simple.biz', 'juan.personal@gmail.com'],
  department: 'Sales Assistant',
};

test('an employee-scope catalog structure outranks both the sheet and the dept base', () => {
  const comp = computePersonComp(
    SUBJECT,
    indexes({
      structByEmail: new Map([['juan@simple.biz', empStruct('juan@simple.biz')]]),
      sheetRateByEmail: new Map([['juan@simple.biz', { reg: 225, ot: 337.5 }]]),
      deptStructByKey: new Map([['sales_assistant', deptStruct('sales_assistant')]]),
    }),
  );
  assert.equal(comp.rateSource, 'individual');
  assert.equal(winningRate(comp)?.regular, 300);
});

test('the sheet rate wins over the department base', () => {
  const comp = computePersonComp(
    SUBJECT,
    indexes({
      sheetRateByEmail: new Map([['juan@simple.biz', { reg: 225, ot: 337.5 }]]),
      deptStructByKey: new Map([['sales_assistant', deptStruct('sales_assistant')]]),
    }),
  );
  assert.equal(comp.rateSource, 'sheet');
  const rate = winningRate(comp);
  assert.equal(rate?.regular, 225);
  assert.equal(rate?.ot, 337.5);
  assert.equal(rate?.currency, 'PHP', 'the rates sheet is PHP by construction');
});

test('the department base applies only when there is no sheet row at all', () => {
  const comp = computePersonComp(
    SUBJECT,
    indexes({ deptStructByKey: new Map([['sales_assistant', deptStruct('sales_assistant')]]) }),
  );
  assert.equal(comp.rateSource, 'department');
  assert.equal(winningRate(comp)?.regular, 150);
});

test('no rate anywhere yields null — the COE must refuse rather than print a blank', () => {
  const comp = computePersonComp(SUBJECT, indexes());
  assert.equal(comp.rateSource, 'none');
  assert.equal(winningRate(comp), null);
});

test('a zero sheet rate is reported as present, mirroring the engine', () => {
  // US / externally-paid people carry a 0 rates-sheet row. computePersonComp
  // must keep matching the engine here (0 is a value, not an absence); the
  // Certificate of Engagement applies the stricter "> 0" rule itself so it never
  // prints "an hourly rate of PHP 0.00". Pinning this stops someone "fixing" it
  // in the shared resolver and silently changing payroll behaviour.
  const comp = computePersonComp(
    SUBJECT,
    indexes({ sheetRateByEmail: new Map([['juan@simple.biz', { reg: 0, ot: 0 }]]) }),
  );
  assert.equal(comp.rateSource, 'sheet');
  assert.equal(winningRate(comp)?.regular, 0);
});

test('a structure keyed on the personal-email alias is still found', () => {
  const comp = computePersonComp(
    SUBJECT,
    indexes({
      structByEmail: new Map([
        ['juan.personal@gmail.com', empStruct('juan.personal@gmail.com', { regularRate: 275 })],
      ]),
    }),
  );
  assert.equal(comp.rateSource, 'individual');
  assert.equal(winningRate(comp)?.regular, 275);
});

test('a non-PHP employee structure keeps its native currency', () => {
  const comp = computePersonComp(
    SUBJECT,
    indexes({
      structByEmail: new Map([
        ['juan@simple.biz', empStruct('juan@simple.biz', { regularRate: 4, currency: 'USD', otRate: 6 })],
      ]),
    }),
  );
  const rate = winningRate(comp);
  assert.equal(rate?.currency, 'USD');
  assert.equal(rate?.regular, 4);
  assert.equal(rate?.ot, 6);
});

test('a COP system-bonus variant reports its native amount, not the PHP equivalent', () => {
  const rows: SystemBonus[] = [
    {
      code: 'pab',
      label: 'Perfect Attendance Bonus',
      amount: 5000,
      currency: 'PHP',
      enabled: true,
      departmentKeys: ['sales_assistant'],
    },
    {
      code: 'pab:colombia-x1',
      label: 'Perfect Attendance Bonus (COP)',
      amount: 320_000,
      currency: 'COP',
      enabled: true,
      departmentKeys: ['sales_assistant'],
    },
  ];
  const comp = computePersonComp(SUBJECT, indexes({
    resolvedSystem: resolveSystemBonuses(rows, FX),
    systemBonuses: rows,
  }));
  const pab = comp.systemRows.find((r) => r.code.startsWith('pab'));
  assert.equal(pab?.currency, 'COP');
  assert.equal(pab?.amount, 320_000, 'native COP amount, not amountPHP');
});

test('a department the bonus allowlist excludes gets no line at all', () => {
  const rows: SystemBonus[] = [
    {
      code: 'tech',
      label: 'Technology Bonus',
      amount: 1850,
      currency: 'PHP',
      enabled: true,
      departmentKeys: ['devs'], // Sales Assistant is not on the list
    },
  ];
  const comp = computePersonComp(SUBJECT, indexes({
    resolvedSystem: resolveSystemBonuses(rows, FX),
    systemBonuses: rows,
  }));
  assert.equal(
    comp.systemRows.find((r) => r.code.startsWith('tech')),
    undefined,
    'the certificate must not promise a bonus the engine will not pay',
  );
});

test('a department-wide bonus this person is excluded from is flagged excluded', () => {
  const assignments: BonusAssignment[] = [
    {
      id: 'a1',
      bonusId: 'b1',
      scope: 'department',
      departmentKey: 'sales_assistant',
      excludedEmails: ['juan@simple.biz'],
    },
    {
      id: 'a2',
      bonusId: 'b2',
      scope: 'department',
      departmentKey: 'sales_assistant',
    },
  ];
  const comp = computePersonComp(SUBJECT, indexes({ assignments }));
  assert.equal(comp.commonAssignments.length, 2);
  assert.equal(comp.commonAssignments.find((c) => c.assignment.id === 'a1')?.excluded, true);
  assert.equal(comp.commonAssignments.find((c) => c.assignment.id === 'a2')?.excluded, false);
});

// ── HSL sub-department base rates ──────────────────────────────────────────
// The comp card's contract is that it states what the ENGINE will pay
// (resolveDeptCatalogRate). That resolver reads an `hsl:<sub>` structure before
// collapsing the label to `hogan_smith_law`, so this card must too.

const HSL_SUBJECT = {
  email: 'agent@simple.biz',
  aliases: ['agent@simple.biz'],
  department: 'hsl:intake_specialist',
};

test('a sub-team labeled person resolves their OWN sub-department base, not the parent', () => {
  const comp = computePersonComp(
    HSL_SUBJECT,
    indexes({
      deptStructByKey: new Map([
        ['hogan_smith_law', deptStruct('hogan_smith_law', { regularRate: 225, otRate: 337.5 })],
        ['hsl:intake_specialist', deptStruct('hsl:intake_specialist', { regularRate: 260, otRate: 390 })],
      ]),
    }),
  );
  assert.equal(comp.rateSource, 'department');
  assert.equal(winningRate(comp)?.regular, 260);
  assert.equal(winningRate(comp)?.ot, 390);
});

test('a sub-team with no structure of its own falls back to the parent HSL base', () => {
  const comp = computePersonComp(
    { ...HSL_SUBJECT, department: 'hsl:collections' },
    indexes({
      deptStructByKey: new Map([
        ['hogan_smith_law', deptStruct('hogan_smith_law', { regularRate: 225 })],
        ['hsl:intake_specialist', deptStruct('hsl:intake_specialist', { regularRate: 260 })],
      ]),
    }),
  );
  assert.equal(comp.rateSource, 'department');
  assert.equal(winningRate(comp)?.regular, 225, 'parent fallback — never ₱0 and never a sibling rate');
});

test('a plain-HSL label keeps resolving the parent base even when sub rates exist', () => {
  const comp = computePersonComp(
    { ...HSL_SUBJECT, department: 'HSL' },
    indexes({
      deptStructByKey: new Map([
        ['hogan_smith_law', deptStruct('hogan_smith_law', { regularRate: 225 })],
        ['hsl:intake_specialist', deptStruct('hsl:intake_specialist', { regularRate: 260 })],
      ]),
    }),
  );
  assert.equal(winningRate(comp)?.regular, 225);
});

test('a sheet rate still outranks a sub-department base', () => {
  const comp = computePersonComp(
    HSL_SUBJECT,
    indexes({
      sheetRateByEmail: new Map([['agent@simple.biz', { reg: 240, ot: 360 }]]),
      deptStructByKey: new Map([
        ['hsl:intake_specialist', deptStruct('hsl:intake_specialist', { regularRate: 260 })],
      ]),
    }),
  );
  assert.equal(comp.rateSource, 'sheet');
  assert.equal(winningRate(comp)?.regular, 240);
});

test('a sub-team person keeps PARENT-keyed department bonuses', () => {
  // HSL dept-scoped bonus assignments live on `hogan_smith_law`. Resolving the
  // sub-team rate must not re-key bonus matching, or every HSL common bonus
  // would stop reaching the sub-labeled people.
  const assignments: BonusAssignment[] = [
    { id: 'a1', bonusId: 'b1', scope: 'department', departmentKey: 'hogan_smith_law' },
  ];
  const comp = computePersonComp(HSL_SUBJECT, indexes({ assignments }));
  assert.equal(comp.commonAssignments.length, 1);
  assert.equal(comp.commonAssignments[0]?.assignment.departmentKey, 'hogan_smith_law');
});

test('resolveRosterDeptKey maps a label, then a custom department, then slugifies', () => {
  assert.equal(resolveRosterDeptKey('Custom Team', [{ key: 'ct_key', name: 'Custom Team' }]), 'ct_key');
  assert.equal(resolveRosterDeptKey('   ', []), null);
  assert.equal(resolveRosterDeptKey('Brand New Dept', []), 'brand_new_dept');
});

test('parseRateText handles sheet text, thousands separators and blanks', () => {
  assert.equal(parseRateText('1,234.50'), 1234.5);
  assert.equal(parseRateText('225'), 225);
  assert.equal(parseRateText(''), null);
  assert.equal(parseRateText(null), null);
  assert.equal(parseRateText('not a number'), null);
});
