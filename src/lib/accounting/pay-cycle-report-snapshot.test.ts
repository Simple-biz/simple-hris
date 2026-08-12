import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tallyPaidDispatches } from './pay-cycle-report-snapshot';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

/**
 * These tests pin THE shared paid-dispatch tally — the superseded-marker /
 * two-pass semantics the cycle close-out freezes its paid headline with
 * (cycle-closeout.ts imports tallyPaidDispatches). The publish-gate and
 * snapshot-builder suites that used to live alongside them died with the
 * pay-cycle-report surface (2026-08-12); the tally's rules outlive it.
 */

function dispatch(over: Partial<PaymentDispatchRow> = {}): PaymentDispatchRow {
  return {
    id: 'd1',
    recipient_email: 'juan@simple.biz',
    recipient_name: 'Juan Santos',
    processor: 'hurupay',
    amount_usd: 100,
    amount_php: 5600,
    transaction_id: 'TXN-1',
    bank_used: 'Hurupay',
    sent_date: '2026-08-01',
    arrival_date: '2026-08-02',
    status: 'paid',
    payee_type: 'employee',
    cycle_source_file: 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv',
    ...over,
  } as PaymentDispatchRow;
}

describe('tallyPaidDispatches', () => {
  test('THE shared tally: one employee paid twice collapses, two invoices do not', () => {
    // The dedup rule the Stop dialog's close-out record and Payment Dispatch's
    // own headline share. Juan's two payments are one payee; Claire's two
    // invoices are two settlements (paying 4 of 7 invoices must not read as
    // "1 paid").
    const t = tallyPaidDispatches([
      dispatch({ recipient_email: 'Juan@simple.biz', amount_usd: 60, amount_php: 3360 }),
      dispatch({ recipient_email: 'juan@simple.biz ', amount_usd: 40, amount_php: 2240 }),
      dispatch({ recipient_email: 'claire@agency.com', payee_type: 'contractor', amount_usd: 500, amount_php: 0 }),
      dispatch({ recipient_email: 'claire@agency.com', payee_type: 'contractor', amount_usd: 700, amount_php: 0 }),
    ]);
    assert.equal(t.payeeCount, 3);
    assert.equal(t.employeeCount, 1);
    assert.equal(t.contractorCount, 2);
    assert.equal(t.dispatchCount, 4);
    assert.equal(t.paidUSD, 1300);
    assert.equal(t.paidPHP, 5600);
    assert.equal(t.unsettledCount, 0);
  });

  test('non-paid rows are counted as unsettled and contribute no money', () => {
    const t = tallyPaidDispatches([
      dispatch({ amount_usd: 100 }),
      dispatch({ status: 'not_paid', amount_usd: 999, recipient_email: 'b@simple.biz' }),
      dispatch({ status: 'threshold', amount_usd: 999, recipient_email: 'c@simple.biz' }),
      dispatch({ status: 'problem', amount_usd: 999, recipient_email: 'd@simple.biz' }),
    ]);
    assert.equal(t.dispatchCount, 1);
    assert.equal(t.unsettledCount, 3);
    assert.equal(t.payeeCount, 1);
    assert.equal(t.paidUSD, 100);
  });

  test('an empty cycle tallies to zero of everything', () => {
    assert.deepEqual(tallyPaidDispatches([]), {
      payeeCount: 0, employeeCount: 0, contractorCount: 0,
      dispatchCount: 0, paidUSD: 0, paidPHP: 0, unsettledCount: 0,
    });
  });

  test('a marker row superseded by a retry is not unsettled', () => {
    // Mark Not Paid (bank glitch) → retry → Mark Paid leaves BOTH rows in place.
    // Payment Dispatch reads that person as paid (its own `settled` rule), so the
    // tally must too — otherwise the close-out would record a person as owed
    // against a queue that is finished.
    const t = tallyPaidDispatches([
      dispatch({ id: 'marker', status: 'not_paid', amount_usd: 0 }),
      dispatch({ id: 'retry', amount_usd: 100 }),
    ]);
    assert.equal(t.unsettledCount, 0);
    assert.equal(t.dispatchCount, 1, 'only the paid row is a payment');
    assert.equal(t.payeeCount, 1);
    assert.equal(t.paidUSD, 100, 'the marker contributes no money');
  });

  test('supersession is keyed by payee KIND, not email alone', () => {
    // Claire holds both identities. Her paid SALARY must not silence a flagged
    // INVOICE, and her paid invoice must not silence a flagged salary.
    const salaryPaidInvoiceFlagged = tallyPaidDispatches([
      dispatch({ id: 'sal', recipient_email: 'claire@simple.biz' }),
      dispatch({ id: 'inv', status: 'problem', payee_type: 'contractor', recipient_email: 'claire@simple.biz' }),
    ]);
    assert.equal(salaryPaidInvoiceFlagged.unsettledCount, 1);

    const invoicePaidSalaryFlagged = tallyPaidDispatches([
      dispatch({ id: 'inv', payee_type: 'contractor', recipient_email: 'claire@simple.biz' }),
      dispatch({ id: 'sal', status: 'not_paid', recipient_email: 'claire@simple.biz' }),
    ]);
    assert.equal(invoicePaidSalaryFlagged.unsettledCount, 1);
  });

  test('null money normalizes instead of producing NaN', () => {
    const t = tallyPaidDispatches([dispatch({ amount_usd: null, amount_php: null })]);
    assert.equal(t.paidUSD, 0);
    assert.equal(t.paidPHP, 0);
    assert.equal(t.dispatchCount, 1);
  });
});
