import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkDisbursementAmount,
  sumOutstandingDisbursements,
  type OutstandingDisbursement,
} from './disbursement-guard';

// Before this guard existed, POST /api/mesa-requests stored amount_needed
// verbatim — no type, sign, or balance check of any kind. Each test below is a
// draw that used to be accepted.

const req = (o: Partial<OutstandingDisbursement>): OutstandingDisbursement => ({
  request_type: 'disbursement',
  status: 'pending',
  amount_needed: 1000,
  dispatched_at: null,
  ...o,
});

// ── the amount itself ───────────────────────────────────────────────────────

test('a draw larger than the balance is refused', () => {
  // kaner@, live on 2026-08-27: PHP 5,000 pending against a PHP 3,600 balance.
  const r = checkDisbursementAmount({ requested: 5000, balance: 3600 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exceeds_available');
  assert.equal(r.shortfall, 1400);
  assert.match(r.message ?? '', /1,400\.00/);
});

test('a draw for EXACTLY the balance is allowed', () => {
  // The boundary is the whole point — an off-by-one here refuses a legitimate
  // draw of everything the member has.
  const r = checkDisbursementAmount({ requested: 3600, balance: 3600 });
  assert.equal(r.ok, true);
  assert.equal(r.shortfall, 0);
});

test('a draw one centavo over the balance is refused', () => {
  const r = checkDisbursementAmount({ requested: 3600.01, balance: 3600 });
  assert.equal(r.ok, false);
  assert.equal(r.shortfall, 0.01);
});

test('zero, negative, and non-numeric amounts are refused', () => {
  for (const bad of [0, -1, -5000, NaN, Infinity, -Infinity, null, undefined, '', 'abc', {}, []]) {
    const r = checkDisbursementAmount({ requested: bad, balance: 10000 });
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.equal(r.reason, 'invalid_amount', `wrong reason for ${JSON.stringify(bad)}`);
  }
});

test('a numeric string is accepted on its value, not its type', () => {
  // Bodies arrive as JSON from a form; "500" is a real amount, not a bad one.
  assert.equal(checkDisbursementAmount({ requested: '500', balance: 3600 }).ok, true);
  assert.equal(checkDisbursementAmount({ requested: '9999', balance: 3600 }).ok, false);
});

test('a zero balance refuses every draw', () => {
  const r = checkDisbursementAmount({ requested: 1, balance: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.available, 0);
});

// ── outstanding draws: the part a balance check alone gets wrong ────────────

test('two draws that each fit, but together overdraw, are caught', () => {
  // PHP 3,600 balance. First PHP 2,000 request is pending. A second PHP 2,000
  // passes a naive balance check and overdraws by PHP 400.
  const outstanding = sumOutstandingDisbursements([req({ amount_needed: 2000 })]);
  assert.equal(outstanding, 2000);
  const r = checkDisbursementAmount({ requested: 2000, balance: 3600, outstanding });
  assert.equal(r.ok, false);
  assert.equal(r.available, 1600);
  assert.equal(r.shortfall, 400);
  assert.match(r.message ?? '', /already committed/);
});

test('approved-but-undispatched draws still count against the balance', () => {
  const out = sumOutstandingDisbursements([
    req({ status: 'approved', amount_needed: 1500, dispatched_at: null }),
  ]);
  assert.equal(out, 1500);
});

test('DISPATCHED draws do NOT count — the ledger already reflects them', () => {
  // Counting a dispatched draw subtracts the same peso twice.
  const out = sumOutstandingDisbursements([
    req({ status: 'approved', amount_needed: 1500, dispatched_at: '2026-08-01T00:00:00Z' }),
  ]);
  assert.equal(out, 0);
});

test('denied draws do not count — they released no money', () => {
  assert.equal(sumOutstandingDisbursements([req({ status: 'denied', amount_needed: 9999 })]), 0);
});

test('other request types never count against the balance', () => {
  const out = sumOutstandingDisbursements([
    req({ request_type: 'opt_out', amount_needed: 5000 }),
    req({ request_type: 'return', amount_needed: 5000 }),
    req({ request_type: 'opt_in', amount_needed: 5000 }),
  ]);
  assert.equal(out, 0);
});

test('malformed outstanding rows are ignored, not counted as zero-or-crash', () => {
  const out = sumOutstandingDisbursements([
    req({ amount_needed: null }),
    req({ amount_needed: NaN }),
    req({ amount_needed: -500 }),
    req({ status: null }),
    req({ amount_needed: 250 }),
  ]);
  assert.equal(out, 250);
});

test('no outstanding rows at all is zero, not a crash', () => {
  assert.equal(sumOutstandingDisbursements([]), 0);
  assert.equal(sumOutstandingDisbursements(null), 0);
  assert.equal(sumOutstandingDisbursements(undefined), 0);
});

// ── money arithmetic ────────────────────────────────────────────────────────

test('float drift never refuses a draw for exactly the balance', () => {
  // 0.1 + 0.2 = 0.30000000000000004. Without rounding, drawing the full
  // balance made of such sums is refused for a fraction of a centavo.
  const balance = 0.1 + 0.2;
  const r = checkDisbursementAmount({ requested: 0.3, balance });
  assert.equal(r.ok, true, 'float drift refused an exact-balance draw');
});

test('available is never negative even when outstanding exceeds the balance', () => {
  const r = checkDisbursementAmount({ requested: 100, balance: 1000, outstanding: 5000 });
  assert.equal(r.available, 0);
  assert.equal(r.ok, false);
});

test('an UNKNOWN dispatch state is counted, so the limit errs strict', () => {
  // A caller whose select omitted dispatched_at must not accidentally get a
  // LOOSER limit. Unknown is treated as not-yet-dispatched: the draw still
  // counts against the balance.
  const out = sumOutstandingDisbursements([
    { request_type: 'disbursement', status: 'approved', amount_needed: 2000 },
  ]);
  assert.equal(out, 2000);
});
