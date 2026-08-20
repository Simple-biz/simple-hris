import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumKpiTotalsByEmail, planKpiScoredInserts, isWithinCurrentPayCycle } from './kpi-scored';

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

// ── The period floor (Kane 2026-08-20: the CURRENT pay cycle only) ────────────
// A SEPARATE gate from the amount diff. Without it there was no lower bound at
// all: 181 ready/locked dept-weeks reach back to 2026-03-01 with zero prior
// kpi.scored rows, so every person in all of them read as owed a notification.
// The floor is payrollNotesWeekStart() — the just-completed Sun-Sat week.

test('floor: the week being paid still notifies', () => {
  // 2026-08-09..15 was the newest ready week when the floor shipped, and
  // payrollNotesWeekStart() resolved to 2026-08-09 that day.
  assert.equal(isWithinCurrentPayCycle('2026-08-09', '2026-08-15', '2026-08-09'), true);
});

test('floor: a week still in progress notifies (it sorts after the floor)', () => {
  assert.equal(isWithinCurrentPayCycle('2026-08-16', '2026-08-22', '2026-08-09'), true);
});

test('floor: the week before the one being paid goes silent', () => {
  assert.equal(isWithinCurrentPayCycle('2026-08-02', '2026-08-08', '2026-08-09'), false);
});

test('floor: a five-month-old week goes silent — the flood this exists to stop', () => {
  assert.equal(isWithinCurrentPayCycle('2026-03-01', '2026-03-07', '2026-08-09'), false);
});

test('floor keys on period_END so a CURRENT monthly period is not silenced', () => {
  // 4 of the 187 live periods are 30-31 day monthly (pre-cutover HSL). A
  // period_START floor would wrongly silence this one: 2026-08-01 < 2026-08-09.
  assert.equal(isWithinCurrentPayCycle('2026-08-01', '2026-08-31', '2026-08-09'), true);
  // ...and the same window a month earlier is still correctly silent.
  assert.equal(isWithinCurrentPayCycle('2026-07-01', '2026-07-31', '2026-08-09'), false);
});

test('floor falls back to period_start when period_end is absent or blank', () => {
  assert.equal(isWithinCurrentPayCycle('2026-08-16', null, '2026-08-09'), true);
  assert.equal(isWithinCurrentPayCycle('2026-03-01', null, '2026-08-09'), false);
  assert.equal(isWithinCurrentPayCycle('2026-08-16', '   ', '2026-08-09'), true);
});

test('floor never passes on a period it cannot date', () => {
  // Both keys empty: no basis to claim it is current, so it does not notify.
  assert.equal(isWithinCurrentPayCycle('', null, '2026-08-09'), false);
});

test('floor does NOT touch the amount-diff rule', () => {
  // The re-notify ruling must survive the floor: within the cycle, a corrected
  // amount still re-announces, and an unchanged one is still silent.
  const plan = planKpiScoredInserts(
    new Map([['a@x.com', 2500], ['b@x.com', 1000]]),
    new Map([['a@x.com', 1500], ['b@x.com', 1000]]),
  );
  // cents() rounds to 2dp in PESOS — it does not convert to integer cents.
  assert.deepEqual(plan, [{ recipientEmail: 'a@x.com', amount: 2500, previousAmount: 1500 }]);
});
