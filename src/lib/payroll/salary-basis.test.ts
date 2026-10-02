import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildSalaryHistoryByEmail,
  isPayWeekSunday,
  nextSundayIso,
  priceSalaryWeek,
  resolveSalaryBasis,
  resolveSalaryWeek,
  salaryRowsForEmails,
  structureBasisClaim,
  type ResolveSalaryBasisInput,
  type StructureBasisClaim,
} from './salary-basis';
import type { PayStructure } from '@/lib/payment-catalog/pay-structure';

const FX = { usdToPhp: 58, usdToCop: 4000 };
// Pay week Sun 2026-10-04 → Sat 2026-10-10.
const WEEK = { weekStart: new Date(2026, 9, 4), weekEnd: new Date(2026, 9, 10) };

function row(effective: string, basis: 'hourly' | 'salary', amount?: number, extra: Record<string, unknown> = {}) {
  return {
    employee_email: 'Ana@Simple.biz',
    effective_from: effective,
    pay_basis: basis,
    salary_period: basis === 'salary' ? 'week' : null,
    salary_amount: basis === 'salary' ? amount ?? 25000 : null,
    currency: 'PHP',
    created_at: `${effective}T00:00:00Z`,
    ...extra,
  };
}

const SALARY_25K: StructureBasisClaim = { kind: 'salary', period: 'week', amount: 25000, currency: 'PHP' };

function resolve(raw: ReturnType<typeof row>[], over: Partial<ResolveSalaryBasisInput> = {}) {
  const history = buildSalaryHistoryByEmail(raw);
  return resolveSalaryBasis({
    rows: salaryRowsForEmails(history, ['ana@simple.biz']),
    historyState: 'loaded',
    structure: SALARY_25K,
    ...WEEK,
    ...over,
  });
}

test('a weekly salary in force on the week start pays the flat amount', () => {
  const b = resolve([row('2026-09-27', 'salary')]);
  assert.equal(b.kind, 'salary');
  if (b.kind !== 'salary') return;
  assert.equal(b.amount, 25000);
  assert.equal(b.effectiveFrom, '2026-09-27');
  const priced = priceSalaryWeek(b, FX);
  assert.deepEqual(priced, {
    ok: true,
    amountPhp: 25000,
    amountNative: 25000,
    currency: 'PHP',
    period: 'week',
    effectiveFrom: '2026-09-27',
  });
});

test('a salary effective exactly on the week start is a whole week, not a mid-week change', () => {
  assert.equal(resolve([row('2026-10-04', 'salary')]).kind, 'salary');
});

test('nobody with no history and no salary structure is ever salaried', () => {
  assert.deepEqual(resolve([], { structure: { kind: 'hourly' } }), { kind: 'hourly' });
  assert.deepEqual(resolve([], { structure: { kind: 'none' } }), { kind: 'hourly' });
});

test('a salary that starts next week leaves this week hourly', () => {
  assert.deepEqual(resolve([row('2026-10-11', 'salary')]), { kind: 'hourly' });
});

test('a switch back to hourly on the week start ends the salary', () => {
  const b = resolve([row('2026-09-06', 'salary'), row('2026-10-04', 'hourly')], { structure: { kind: 'hourly' } });
  assert.deepEqual(b, { kind: 'hourly' });
});

test('a scheduled switch to hourly next week still pays this week as salary', () => {
  const b = resolve([row('2026-09-06', 'salary'), row('2026-10-11', 'hourly')], { structure: { kind: 'hourly' } });
  assert.equal(b.kind, 'salary');
});

test('a basis change dated INSIDE the week refuses to price', () => {
  const b = resolve([row('2026-10-07', 'salary')]);
  assert.equal(b.kind, 'unknown');
  if (b.kind === 'unknown') assert.equal(b.reason, 'changed_mid_week');
});

test('a salary raise dated inside the week refuses; the same figure re-saved mid-week does not', () => {
  const raise = resolve([row('2026-09-06', 'salary', 20000), row('2026-10-07', 'salary', 25000)]);
  assert.equal(raise.kind === 'unknown' && raise.reason, 'changed_mid_week');
  const same = resolve([row('2026-09-06', 'salary'), row('2026-10-07', 'salary')]);
  assert.equal(same.kind, 'salary');
});

test('the Pay Structure says salary but no dated row exists → refuse, never hourly (§6)', () => {
  const b = resolve([]);
  assert.equal(b.kind === 'unknown' && b.reason, 'structure_mismatch');
});

test('history says salary but the winning structure is hourly → refuse', () => {
  const b = resolve([row('2026-09-06', 'salary')], { structure: { kind: 'hourly' } });
  assert.equal(b.kind === 'unknown' && b.reason, 'structure_mismatch');
  const none = resolve([row('2026-09-06', 'salary')], { structure: { kind: 'none' } });
  assert.equal(none.kind === 'unknown' && none.reason, 'structure_mismatch');
});

test('the structure and the latest row disagree on the amount → refuse', () => {
  const b = resolve([row('2026-09-06', 'salary', 20000)]);
  assert.equal(b.kind === 'unknown' && b.reason, 'structure_mismatch');
});

test('a catalog that failed to load skips the cross-check but still reads the dated history', () => {
  const b = resolve([row('2026-09-06', 'salary')], { structure: { kind: 'unavailable' } });
  assert.equal(b.kind, 'salary');
});

test('an unreadable history holds every structure-salaried person, and only them', () => {
  const held = resolve([], { historyState: 'unavailable' });
  assert.equal(held.kind === 'unknown' && held.reason, 'history_unavailable');
  assert.deepEqual(resolve([], { historyState: 'unavailable', structure: { kind: 'hourly' } }), { kind: 'hourly' });
});

test('before the migration nobody is salaried', () => {
  assert.deepEqual(resolve([], { historyState: 'not_configured', structure: { kind: 'hourly' } }), { kind: 'hourly' });
  const contradiction = resolve([], { historyState: 'not_configured' });
  assert.equal(contradiction.kind, 'unknown');
});

test('a start date inside the week is a partial week and refuses (NEEDS 3)', () => {
  const b = resolve([row('2026-09-27', 'salary')], { startDate: new Date(2026, 9, 7) });
  assert.equal(b.kind === 'unknown' && b.reason, 'partial_week');
  // Starting ON the week start is a whole week.
  assert.equal(resolve([row('2026-09-27', 'salary')], { startDate: new Date(2026, 9, 4) }).kind, 'salary');
});

test('a last day inside the week is a partial week; a last day on the week end is not', () => {
  const b = resolve([row('2026-09-27', 'salary')], { lastDay: new Date(2026, 9, 8) });
  assert.equal(b.kind === 'unknown' && b.reason, 'partial_week');
  assert.equal(resolve([row('2026-09-27', 'salary')], { lastDay: new Date(2026, 9, 10) }).kind, 'salary');
});

test('a partial week never touches an HOURLY person', () => {
  assert.deepEqual(
    resolve([], { structure: { kind: 'hourly' }, startDate: new Date(2026, 9, 7), lastDay: new Date(2026, 9, 8) }),
    { kind: 'hourly' },
  );
});

test('a monthly or daily salary is held, not guessed (NEEDS 1/2)', () => {
  const monthly = resolve([row('2026-09-27', 'salary', 100000, { salary_period: 'month' })], {
    structure: { kind: 'salary', period: 'month', amount: 100000, currency: 'PHP' },
  });
  assert.equal(monthly.kind === 'unknown' && monthly.reason, 'period_not_priced');
});

test('a USD salary converts at the cycle FX; a missing FX refuses', () => {
  const b = resolve([row('2026-09-27', 'salary', 500, { currency: 'USD' })], {
    structure: { kind: 'salary', period: 'week', amount: 500, currency: 'USD' },
  });
  assert.equal(b.kind, 'salary');
  if (b.kind !== 'salary') return;
  const priced = priceSalaryWeek(b, FX);
  assert.equal(priced.ok && priced.amountPhp, 29000);
  const noFx = priceSalaryWeek(b, { usdToPhp: 0, usdToCop: 4000 });
  assert.equal(noFx.ok, false);
});

test('a COP salary is held (the structure write path stores COP as PHP)', () => {
  const b = resolve([row('2026-09-27', 'salary', 1000000, { currency: 'COP' })], {
    structure: { kind: 'salary', period: 'week', amount: 1000000, currency: 'COP' },
  });
  assert.equal(b.kind === 'unknown' && b.reason, 'currency_not_priced');
});

test('an unreadable history row is never read as hourly', () => {
  const b = resolve([row('2026-09-27', 'salary', 25000, { salary_amount: null })], {
    structure: { kind: 'unavailable' },
  });
  assert.equal(b.kind, 'unknown');
});

test('rows filed under another alias of the person count', () => {
  const history = buildSalaryHistoryByEmail([{ ...row('2026-09-27', 'salary'), employee_email: 'ana.personal@gmail.com' }]);
  const b = resolveSalaryBasis({
    rows: salaryRowsForEmails(history, ['ana@simple.biz', 'ana.personal@gmail.com']),
    historyState: 'loaded',
    structure: SALARY_25K,
    ...WEEK,
  });
  assert.equal(b.kind, 'salary');
});

test('two aliases with rows on the same date that disagree refuse', () => {
  const history = buildSalaryHistoryByEmail([
    row('2026-09-27', 'salary', 25000),
    { ...row('2026-09-27', 'salary', 30000), employee_email: 'ana.personal@gmail.com' },
  ]);
  const b = resolveSalaryBasis({
    rows: salaryRowsForEmails(history, ['ana@simple.biz', 'ana.personal@gmail.com']),
    historyState: 'loaded',
    structure: { kind: 'unavailable' },
    ...WEEK,
  });
  assert.equal(b.kind, 'unknown');
});

test('structureBasisClaim reads hourly, salary, and a salary missing its figures', () => {
  const base: PayStructure = { id: 'p', scope: 'employee', departmentKey: 'lead_gen', regularRate: 0, currency: 'PHP' };
  assert.deepEqual(structureBasisClaim(null), { kind: 'none' });
  assert.deepEqual(structureBasisClaim({ ...base, regularRate: 175 }), { kind: 'hourly' });
  assert.deepEqual(structureBasisClaim({ ...base, payBasis: 'salary', salaryPeriod: 'week', salaryAmount: 9000 }), {
    kind: 'salary',
    period: 'week',
    amount: 9000,
    currency: 'PHP',
  });
  // A salary flag with no amount must never match a history row (→ structure_mismatch).
  const broken = structureBasisClaim({ ...base, payBasis: 'salary', salaryPeriod: 'week' });
  assert.equal(broken.kind, 'salary');
  const b = resolve([row('2026-09-27', 'salary')], { structure: broken });
  assert.equal(b.kind === 'unknown' && b.reason, 'structure_mismatch');
});

test('offboarded with no recorded last day holds a salaried week, never an hourly one', () => {
  const b = resolve([row('2026-09-27', 'salary')], { lastDay: 'unknown' });
  assert.equal(b.kind === 'unknown' && b.reason, 'partial_week');
  assert.deepEqual(resolve([], { structure: { kind: 'hourly' }, lastDay: 'unknown' }), { kind: 'hourly' });
});

test('resolveSalaryWeek: priced, held, and an unplaceable week', () => {
  const history = buildSalaryHistoryByEmail([row('2026-09-27', 'salary')]);
  const base = {
    history,
    historyState: 'loaded' as const,
    emails: ['ana@simple.biz'],
    structure: SALARY_25K,
    week: { start: WEEK.weekStart, end: WEEK.weekEnd },
  };
  const paid = resolveSalaryWeek(base, FX);
  assert.equal(paid.kind, 'salary');
  if (paid.kind === 'salary') assert.equal(paid.pay.amountPhp, 25000);
  const held = resolveSalaryWeek({ ...base, startDate: new Date(2026, 9, 6) }, FX);
  assert.equal(held.kind === 'held' && held.reason, 'partial_week');
  const noWeek = resolveSalaryWeek({ ...base, week: null }, FX);
  assert.equal(noWeek.kind === 'held' && noWeek.reason, 'week_unknown');
  // An hourly person with no week is simply hourly.
  assert.deepEqual(
    resolveSalaryWeek({ ...base, history: new Map(), structure: { kind: 'hourly' }, week: null }, FX),
    { kind: 'hourly' },
  );
});

test('isPayWeekSunday and nextSundayIso', () => {
  assert.equal(isPayWeekSunday('2026-10-04'), true);
  assert.equal(isPayWeekSunday('2026-10-05'), false);
  assert.equal(isPayWeekSunday('2026-02-30'), false);
  assert.equal(isPayWeekSunday(''), false);
  assert.equal(nextSundayIso(new Date(2026, 9, 2)), '2026-10-04'); // Friday → Sunday
  assert.equal(nextSundayIso(new Date(2026, 9, 4)), '2026-10-11'); // Sunday → the NEXT Sunday
  assert.equal(nextSundayIso(new Date(2026, 9, 3)), '2026-10-04'); // Saturday → tomorrow
});
