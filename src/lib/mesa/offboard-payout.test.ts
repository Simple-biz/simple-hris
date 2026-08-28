import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextPayoutWeekEnd, planMesaOffboardPayout } from './offboard-payout';

// Before this existed, approving an opt-out closed the account and moved
// nothing — the balance just stopped being displayed. Each test below is money
// that used to disappear.

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

test('a balance is released, not zeroed', () => {
  // marie@, live: PHP 21,200 that closing her account would have silently hidden.
  const plan = planMesaOffboardPayout({
    email: 'marie@simple.biz',
    accountNumber: '25-06-00048',
    balance: 21200,
    closingOn: '2026-08-28',
  });
  assert.ok(plan, 'no payout planned for a positive balance');
  assert.equal(plan.obligation.amount_php, 21200);
  assert.equal(plan.obligation.kind, 'offboard_payout');
  assert.equal(plan.obligation.direction, 'credit');
  assert.equal(plan.obligation.account_number, '25-06-00048');
});

test('the reason for leaving is not an input — it cannot change the amount', () => {
  // Aliviah: "Their balance wouldn't change based on their reason for leaving."
  // harrye@ (Policy Violation) and jerryl@ (resigned) with the same balance must
  // produce the same obligation. The function takes no reason at all, which is
  // the point — there is no parameter through which a policy could leak in.
  const a = planMesaOffboardPayout({ email: 'harrye@simple.biz', accountNumber: 'X', balance: 6400, closingOn: '2026-08-28' });
  const b = planMesaOffboardPayout({ email: 'jerryl@simple.biz', accountNumber: 'X', balance: 6400, closingOn: '2026-08-28' });
  assert.equal(a?.obligation.amount_php, b?.obligation.amount_php);
});

test('a zero balance releases nothing', () => {
  // peterl@ is offboarded with PHP 0 — no obligation, not a zero-value row.
  // The table rejects amount_php = 0, and a settled-nothing must never be
  // mistakeable for a settled debt.
  assert.equal(planMesaOffboardPayout({ email: 'peterl@simple.biz', accountNumber: 'X', balance: 0, closingOn: '2026-08-28' }), null);
});

test('an OVERDRAWN account does not become a debt the member owes back', () => {
  // luckye@'s imported stint closes PHP 400 overdrawn. That is a reconciliation
  // artifact, not a claim against them — inverting it into a deduction would
  // invent money owed.
  assert.equal(planMesaOffboardPayout({ email: 'luckye@simple.biz', accountNumber: 'X', balance: -400, closingOn: '2026-08-28' }), null);
});

test('a non-finite balance releases nothing rather than a NaN obligation', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(
      planMesaOffboardPayout({ email: 'x@simple.biz', accountNumber: null, balance: bad, closingOn: '2026-08-28' }),
      null,
      `planned a payout for ${bad}`,
    );
  }
});

test('centavos survive the round trip', () => {
  const plan = planMesaOffboardPayout({ email: 'x@simple.biz', accountNumber: null, balance: 0.1 + 0.2, closingOn: '2026-08-28' });
  assert.equal(plan?.obligation.amount_php, 0.3);
});

test('a missing email is refused rather than written as an orphan row', () => {
  assert.throws(
    () => planMesaOffboardPayout({ email: '   ', accountNumber: null, balance: 100, closingOn: '2026-08-28' }),
    /email is required/,
  );
});

// ── the due week ────────────────────────────────────────────────────────────

test('the due week is always a Saturday', () => {
  // mesa_payroll_obligations REJECTS a non-Saturday due_week_end, so a bad date
  // here is an insert that fails at the moment someone opts out.
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < 400; i++) {
    const iso = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const wk = nextPayoutWeekEnd(iso);
    assert.equal(dow(wk), 6, `${iso} (${DAY[dow(iso)]}) -> ${wk} (${DAY[dow(wk)]})`);
  }
});

test('the due week is STRICTLY after the closing date', () => {
  // A balance released today cannot ride a cheque already computed. Landing it
  // on the current week would read as settled while never being paid.
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < 400; i++) {
    const iso = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    assert.ok(nextPayoutWeekEnd(iso) > iso, `${iso} produced ${nextPayoutWeekEnd(iso)}`);
  }
});

test('opting out ON a Saturday pushes to the NEXT week, not that same day', () => {
  assert.equal(dow('2026-08-29'), 6);
  assert.equal(nextPayoutWeekEnd('2026-08-29'), '2026-09-05');
});

test('opting out on a Friday lands on the very next day', () => {
  assert.equal(dow('2026-08-28'), 5);
  assert.equal(nextPayoutWeekEnd('2026-08-28'), '2026-08-29');
});

test('a malformed closing date is refused, not silently mis-dated', () => {
  for (const bad of ['', '2026-8-29', '29/08/2026', 'today']) {
    assert.throws(() => nextPayoutWeekEnd(bad), /YYYY-MM-DD/, `accepted ${JSON.stringify(bad)}`);
  }
});
