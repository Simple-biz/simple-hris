import { test } from 'node:test';
import assert from 'node:assert/strict';

import { invoicePeriodKey, isInvoiceInPeriod } from './invoice-period';

/**
 * Owner rule (2026-07-31): Payment Dispatch shows a contractor invoice only when
 * it was billed inside the pay period being dispatched. Approval carries no
 * pay-week, so without this window every still-unsettled approved invoice ever
 * filed sat in the current week's USD queue as payable — Claire's back catalogue
 * (~US$8.2k dated May–June) alongside the one invoice that actually belonged to
 * the week.
 *
 * These tests pin the inclusive boundaries, the `invoice_date` → `created_at`
 * fallback, the string comparison that keeps a Saturday-night UTC timestamp
 * inside its own Sat-ending period, and the fail-open behaviour when the period
 * cannot be derived — a window we failed to parse must never hide money.
 */

const inv = (invoice_date: string | null, created_at: string | null = null) => ({
  invoice_date,
  created_at,
});

// The live 2026-07-19 → 07-25 cycle these rules were written against.
const START = '2026-07-19';
const END = '2026-07-25';

test('an invoice billed inside the period is in', () => {
  assert.equal(isInvoiceInPeriod(inv('2026-07-22'), START, END), true);
});

test('both period boundaries are inclusive', () => {
  assert.equal(isInvoiceInPeriod(inv(START), START, END), true);
  assert.equal(isInvoiceInPeriod(inv(END), START, END), true);
});

test('a day either side of the period is out', () => {
  assert.equal(isInvoiceInPeriod(inv('2026-07-18'), START, END), false);
  assert.equal(isInvoiceInPeriod(inv('2026-07-26'), START, END), false);
});

test("Claire's back catalogue is out of the current period", () => {
  for (const d of ['2026-05-31', '2026-06-07', '2026-06-14', '2026-06-21', '2026-07-12']) {
    assert.equal(isInvoiceInPeriod(inv(d), START, END), false, `${d} must not be payable this week`);
  }
  // The one she filed for the week itself stays.
  assert.equal(isInvoiceInPeriod(inv('2026-07-19'), START, END), true);
});

test('invoices filed for the NEXT cycle are out of this one', () => {
  // Filed 07-26/07-27 while the 07-19→07-25 CSV is still current; they belong to
  // the next run and appear once its upload lands.
  assert.equal(isInvoiceInPeriod(inv('2026-07-26'), START, END), false);
  assert.equal(isInvoiceInPeriod(inv('2026-07-27'), START, END), false);
});

test('created_at fills in for a blank invoice_date', () => {
  assert.equal(isInvoiceInPeriod(inv(null, '2026-07-22T04:11:09.123Z'), START, END), true);
  assert.equal(isInvoiceInPeriod(inv('', '2026-06-07T04:11:09.123Z'), START, END), false);
});

test('invoice_date wins over created_at when both are present', () => {
  // Billed inside the week, filed after it closed → in (the contractor billed the week).
  assert.equal(isInvoiceInPeriod(inv('2026-07-24', '2026-07-27T09:00:00.000Z'), START, END), true);
  // Billed before the week, filed during it → out.
  assert.equal(isInvoiceInPeriod(inv('2026-06-21', '2026-07-20T09:00:00.000Z'), START, END), false);
});

test('a UTC timestamp is date-sliced, never parsed into a local Date', () => {
  // 22:00 UTC on the period's last day is 06:00 the NEXT day in Manila; parsing
  // it as a Date would push a Saturday invoice out of its own Sat-ending period.
  assert.equal(isInvoiceInPeriod(inv(null, '2026-07-25T22:00:00.000Z'), START, END), true);
  assert.equal(invoicePeriodKey(inv(null, '2026-07-25T22:00:00.000Z')), '2026-07-25');
});

test('an invoice with no date at all is out — nothing places it in this run', () => {
  assert.equal(isInvoiceInPeriod(inv(null, null), START, END), false);
  assert.equal(invoicePeriodKey(inv(null, null)), '');
});

test('an unparseable period hides nothing (fails open)', () => {
  assert.equal(isInvoiceInPeriod(inv('2026-01-02'), null, END), true);
  assert.equal(isInvoiceInPeriod(inv('2026-01-02'), START, null), true);
  assert.equal(isInvoiceInPeriod(inv(null, null), null, null), true);
});
