import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPendingRows,
  buildSentRows,
  pendingRowsToCsv,
  sentRowsToCsv,
} from './dispatch-client-csv';
import type { QueueRow } from '@/components/payroll-clerk/mock-queue';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

/**
 * The Payment Dispatch exports are the HRIS-vs-Google-Sheet validation artifact
 * (memory: payroll-exports-itemized), so these tests pin the two properties a
 * spreadsheet reader depends on:
 *
 *   1. Every row RECONCILES from its own columns — and no signed component
 *      hides inside an aggregate.
 *   2. Nothing the screen shows VANISHES from that screen's own export.
 *
 * The wizard's own Reports export has carried the same identity since
 * 2026-08-18 (`payrollExportRowReconciles`); until 2026-08-25 the dispatch side
 * had neither the columns nor a test, so `Bonus Total − PAB − Tech` was an
 * unsplittable residual mixing earned dept/KPI money with a signed withholding
 * (692 and 86 live rows respectively on the 2026-08-16 cycle).
 */

function row(over: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'a@simple.biz',
    name: 'A Person',
    email: 'a@simple.biz',
    processor: 'hurupay',
    amountUSD: 140,
    amountPHP: 8_500,
    amountCOP: null,
    payCurrency: 'PHP',
    countryCurrency: null,
    initialPayUSD: 131.15,
    initialPayPHP: 8_000,
    pabBonusPHP: 0,
    techBonusPHP: 0,
    otherBonusesPHP: 600,
    adjustmentPHP: 0,
    bonusTotalPHP: 600,
    orphanagePayPHP: 0,
    mesaDeductionPHP: 100,
    mesaDisbursementPHP: 0,
    valuesSource: 'snapshot',
    totalHours: 38.5,
    otHours: 0,
    bankPreferredRaw: 'hurupay',
    departmentKey: 'lead_gen',
    departmentName: 'Lead Gen',
    details: {},
    ...over,
  } as QueueRow;
}

function record(over: Partial<PaymentDispatchRow> = {}): PaymentDispatchRow {
  return {
    id: '1',
    recipient_email: 'a@simple.biz',
    recipient_name: 'A Person',
    processor: 'hurupay',
    status: 'paid',
    sent_date: '2026-08-19',
    arrival_date: null,
    amount_usd: 140,
    amount_php: 8_500,
    amount_cop: 438_200,
    system_bonus_php: 1_850,
    system_bonus_label: 'Tech ₱1,850',
    bank_used: 'BPI',
    transaction_id: 'TXN-1',
    note: null,
    created_by: 'lenny@simple.biz',
    created_at: '2026-08-19T02:00:00.000Z',
    ...over,
  } as PaymentDispatchRow;
}

/** RFC-4180 field split — a real parse, so a value that legitimately contains a
 *  comma ("Tech ₱1,850") is read as one cell rather than shifting every column
 *  after it. Reading the file the way a spreadsheet does is the point. */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { quoted = false; }
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Read one cell out of a built CSV row by its HEADER, the way a reader does. */
function cell(csv: string, header: string, dataRowIndex = 0): string {
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  const headers = fields(lines[0]);
  const idx = headers.indexOf(header);
  assert.notEqual(idx, -1, `column "${header}" is missing from the export`);
  return fields(lines[1 + dataRowIndex])[idx];
}

const money = (s: string): number => (s === '' ? 0 : Number(s));

describe('pending worksheet CSV', () => {
  it('reconciles Amount (PHP) from its own columns', () => {
    const csv = pendingRowsToCsv(
      buildPendingRows(
        [
          row({
            initialPayPHP: 8_000,
            pabBonusPHP: 5_000,
            techBonusPHP: 1_850,
            otherBonusesPHP: 600,
            adjustmentPHP: -250,
            bonusTotalPHP: 7_200,
            orphanagePayPHP: 1_000,
            mesaDeductionPHP: 100,
            mesaDisbursementPHP: 300,
            amountPHP: 16_400,
          }),
        ],
        {},
      ),
    );
    const components =
      money(cell(csv, 'Regular + OT (PHP)')) +
      money(cell(csv, 'Bonus Total (PHP)')) +
      money(cell(csv, 'Orphanage (PHP)')) -
      money(cell(csv, 'MESA Deduction (PHP)')) +
      money(cell(csv, 'MESA Disbursement (PHP)'));
    assert.equal(components, money(cell(csv, 'Amount (PHP)')));
  });

  it('reconciles the bonus split to Bonus Total', () => {
    const csv = pendingRowsToCsv(
      buildPendingRows(
        [
          row({
            pabBonusPHP: 5_000,
            techBonusPHP: 1_850,
            otherBonusesPHP: 600,
            adjustmentPHP: -250,
            bonusTotalPHP: 7_200,
            amountPHP: 15_200,
          }),
        ],
        {},
      ),
    );
    const split =
      money(cell(csv, 'PAB Bonus (PHP)')) +
      money(cell(csv, 'Tech Bonus (PHP)')) +
      money(cell(csv, 'Other Bonuses (PHP)')) +
      money(cell(csv, 'Adjustment (PHP)'));
    assert.equal(split, money(cell(csv, 'Bonus Total (PHP)')));
  });

  it('itemizes a signed Adjustment apart from earned bonuses', () => {
    // The defect this column exists to prevent: ₱600 earned and ₱600 withheld
    // net to a Bonus Total of 0, which the old shape printed as a blank cell
    // indistinguishable from "no bonuses this week".
    const csv = pendingRowsToCsv(
      buildPendingRows(
        [row({ otherBonusesPHP: 600, adjustmentPHP: -600, bonusTotalPHP: 0, amountPHP: 7_900 })],
        {},
      ),
    );
    assert.equal(cell(csv, 'Other Bonuses (PHP)'), '600.00');
    assert.equal(cell(csv, 'Adjustment (PHP)'), '-600.00');
    assert.equal(cell(csv, 'Bonus Total (PHP)'), '');
  });

  it('never gates a negative figure out of the file', () => {
    const csv = pendingRowsToCsv(
      buildPendingRows(
        [row({ otherBonusesPHP: 0, adjustmentPHP: -1_500, bonusTotalPHP: -1_500, amountPHP: 6_400 })],
        {},
      ),
    );
    assert.equal(cell(csv, 'Adjustment (PHP)'), '-1500.00');
    assert.equal(cell(csv, 'Bonus Total (PHP)'), '-1500.00');
  });

  it('blanks the whole split when no carrier itemized the row, rather than claiming zeros', () => {
    const csv = pendingRowsToCsv(
      buildPendingRows([row({ breakdownUnavailable: true, valuesSource: 'lock' })], {}),
    );
    for (const h of [
      'Regular + OT (PHP)',
      'PAB Bonus (PHP)',
      'Tech Bonus (PHP)',
      'Other Bonuses (PHP)',
      'Adjustment (PHP)',
      'Bonus Total (PHP)',
      'Orphanage (PHP)',
      'MESA Deduction (PHP)',
      'MESA Disbursement (PHP)',
    ]) {
      assert.equal(cell(csv, h), '', `${h} must be blank when the breakdown is unavailable`);
    }
    // The amount itself still prints — the row is payable, only its split is unknown.
    assert.equal(cell(csv, 'Amount (PHP)'), '8500.00');
  });

  it('names the carrier that priced the row', () => {
    const built = (source: QueueRow['valuesSource']) =>
      cell(pendingRowsToCsv(buildPendingRows([row({ valuesSource: source })], {})), 'Amount Source');
    assert.equal(built('snapshot'), 'Payroll Wizard (published)');
    assert.equal(built('lock'), 'Payroll Wizard (locked)');
    // Quoted by the RFC-4180 escape because of the em-dash-free comma-less text —
    // assert on the raw cell so a rename can't quietly drop the warning.
    assert.match(built('recomputed'), /RECOMPUTED/);
  });

  it('carries the COP value the worksheet shows, as a whole peso', () => {
    const csv = pendingRowsToCsv(
      buildPendingRows([row({ payCurrency: 'COP', amountCOP: 438_200.4 })], {}),
    );
    assert.equal(cell(csv, 'COP Value'), '438200');
  });

  it('leaves COP blank for a payee who has none', () => {
    const csv = pendingRowsToCsv(buildPendingRows([row({ amountCOP: null })], {}));
    assert.equal(cell(csv, 'COP Value'), '');
  });

  it('carries the TXN reference a retried payee is holding', () => {
    const csv = pendingRowsToCsv(
      buildPendingRows([row()], { 'a@simple.biz': 'TXN-RETRY-9' }),
    );
    assert.equal(cell(csv, 'TXN ID'), 'TXN-RETRY-9');
  });
});

describe('sent / log-view CSV', () => {
  it('carries every money column the log view shows', () => {
    const csv = sentRowsToCsv(buildSentRows([record()], { 'a@simple.biz': 'Lead Gen' }));
    assert.equal(cell(csv, 'Amount (USD)'), '140.00');
    assert.equal(cell(csv, 'Amount (PHP)'), '8500.00');
    assert.equal(cell(csv, 'COP Value'), '438200');
    assert.equal(cell(csv, 'System Bonus (PHP)'), '1850.00');
    assert.equal(cell(csv, 'System Bonus Detail'), 'Tech ₱1,850');
    assert.equal(cell(csv, 'Department'), 'Lead Gen');
  });

  it('leaves the System Bonus blank on a pre-migration row instead of claiming ₱0', () => {
    const csv = sentRowsToCsv(
      buildSentRows([record({ system_bonus_php: null, system_bonus_label: null })], {}),
    );
    assert.equal(cell(csv, 'System Bonus (PHP)'), '');
    assert.equal(cell(csv, 'System Bonus Detail'), '');
  });

  it('prints a recorded ₱0 bonus, which is a real claim', () => {
    const csv = sentRowsToCsv(buildSentRows([record({ system_bonus_php: 0 })], {}));
    assert.equal(cell(csv, 'System Bonus (PHP)'), '0.00');
  });

  it('leaves Department blank when no source could place the payee', () => {
    const csv = sentRowsToCsv(buildSentRows([record()], {}));
    assert.equal(cell(csv, 'Department'), '');
  });
});
