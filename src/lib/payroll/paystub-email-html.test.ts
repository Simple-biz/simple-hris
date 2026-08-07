import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPayloadToPayStub, type PayStubView } from './paystub-view';
import { renderPayStubEmailHtml, payStubEmailSubject } from './paystub-email-html';

// ── The emailed statement (2026-08-06) ──────────────────────────────────────
// The email used to be hand-written HTML inside the n8n Gmail node, mapped off a
// flat `pay_vars` Set node. It fell behind the app: no Weekend rows, no
// Orphanage line, no proration chip, no COP equivalent — so an employee's email
// and their Pay Stubs tab described the same payment differently. The document
// is now rendered here, from the same `PayStubView` the wizard preview and the
// in-app statement render. These tests pin the parts that drifted, plus the
// escaping, because this HTML is built by string concatenation around payroll
// data an operator typed.

/** A plain non-HSL week: no weekend carve-out, no orphanage, no proration. */
function plainPayload(): Record<string, unknown> {
  return {
    name: 'Roselyn Agrito',
    email: 'roselynag@simple.biz',
    personal_email: 'roselynagrito@gmail.com',
    department_name: 'Lead Gen',
    hours: { regular: 33.87, ot: 0, total: 33.87 },
    rates_php: { regular: 175, ot: 262.5 },
    pay_php: {
      regular: 5927.2,
      ot: 0,
      final: 5927.2,
      adjustment: 0,
      tech_bonus: 0,
      other_bonuses: 0,
      orphanage_pay: 0,
      mesa_deduction: 0,
      mesa_disbursement: 0,
      perfect_attendance_bonus: 0,
    },
    pay_period: {
      week: { start: '2026-07-12', end: '2026-07-18' },
      fx_rate: 61.67,
      currency: 'PHP',
    },
  };
}

/** An HSL week carrying the Sat+Sun carve-out (premium ₱15/h over base). */
function hslPayload(): Record<string, unknown> {
  const p = plainPayload();
  p.name = 'Harvey Specter';
  p.department_name = 'Hogan Smith Law';
  p.hours = { regular: 40, ot: 2, total: 42 };
  p.rates_php = { regular: 225, ot: 337.5 };
  p.pay_php = {
    ...(p.pay_php as Record<string, unknown>),
    regular: 9030,
    ot: 705,
    final: 9735,
  };
  p.weekend = {
    hours: { regular: 2, ot: 2 },
    pay_php: { regular: 480, ot: 705 },
    premium_php_per_hour: 15,
  };
  return p;
}

const render = (p: Record<string, unknown>) => renderPayStubEmailHtml(mapPayloadToPayStub(p));

/* ───────────────────────────── weekend rows ───────────────────────────── */

test('HSL week renders ONE merged Weekend Hours row with the per-rate basis', () => {
  const html = render(hslPayload());
  assert.ok(html.includes('Weekend Hours'), 'expected a Weekend Hours row');
  assert.ok(!html.includes('Weekend Overtime'), 'the OT bucket folds into Weekend Hours');
  // Merged Sat+Sun hours and money…
  assert.ok(html.includes('4.00h'), 'merged weekend hours (2 regular-bucket + 2 OT-bucket)');
  assert.ok(html.includes('&#8369;1,185.00'), 'merged weekend amount (480 + 705)');
  // …with the two-rate basis keeping the arithmetic explicable.
  assert.ok(html.includes('&#8369;240.00'), 'regular-bucket rate ₱225 + ₱15');
  assert.ok(html.includes('&#8369;352.50'), 'OT-bucket rate ₱337.50 + ₱15');
  assert.ok(!html.includes('&#8369;480.00'), 'bucket subtotals are not printed as amounts');
});

test('a weekend that is entirely OT-bucket renders a single-rate Weekend Hours line', () => {
  // The common HSL full-timer week: the 40h cap fills Mon–Fri, so every Sat/Sun
  // hour lands in the OT bucket. ONE weekend line at the OT-bucket rate — no
  // ₱0.00 "Weekend Overtime" sibling, no multi-rate basis.
  const p = hslPayload();
  p.weekend = {
    hours: { regular: 0, ot: 2 },
    pay_php: { regular: 0, ot: 705 },
    premium_php_per_hour: 15,
  };
  (p.pay_php as Record<string, unknown>).regular = 9000; // no weekend money in the regular bucket
  const html = render(p);
  assert.ok(html.includes('Weekend Hours'), 'expected the merged Weekend Hours row');
  assert.ok(!html.includes('Weekend Overtime'), 'no separate Weekend Overtime row');
  assert.ok(html.includes('2.00h'), 'the OT-bucket hours carry the line');
  assert.ok(html.includes('&#8369;352.50'), 'classic single-rate detail at ₱337.50 + ₱15');
  assert.ok(html.includes('&#8369;705.00'), 'the staged weekend amount');
});

test('non-HSL week renders NO weekend rows', () => {
  const html = render(plainPayload());
  assert.ok(!html.includes('Weekend'), 'a non-Hogan statement must not mention Weekend');
});

test('weekday lines carry the weekday-only portion when a weekend exists', () => {
  const html = render(hslPayload());
  // Regular = 40h total − 2h weekend = 38h; pay 9,030 − 480 = 8,550.
  assert.ok(html.includes('38.00h'), 'Regular Hours should show the weekday hours');
  assert.ok(html.includes('&#8369;8,550.00'), 'Regular pay should be net of the weekend');
});

/* ───────────────────────────── orphanage row ───────────────────────────── */

test('Orphanage row is omitted when there is no orphanage pay', () => {
  const html = render(plainPayload());
  assert.ok(!html.includes('Orphanage'), 'a ₱0.00 Orphanage row must not render');
});

test('Orphanage row renders, signed and teal, when there is money on it', () => {
  const p = plainPayload();
  (p.pay_php as Record<string, unknown>).orphanage_pay = 1250;
  const html = render(p);
  assert.ok(html.includes('Orphanage'), 'expected the Orphanage row');
  assert.ok(html.includes('+&#8369;1,250.00'), 'orphanage should be a signed addition');
  assert.ok(html.includes('#0f766e'), 'orphanage amount should be teal');
});

/* ─────────────────── rows that always render, ₱0.00 included ─────────────── */

test('the always-on lines render even at zero, so the breakdown reconciles', () => {
  const html = render(plainPayload());
  for (const label of [
    'Regular Hours',
    'Overtime',
    'Tech Allowance',
    'Attendance Incentive',
    'Performance Bonus',
    'Adjustment',
    'MESA Reimbursement',
    'MESA Deduction',
  ]) {
    assert.ok(html.includes(label), `${label} must always render`);
  }
});

/* ────────────────────────────── proration ────────────────────────────── */

test('a line paid at two rates gets the chip, the arrow and the hour basis', () => {
  const p = plainPayload();
  p.hours = { regular: 40, ot: 0, total: 40 };
  (p.pay_php as Record<string, unknown>).regular = 8000;
  p.proration = {
    effective_date: '2026-07-15',
    old_rates_php: { regular: 175, ot: 262.5 },
    new_rates_php: { regular: 225, ot: 337.5 },
    segments: {
      regular: [
        { rate_php: 175, hours: 16.25, pay_php: 2843.75 },
        { rate_php: 225, hours: 23.75, pay_php: 5343.75 },
      ],
      ot: [],
      weekend_regular: [],
      weekend_ot: [],
    },
  };
  const html = render(p);
  assert.ok(html.includes('Prorated'), 'expected the Prorated chip');
  assert.ok(html.includes('&rarr;'), 'expected the ₱old → ₱new arrow');
  assert.ok(html.includes('16.25h'), 'expected the previous-rate hour basis');
  assert.ok(html.includes('23.75h'), 'expected the current-rate hour basis');
  assert.ok(html.includes('effective Jul 15'), 'expected the effective date');
});

test('a single-rate week renders no chip', () => {
  assert.ok(!render(plainPayload()).includes('Prorated'));
});

/* ──────────────────────── totals, COP, paid pill ──────────────────────── */

test('Total Net Pay shows PHP and the USD equivalent', () => {
  const html = render(plainPayload());
  assert.ok(html.includes('&#8369;5,927.20'), 'PHP net');
  assert.ok(html.includes('$96.11 USD'), 'USD equivalent at the payload fx rate');
  assert.ok(!html.includes('COP equivalent'), 'no COP line for a non-Colombian payee');
});

test('a COP-country payee gets the native COP line', () => {
  const view: PayStubView = { ...mapPayloadToPayStub(plainPayload()), totalPayCop: 526686 };
  const html = renderPayStubEmailHtml(view);
  assert.ok(html.includes('COP equivalent'), 'expected the COP row');
  assert.ok(html.includes('$COP526.686'), 'COP renders with es-CO dot grouping');
});

test('the paid pill reflects the dispatch status', () => {
  const view = mapPayloadToPayStub(plainPayload());
  const paid = renderPayStubEmailHtml(view, { paidAt: '2026-07-20', status: 'paid' });
  assert.ok(paid.includes('Paid Jul 20, 2026'), 'a paid stub names the date');

  // A resolved pay date is non-null for money that has NOT moved yet — status,
  // not the date, decides the pill, exactly as in PayStubStatement.
  const pending = renderPayStubEmailHtml(view, { paidAt: '2026-07-20', status: 'issued' });
  assert.ok(pending.includes('Pending'), 'an unpaid stub reads Pending');
  assert.ok(!pending.includes('Paid Jul 20'), 'an unpaid stub must not claim it was paid');

  // No status at all (a preview send) keeps the classic confidentiality line.
  assert.ok(renderPayStubEmailHtml(view).includes('Confidential pay record'));
});

/* ────────────────────────────── escaping ────────────────────────────── */

test('operator-typed text is escaped, never injected as markup', () => {
  const p = plainPayload();
  p.name = 'Ana <script>alert(1)</script> & Co';
  p.adjustment_note = 'Refund for "June" <b>overtime</b>';
  const html = render(p);
  assert.ok(!html.includes('<script>'), 'a name must not open a tag');
  assert.ok(html.includes('&lt;script&gt;'), 'the name is escaped');
  assert.ok(html.includes('&amp; Co'), 'ampersands are escaped, not doubled');
  assert.ok(!html.includes('<b>overtime</b>'), 'an adjustment note must not inject markup');
  assert.ok(html.includes('&quot;June&quot;'), 'quotes in the note are escaped');
});

test('every peso sign is emitted as an entity, so transcoding cannot mangle it', () => {
  const html = render(plainPayload());
  assert.ok(!html.includes('₱'), 'no raw peso glyph should survive into the email body');
});

/* ─────────────────────────────── subject ─────────────────────────────── */

test('the subject names the recipient and the week', () => {
  const view = mapPayloadToPayStub(plainPayload());
  assert.equal(payStubEmailSubject(view), 'Paystub for Roselyn Agrito · Jul 12 – Jul 18, 2026');
});

test('a nameless payload still produces a usable subject', () => {
  const p = plainPayload();
  p.name = '';
  assert.equal(payStubEmailSubject(mapPayloadToPayStub(p)), 'Paystub · Jul 12 – Jul 18, 2026');
});

/* ───────────────────── the document is well-formed ───────────────────── */

test('renders one complete html document', () => {
  const html = render(hslPayload());
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.trimEnd().endsWith('</html>'));
  // Balanced enough that a client won't drop half the statement.
  const open = (html.match(/<table/g) ?? []).length;
  const close = (html.match(/<\/table>/g) ?? []).length;
  assert.equal(open, close, 'every <table> must be closed');
});
