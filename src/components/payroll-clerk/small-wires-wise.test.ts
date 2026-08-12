import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SMALL_WIRES_WISE_THRESHOLD_PHP,
  applySmallWiresWiseReroute,
  isSmallWiresAmountPHP,
  type QueueRow,
} from './mock-queue';

/**
 * Owner rule (2026-07-29): a wires-routed employee whose pay for the week is
 * UNDER ₱7,000 is paid through Wise that week instead — wire fees dwarf small
 * transfers. The reroute is computed per cycle from the final amount being
 * sent and never persisted, so a ≥₱7k week routes the person straight back to
 * Wires. These tests pin the boundary (exactly ₱7,000 stays on Wires) and the
 * exemptions (contractors, USD/COP payees, null/zero amounts).
 *
 * A second block here used to pin the Reports-tab CSV export mirror
 * (dispatch-export-csv.ts); it was removed with that surface (2026-08-12).
 * The live queue analogue — a recorded dispatch is never rewritten — is
 * enforced upstream: useDispatchQueue applies the reroute to PENDING rows only.
 */

function queueRow(over: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'maria@simple.biz',
    processor: 'wires',
    name: 'Maria Santos',
    email: 'maria@simple.biz',
    amountUSD: 105.2,
    amountPHP: 6500,
    amountCOP: null,
    payCurrency: 'PHP',
    initialPayUSD: 105.2,
    initialPayPHP: 6500,
    pabBonusPHP: 0,
    techBonusPHP: 0,
    bonusTotalPHP: 0,
    orphanagePayPHP: 0,
    mesaDeductionPHP: 0,
    mesaDisbursementPHP: 0,
    totalHours: 32.5,
    otHours: 0,
    bankPreferredRaw: 'x1153',
    departmentKey: 'edit',
    departmentName: 'Edit',
    details: { email: 'maria@simple.biz', bank_name: 'BDO', account_number: '001234567890' },
    ...over,
  };
}

test('wires under ₱7,000 reroutes to Wise and is flagged', () => {
  const out = applySmallWiresWiseReroute(queueRow({ amountPHP: 6999.99 }));
  assert.equal(out.processor, 'wise');
  assert.equal(out.smallWiresViaWise, true);
  // The stored routing is untouched — next week recomputes from scratch.
  assert.equal(out.bankPreferredRaw, 'x1153');
});

test('exactly ₱7,000 stays on Wires (threshold is strictly under)', () => {
  const out = applySmallWiresWiseReroute(queueRow({ amountPHP: SMALL_WIRES_WISE_THRESHOLD_PHP }));
  assert.equal(out.processor, 'wires');
  assert.equal(out.smallWiresViaWise, undefined);
});

test('₱7,000+ weeks stay on Wires', () => {
  const out = applySmallWiresWiseReroute(queueRow({ amountPHP: 12894.5 }));
  assert.equal(out.processor, 'wires');
  assert.equal(out.smallWiresViaWise, undefined);
});

test('null and zero PHP amounts never reroute — nothing to send', () => {
  assert.equal(applySmallWiresWiseReroute(queueRow({ amountPHP: null })).processor, 'wires');
  assert.equal(applySmallWiresWiseReroute(queueRow({ amountPHP: 0 })).processor, 'wires');
});

test('non-wires rails are untouched, even under ₱7k', () => {
  const hurupay = applySmallWiresWiseReroute(queueRow({ processor: 'hurupay', amountPHP: 3000 }));
  assert.equal(hurupay.processor, 'hurupay');
  // Already-Wise rows must not pick up the temp flag.
  const wise = applySmallWiresWiseReroute(queueRow({ processor: 'wise', amountPHP: 3000 }));
  assert.equal(wise.processor, 'wise');
  assert.equal(wise.smallWiresViaWise, undefined);
});

test('contractor settlements never reroute — Wise is not a contractor gateway', () => {
  const out = applySmallWiresWiseReroute(
    queueRow({ payeeKind: 'contractor', contractorInvoiceId: 'inv-1', amountPHP: 2500 }),
  );
  assert.equal(out.processor, 'wires');
  assert.equal(out.smallWiresViaWise, undefined);
});

test('USD/COP payees never reroute off a PHP threshold', () => {
  const usd = applySmallWiresWiseReroute(queueRow({ payCurrency: 'USD', amountPHP: 5000 }));
  assert.equal(usd.processor, 'wires');
  const cop = applySmallWiresWiseReroute(
    queueRow({ payCurrency: 'COP', amountPHP: 5000, amountCOP: 350000 }),
  );
  assert.equal(cop.processor, 'wires');
});

test('isSmallWiresAmountPHP pins the boundary', () => {
  assert.equal(isSmallWiresAmountPHP(6999.99), true);
  assert.equal(isSmallWiresAmountPHP(7000), false);
  assert.equal(isSmallWiresAmountPHP(0), false);
  assert.equal(isSmallWiresAmountPHP(null), false);
  assert.equal(isSmallWiresAmountPHP(undefined), false);
  assert.equal(isSmallWiresAmountPHP(Number.NaN), false);
});
