import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumKpiTotalsByEmail, planKpiScoredInserts } from './kpi-scored';

// The re-notify policy IS these two pure functions — the route wiring only
// feeds them. If a change here makes drafts audible or corrections silent,
// that's the regression Kane's 2026-08-17 ruling forbids.

test('sumKpiTotalsByEmail merges both stores by normalized email', () => {
  const totals = sumKpiTotalsByEmail(
    [
      { employee_email: 'Ana@Simple.biz ', amount: 100 },
      { employee_email: 'ana@simple.biz', amount: '1,250.50' },
      { employee_email: null, amount: 999 }, // no email → dropped
    ],
    [
      { employee_email: 'ana@simple.biz', calculated_bonus: 49.5 },
      { employee_email: 'ben@simple.biz', calculated_bonus: '300' },
    ],
  );
  assert.equal(totals.get('ana@simple.biz'), 1400);
  assert.equal(totals.get('ben@simple.biz'), 300);
  assert.equal(totals.size, 2);
});

test('sumKpiTotalsByEmail rounds to cents', () => {
  const totals = sumKpiTotalsByEmail(
    [
      { employee_email: 'a@x.com', amount: 0.1 },
      { employee_email: 'a@x.com', amount: 0.2 },
    ],
    [],
  );
  assert.equal(totals.get('a@x.com'), 0.3);
});

test('first-time zero totals are never announced', () => {
  const plan = planKpiScoredInserts(new Map([['a@x.com', 0]]), new Map());
  assert.deepEqual(plan, []);
});

test('first-time non-zero total notifies with previousAmount null', () => {
  const plan = planKpiScoredInserts(new Map([['a@x.com', 2650]]), new Map());
  assert.deepEqual(plan, [{ recipientEmail: 'a@x.com', amount: 2650, previousAmount: null }]);
});

test('unchanged total is silent (autosave no-op on a published week)', () => {
  const plan = planKpiScoredInserts(
    new Map([['a@x.com', 2650]]),
    new Map([['a@x.com', 2650]]),
  );
  assert.deepEqual(plan, []);
});

test('changed total re-notifies and carries the previous amount', () => {
  const plan = planKpiScoredInserts(
    new Map([['a@x.com', 3150]]),
    new Map([['a@x.com', 2650]]),
  );
  assert.deepEqual(plan, [{ recipientEmail: 'a@x.com', amount: 3150, previousAmount: 2650 }]);
});

test('a drop — including to zero — still notifies', () => {
  const plan = planKpiScoredInserts(
    new Map([['a@x.com', 0]]),
    new Map([['a@x.com', 500]]),
  );
  assert.deepEqual(plan, [{ recipientEmail: 'a@x.com', amount: 0, previousAmount: 500 }]);
});

test('rows removed entirely (absent from totals) notify as a drop to zero', () => {
  const plan = planKpiScoredInserts(new Map(), new Map([['a@x.com', 500]]));
  assert.deepEqual(plan, [{ recipientEmail: 'a@x.com', amount: 0, previousAmount: 500 }]);
});

test('previously-notified-zero absent rows stay silent', () => {
  // Their last notification already said ₱0 — vanishing rows change nothing.
  const plan = planKpiScoredInserts(new Map(), new Map([['a@x.com', 0]]));
  assert.deepEqual(plan, []);
});

test('cent-level float noise does not read as a change', () => {
  const plan = planKpiScoredInserts(
    new Map([['a@x.com', 0.30000000000000004]]),
    new Map([['a@x.com', 0.3]]),
  );
  assert.deepEqual(plan, []);
});

test('mixed cohort: new, unchanged, and corrected people are each handled', () => {
  const plan = planKpiScoredInserts(
    new Map([
      ['new@x.com', 1000],
      ['same@x.com', 2000],
      ['fixed@x.com', 2500],
    ]),
    new Map([
      ['same@x.com', 2000],
      ['fixed@x.com', 1500],
    ]),
  );
  assert.deepEqual(plan, [
    { recipientEmail: 'new@x.com', amount: 1000, previousAmount: null },
    { recipientEmail: 'fixed@x.com', amount: 2500, previousAmount: 1500 },
  ]);
});
