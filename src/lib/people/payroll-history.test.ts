import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mapPayloadToPayStub } from '@/lib/payroll/paystub-view';
import type { DispatchInput } from '@/lib/penny/pay-reconciliation';
import { buildPayrollHistory, statementBonusLines, type PayrollRecordInput } from './payroll-history';

// Fixtures are gyd@'s real staged statements, read from production 2026-09-28
// (paystub_dispatch_queue.payload.pay_php), run through the real statement mapper.
function statement(start: string, end: string, pay: Record<string, number>, sourceFile = `simple-biz_daily_report_${start}_to_${end}.csv`) {
  return {
    sourceFile,
    paidAt: `${end}`,
    view: mapPayloadToPayStub({
      name: 'Gyd',
      pay_php: pay,
      hours: { regular: 40, ot: 3 },
      pay_period: { week: { start, end }, fx_rate: 58 },
    }),
  };
}

const AUG_23 = statement('2026-08-23', '2026-08-29', {
  regular: 23750, ot: 1875, initial: 25625, perfect_attendance_bonus: 5000, tech_bonus: 0,
  other_bonuses: 0, adjustment: 25000, bonuses_total: 30000, orphanage_pay: 9000,
  mesa_deduction: 100, mesa_disbursement: 0, final: 64525,
});
const SEP_13 = statement('2026-09-13', '2026-09-19', {
  regular: 24635, ot: 2317.5, initial: 26952.5, perfect_attendance_bonus: 0, tech_bonus: 0,
  other_bonuses: 0, adjustment: 0, bonuses_total: 0, orphanage_pay: 12787.5,
  mesa_deduction: 100, mesa_disbursement: 0, final: 39640,
});

function record(start: string, end: string, hourly: number, extra: Partial<PayrollRecordInput> = {}): PayrollRecordInput {
  return {
    source_file: `simple-biz_api_sync_${start}_to_${end}.csv`,
    kind: 'cycle',
    note: null,
    period_start: start,
    period_end: end,
    total_hours: 43,
    amount_php: hourly,
    status: 'paid',
    paid_at: null,
    ...extra,
  };
}

function dispatch(start: string, paidPhp: number, bonusPhp: number | null, extra: Partial<DispatchInput> = {}): DispatchInput {
  return {
    period_start: start,
    period_end: null,
    paid_usd: null,
    paid_php: paidPhp,
    bonus_php: bonusPhp,
    bonus_label: bonusPhp != null ? 'PAB ₱5,000' : null,
    at: `${start}T12:00:00Z`,
    payee_type: 'employee',
    ...extra,
  };
}

describe('buildPayrollHistory', () => {
  it('headlines the statement Net pay and itemises the bonuses, never the hourly pay alone', () => {
    const [w] = buildPayrollHistory({ records: [record('2026-08-23', '2026-08-29', 25625)], statements: [AUG_23], dispatches: [] });
    assert.equal(w.source, 'statement');
    assert.equal(w.totalPhp, 64525);
    assert.equal(w.hourlyPayPhp, 25625, 'hourly pay is kept, under its own name');
    assert.equal(w.bonusTotalPhp, 30000, 'PAB + Tech + KPI + Adjustment, payment-dispatch.md §4.2.3');
    assert.equal(w.bonusItemised, true);
    assert.deepEqual(
      w.bonusLines.map((l) => [l.label, l.amountPhp]),
      [['Attendance Incentive', 5000], ['Adjustment', 25000]],
    );
    assert.ok(w.statement, 'the full statement rides along for the Statement view');
  });

  it('joins a statement to its week by START DATE even when the filenames differ', () => {
    // The record is keyed api_sync, the statement daily_report: a filename join loses the week.
    const [w] = buildPayrollHistory({ records: [record('2026-08-23', '2026-08-29', 25625)], statements: [AUG_23], dispatches: [] });
    assert.notEqual(record('2026-08-23', '2026-08-29', 0).source_file, AUG_23.sourceFile);
    assert.equal(w.source, 'statement');
    assert.equal(w.sourceFile, AUG_23.sourceFile);
  });

  it('an itemised week with no bonus is a real ₱0, not "not on record"', () => {
    const [w] = buildPayrollHistory({ records: [record('2026-09-13', '2026-09-19', 26952.5)], statements: [SEP_13], dispatches: [] });
    assert.equal(w.bonusTotalPhp, 0);
    assert.equal(w.bonusItemised, true);
    assert.deepEqual(w.bonusLines, []);
  });

  it('never hides a negative Adjustment', () => {
    const neg = statement('2026-09-06', '2026-09-12', {
      regular: 20000, ot: 0, perfect_attendance_bonus: 0, tech_bonus: 1850, other_bonuses: 0,
      adjustment: -1000, orphanage_pay: 0, mesa_deduction: 100, mesa_disbursement: 0, final: 20750,
    });
    const lines = statementBonusLines(neg.view);
    assert.deepEqual(lines.map((l) => [l.key, l.amountPhp]), [['tech', 1850], ['adjustment', -1000]]);
    const [w] = buildPayrollHistory({ records: [], statements: [neg], dispatches: [] });
    assert.equal(w.bonusTotalPhp, 850);
  });

  it('without a statement, quotes the paid dispatch total and its bonus TOTAL, never the label', () => {
    const [w] = buildPayrollHistory({
      records: [record('2026-06-07', '2026-06-13', 17000)],
      statements: [],
      dispatches: [dispatch('2026-06-07', 22000, 5000)],
    });
    assert.equal(w.source, 'dispatch');
    assert.equal(w.totalPhp, 22000);
    assert.equal(w.bonusTotalPhp, 5000);
    assert.equal(w.bonusItemised, false);
    assert.deepEqual(w.bonusLines, []);
    assert.equal(w.status, 'paid');
    assert.ok(!JSON.stringify(w).includes('PAB ₱5,000'), 'the PAB/Tech-only label is never carried');
  });

  it('a week with only its record says hourly pay, and the bonus is NOT ON RECORD (null), never ₱0', () => {
    const [w] = buildPayrollHistory({ records: [record('2026-03-01', '2026-03-07', 15000, { status: 'pending' })], statements: [], dispatches: [] });
    assert.equal(w.source, 'hourly_only');
    assert.equal(w.totalPhp, null);
    assert.equal(w.hourlyPayPhp, 15000);
    assert.equal(w.bonusTotalPhp, null);
    assert.equal(w.status, 'pending');
  });

  it('names both figures when the statement and the dispatch disagree', () => {
    const [w] = buildPayrollHistory({
      records: [record('2026-08-23', '2026-08-29', 25625)],
      statements: [AUG_23],
      dispatches: [dispatch('2026-08-23', 64425, 30000)],
    });
    assert.match(w.disagreement ?? '', /₱64,525\.00.*₱64,425\.00/);
    const [ok] = buildPayrollHistory({
      records: [record('2026-08-23', '2026-08-29', 25625)],
      statements: [AUG_23],
      dispatches: [dispatch('2026-08-23', 64525, 30000)],
    });
    assert.equal(ok.disagreement, null);
  });

  it('adds a week the records have not caught up on, but never one older than the oldest record', () => {
    const weeks = buildPayrollHistory({
      records: [record('2026-09-06', '2026-09-12', 20000)],
      statements: [SEP_13, AUG_23],
      dispatches: [],
    });
    assert.deepEqual(weeks.map((w) => w.periodStart), ['2026-09-13', '2026-09-06']);
  });

  it('ignores contractor dispatch rows (they settle an invoice, not a pay week)', () => {
    const [w] = buildPayrollHistory({
      records: [record('2026-06-07', '2026-06-13', 17000)],
      statements: [],
      dispatches: [dispatch('2026-06-07', 99999, null, { payee_type: 'contractor' })],
    });
    assert.equal(w.source, 'hourly_only');
  });

  it('folds a second record for the same week into it instead of listing the week twice', () => {
    const weeks = buildPayrollHistory({
      records: [record('2026-06-07', '2026-06-13', 10000), record('2026-06-07', '2026-06-13', 2500, { total_hours: 7 })],
      statements: [],
      dispatches: [],
    });
    assert.equal(weeks.length, 1);
    assert.equal(weeks[0].hourlyPayPhp, 12500);
    assert.equal(weeks[0].totalHours, 50);
  });

  it('keeps a legacy special-transfer row as its own row', () => {
    const weeks = buildPayrollHistory({
      records: [record('2026-06-07', '2026-06-13', 17000, { kind: 'special', note: 'Final pay', amount_php: 3000 })],
      statements: [],
      dispatches: [],
    });
    assert.equal(weeks.length, 1);
    assert.equal(weeks[0].source, 'special');
    assert.equal(weeks[0].totalPhp, 3000);
    assert.equal(weeks[0].note, 'Final pay');
  });

  it('lists newest first', () => {
    const weeks = buildPayrollHistory({
      records: [record('2026-08-23', '2026-08-29', 25625), record('2026-09-13', '2026-09-19', 26952.5)],
      statements: [AUG_23, SEP_13],
      dispatches: [],
    });
    assert.deepEqual(weeks.map((w) => w.periodStart), ['2026-09-13', '2026-08-23']);
  });
});
