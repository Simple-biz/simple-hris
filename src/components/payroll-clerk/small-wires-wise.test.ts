import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SMALL_WIRES_WISE_THRESHOLD_PHP,
  applySmallWiresWiseReroute,
  isSmallWiresAmountPHP,
  type QueueRow,
} from './mock-queue';
import { buildDispatchExportRows } from '@/lib/payroll/dispatch-export-csv';
import type { DisbursementRecordRow } from '@/lib/payroll/disbursement-reports';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';

/**
 * Owner rule (2026-07-29): a wires-routed employee whose pay for the week is
 * UNDER ₱7,000 is paid through Wise that week instead — wire fees dwarf small
 * transfers. The reroute is computed per cycle from the final amount being
 * sent and never persisted, so a ≥₱7k week routes the person straight back to
 * Wires. These tests pin the boundary (exactly ₱7,000 stays on Wires), the
 * exemptions (contractors, USD/COP payees, null/zero amounts) and the Reports
 * CSV mirror (recorded dispatches are never rewritten).
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

// ── Reports CSV mirror ───────────────────────────────────────────────────────

function record(over: Partial<DisbursementRecordRow> = {}): DisbursementRecordRow {
  return {
    recipient_email: 'maria@simple.biz',
    recipient_name: 'Maria Santos',
    status: 'pending',
    amount_usd: 105.2,
    paid_amount_usd: null,
    amount_php: 6500,
    transaction_id: null,
    bank_used: null,
    paid_at: null,
    ...over,
  } as DisbursementRecordRow;
}

function wiresChooser(): EmployeeIdRow {
  return {
    work_email: 'maria@simple.biz',
    personal_email: null,
    bank_preferred: 'wires',
    preferred_processor: null,
  } as EmployeeIdRow;
}

test('CSV export: pending sub-₱7k wires row exports as wise', () => {
  const rows = buildDispatchExportRows([record()], [], [], [wiresChooser()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.processor, 'wise');
});

test('CSV export: pending ₱7,000+ wires row stays wires', () => {
  const rows = buildDispatchExportRows([record({ amount_php: 7000 })], [], [], [wiresChooser()]);
  assert.equal(rows[0]!.processor, 'wires');
});

test('CSV export: a recorded dispatch is never rewritten', () => {
  const dispatch = {
    recipient_email: 'maria@simple.biz',
    recipient_name: 'Maria Santos',
    payee_type: 'employee',
    processor: 'wires',
    status: 'paid',
    created_at: '2026-07-28T10:00:00Z',
    sent_date: '2026-07-28',
  } as PaymentDispatchRow;
  const rows = buildDispatchExportRows(
    [record({ status: 'paid', paid_amount_usd: 105.2 })],
    [dispatch],
    [],
    [wiresChooser()],
  );
  // The clerk actually sent this one by wire — the export must say so.
  assert.equal(rows[0]!.processor, 'wires');
});

test('CSV export: backfilled paid row without a dispatch keeps the stored rail', () => {
  const rows = buildDispatchExportRows(
    [record({ status: 'paid', paid_amount_usd: 105.2, paid_at: '2026-07-28T10:00:00Z' })],
    [],
    [],
    [wiresChooser()],
  );
  assert.equal(rows[0]!.processor, 'wires');
});

test('CSV export: null PHP amount (USD payee) never flips', () => {
  const rows = buildDispatchExportRows([record({ amount_php: null })], [], [], [wiresChooser()]);
  assert.equal(rows[0]!.processor, 'wires');
});
