import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTimeAdjustmentDetail,
  mapPayloadToPayStub,
  parseTimeAdjustmentBlock,
  showsOrphanageLine,
  showsTimeAdjustmentLine,
  type PayStubView,
} from './paystub-view';
import { renderPayStubEmailHtml } from './paystub-email-html';

// ── The Time Adjustment earnings line (2026-09-22) ───────────────────────────
//
// An approved time adjustment is folded into Initial Pay by the wizard, but
// `hours.total` stays the RAW tracked figure (Hubstaff data is never mutated),
// so until this line existed the money sat inside the Net and inside nothing
// that explained it. Measured on juliar@'s real staged 2026-09-06→09-12 stub:
// the earnings lines summed ₱14,188.29 under a printed Net of ₱14,211.62.
//
// These tests pin the identity the statement now holds — Regular + OT +
// Time Adjustment + bonuses − MESA = Net — and the byte-identical contract for
// every statement staged before the block existed.

/** juliar@'s real payload for the 2026-09-06→09-12 week, as staged and emailed.
 *  Figures verbatim from `paystub_dispatch_queue`, read 2026-09-22. */
function juliarPayload(): Record<string, unknown> {
  return {
    name: 'Regner, Julia Azaliah S.',
    email: 'juliar@simple.biz',
    department_name: 'Accounting',
    hours: { ot: 0, total: 37.99, regular: 37.99388888888889 },
    rates_php: { ot: 420, regular: 280 },
    pay_php: {
      ot: 0,
      final: 14211.62,
      initial: 10661.62,
      regular: 10638.29,
      adjustment: 0,
      tech_bonus: 1850,
      bonuses_total: 3650,
      orphanage_pay: 0,
      other_bonuses: 1800,
      mesa_deduction: 100,
      mesa_disbursement: 0,
      perfect_attendance_bonus: 0,
    },
    time_adjustment: { days: [{ date: '2026-09-10', hours: 0.08 }], hours: 0.08, pay_php: 23.33 },
    pay_period: { week: { start: '2026-09-06', end: '2026-09-12' }, fx_rate: 62.72 },
  };
}

/** Sum of every earnings + deduction line the statement renders. */
function lineSum(view: PayStubView): number {
  const lines =
    (view.weekdayPay ?? view.mfPay) +
    (view.weekdayOtPay ?? view.otPay) +
    (view.hasWeekend ? view.weekendPay : 0) +
    (showsTimeAdjustmentLine(view) ? (view.timeAdjustment?.payPhp ?? 0) : 0) +
    view.techBonus +
    view.attendanceBonus +
    view.performanceBonus +
    view.adjustment +
    (showsOrphanageLine(view) ? view.orphanagePay : 0) +
    view.mesaDisbursement -
    view.mesaDeduction;
  return Math.round(lines * 100) / 100;
}

test('the statement lines sum to the Net it prints — the ₱23.33 that had no line', () => {
  const view = mapPayloadToPayStub(juliarPayload());
  assert.equal(lineSum(view), view.totalPayPhp);
  assert.equal(view.totalPayPhp, 14211.62);
});

test('the line carries exactly the pesos the wizard folded into Initial Pay', () => {
  const view = mapPayloadToPayStub(juliarPayload());
  assert.equal(showsTimeAdjustmentLine(view), true);
  assert.equal(view.timeAdjustment?.payPhp, 23.33);
  // Regular + OT + Time Adjustment = Initial Pay, the identity the Reports XLSX
  // has pinned since 2026-09-10 and the statement now holds too.
  assert.equal(
    Math.round((view.mfPay + view.otPay + (view.timeAdjustment?.payPhp ?? 0)) * 100) / 100,
    10661.62,
  );
});

test('Regular Hours stays the RAW tracked figure — the delta is never folded into it', () => {
  const view = mapPayloadToPayStub(juliarPayload());
  assert.equal(view.mfHours, 37.99388888888889);
  assert.equal(view.mfPay, 10638.29);
});

test('a payload staged before the block existed renders NO line', () => {
  const p = juliarPayload();
  delete p.time_adjustment;
  const view = mapPayloadToPayStub(p);
  assert.equal(view.timeAdjustment, null);
  assert.equal(showsTimeAdjustmentLine(view), false);
});

test('a staged block of zeros renders NO line — the block is on every payload since 2026-09-10', () => {
  const p = juliarPayload();
  p.time_adjustment = { hours: 0, pay_php: 0, days: [] };
  (p.pay_php as Record<string, number>).initial = 10638.29;
  (p.pay_php as Record<string, number>).final = 14188.29;
  const view = mapPayloadToPayStub(p);
  assert.notEqual(view.timeAdjustment, null);
  assert.equal(showsTimeAdjustmentLine(view), false);
  assert.equal(lineSum(view), view.totalPayPhp);
});

test('hours without pesos renders NO line — the fold is gated on a rate', () => {
  const p = juliarPayload();
  // `pay_php` is 0 when no rate resolved even though hours ≠ 0. A line reading
  // "0.08h ₱0.00" would assert a correction the pay never received.
  p.time_adjustment = { hours: 0.08, pay_php: 0, days: [{ date: '2026-09-10', hours: 0.08 }] };
  (p.pay_php as Record<string, number>).initial = 10638.29;
  (p.pay_php as Record<string, number>).final = 14188.29;
  assert.equal(showsTimeAdjustmentLine(mapPayloadToPayStub(p)), false);
});

test('a negative adjustment renders and still reconciles', () => {
  const p = juliarPayload();
  p.time_adjustment = { hours: -0.5, pay_php: -140, days: [{ date: '2026-09-09', hours: -0.5 }] };
  (p.pay_php as Record<string, number>).initial = 10498.29;
  (p.pay_php as Record<string, number>).final = 14048.29;
  const view = mapPayloadToPayStub(p);
  assert.equal(showsTimeAdjustmentLine(view), true);
  assert.equal(lineSum(view), view.totalPayPhp);
  assert.match(formatTimeAdjustmentDetail(view.timeAdjustment), /^−0\.50h · Sep 9, 2026$/);
});

test('the detail names the hours and every day that earned them, oldest first', () => {
  const block = parseTimeAdjustmentBlock({
    time_adjustment: {
      hours: 1.5,
      pay_php: 420,
      days: [
        { date: '2026-09-17', hours: 0.5 },
        { date: '2026-09-15', hours: 1 },
      ],
    },
  });
  assert.deepEqual(
    block?.days.map((d) => d.date),
    ['2026-09-15', '2026-09-17'],
  );
  assert.equal(formatTimeAdjustmentDetail(block), '+1.50h · Sep 15, 2026 · Sep 17, 2026');
});

test('a block with no usable days still states the hours', () => {
  const block = parseTimeAdjustmentBlock({ time_adjustment: { hours: 0.08, pay_php: 23.33, days: [] } });
  assert.equal(formatTimeAdjustmentDetail(block), '+0.08h');
});

test('a malformed days entry is dropped, never rendered as a blank date', () => {
  const block = parseTimeAdjustmentBlock({
    time_adjustment: { hours: 1, pay_php: 280, days: [{ hours: 1 }, { date: '2026-09-16', hours: 1 }] },
  });
  assert.deepEqual(block?.days, [{ date: '2026-09-16', hours: 1 }]);
});

// The weekend rows and the proration chip each shipped in-app while the emailed
// copy stayed stale, so the employee read one breakdown in their Pay Stubs tab
// and another in their inbox for the same payment. This pins the pair.
test('the emailed statement carries the same line and the same detail string', () => {
  const view = mapPayloadToPayStub(juliarPayload());
  const html = renderPayStubEmailHtml(view);
  assert.ok(html.includes('Time Adjustment'), 'email is missing the Time Adjustment line');
  assert.ok(html.includes(formatTimeAdjustmentDetail(view.timeAdjustment)), 'email detail differs from the component');
  // The email escapes the peso sign to an entity (`&#8369;`), so assert the
  // shape the client actually receives rather than the component's literal.
  assert.ok(html.includes('&#8369;23.33'), 'email is missing the adjustment amount');
});

test('the emailed statement gains NO line for a pre-block payload', () => {
  const p = juliarPayload();
  delete p.time_adjustment;
  assert.equal(renderPayStubEmailHtml(mapPayloadToPayStub(p)).includes('Time Adjustment'), false);
});
