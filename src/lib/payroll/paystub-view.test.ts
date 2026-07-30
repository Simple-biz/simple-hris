import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapPayloadToPayStub,
  deriveWeekendFields,
  parseWeekendBlock,
  WEEKEND_PREMIUM_PHP_PER_HOUR,
} from './paystub-view';

// ── HSL "Weekend Hours" on the paystub (2026-07-30) ─────────────────────────
// The Employee Dashboard modal, the Accounting stub viewer and the Pay Stubs
// tab all render `GET /api/…/paystub` responses built by `mapPayloadToPayStub`.
// HSL payloads now carry a `weekend` block carving Sat+Sun out of the
// regular/OT figures; everything staged BEFORE the block existed (and every
// non-HSL payload) must keep rendering byte-identical. These tests pin both
// sides, plus the arithmetic invariant that makes the split safe: the four
// earnings lines always sum back to the original two.

/** A staged HSL payload the way the wizard builds it: Mon–Thu 8h/day, Fri 6h,
 *  Sat 4h (2h regular hits the 40h cap, 2h OT). Rate ₱225 / OT ₱337.50.
 *  regular pay = 40h×225 + 2h weekend-reg premium (₱30) = 9,030
 *  OT pay      = 2h×337.5 + 2h weekend-OT premium (₱30) =   705
 *  weekend     = 2h reg @ ₱240 = 480 · 2h OT @ ₱352.50 = 705 */
function hslPayload(): Record<string, unknown> {
  return {
    name: 'Harvey Specter',
    email: 'harvey@simple.biz',
    department_name: 'Hogan Smith Law',
    hours: { total: 44, regular: 40, ot: 2 },
    weekend: {
      hours: { regular: 2, ot: 2 },
      pay_php: { regular: 480, ot: 705 },
      premium_php_per_hour: 15,
    },
    rates_php: { regular: 225, ot: 337.5 },
    pay_php: {
      regular: 9030,
      ot: 705,
      initial: 9735,
      bonuses_total: 0,
      perfect_attendance_bonus: 0,
      tech_bonus: 0,
      other_bonuses: 0,
      adjustment: 0,
      mesa_deduction: 100,
      mesa_disbursement: 0,
      orphanage_pay: 0,
      final: 9635,
    },
    pay_period: {
      week: { start: '2026-07-20', end: '2026-07-26' },
      fx_rate: 56,
    },
  };
}

test('HSL payload: weekend block splits the earnings lines', () => {
  const v = mapPayloadToPayStub(hslPayload());
  assert.equal(v.hasWeekend, true);
  // Full totals untouched — every summing consumer keeps working.
  assert.equal(v.mfHours, 40);
  assert.equal(v.mfOtHours, 2);
  assert.equal(v.mfPay, 9030);
  assert.equal(v.otPay, 705);
  // Weekend lines: hours at (base + ₱15).
  assert.equal(v.weekendHours, 2);
  assert.equal(v.weekendOtHours, 2);
  assert.equal(v.weekendRate, 240);
  assert.equal(v.weekendOtRate, 352.5);
  assert.equal(v.weekendPay, 480);
  assert.equal(v.weekendOtPay, 705);
  // Weekday lines: the remainder, derived by subtraction.
  assert.equal(v.weekdayHours, 38);
  assert.equal(v.weekdayOtHours, 0);
  assert.equal(v.weekdayPay, 8550); // 38h × 225 — exact
  assert.equal(v.weekdayOtPay, 0); // all OT fell on the weekend
});

test('the four earnings lines sum exactly to the original two (and to final)', () => {
  const p = hslPayload();
  const v = mapPayloadToPayStub(p);
  const earnings = v.weekdayPay + v.weekdayOtPay + v.weekendPay + v.weekendOtPay;
  assert.equal(Math.round(earnings * 100) / 100, Math.round((v.mfPay + v.otPay) * 100) / 100);
  const final =
    earnings +
    v.techBonus +
    v.attendanceBonus +
    v.performanceBonus +
    v.adjustment +
    v.orphanagePay -
    v.mesaDeduction +
    v.mesaDisbursement;
  assert.equal(Math.round(final * 100) / 100, v.totalPayPhp);
});

test('rounding residue lands on the weekday line, never on the total', () => {
  // Staged weekend pay computed on a different rounding path than the full
  // figures: regular 9,030.01 with a weekend line of 480.005 → weekday must be
  // the exact difference (2dp), so weekday + weekend still equals the total.
  const p = hslPayload();
  (p.pay_php as Record<string, unknown>).regular = 9030.01;
  (p.weekend as Record<string, Record<string, unknown>>).pay_php.regular = 480.0;
  const v = mapPayloadToPayStub(p);
  assert.equal(v.weekdayPay, 8550.01);
  assert.equal(
    Math.round((v.weekdayPay + v.weekendPay) * 100) / 100,
    Math.round(v.mfPay * 100) / 100,
  );
});

// ── Back-compat: everything that exists today keeps rendering identically ───

test('legacy payload (staged before the weekend block existed) is untouched', () => {
  const p = hslPayload();
  delete p.weekend;
  const v = mapPayloadToPayStub(p);
  assert.equal(v.hasWeekend, false);
  assert.equal(v.weekendHours, 0);
  assert.equal(v.weekendOtHours, 0);
  assert.equal(v.weekendPay, 0);
  assert.equal(v.weekendOtPay, 0);
  // Weekday mirrors the full figures → the classic two-line statement.
  assert.equal(v.weekdayHours, v.mfHours);
  assert.equal(v.weekdayOtHours, v.mfOtHours);
  assert.equal(v.weekdayPay, v.mfPay);
  assert.equal(v.weekdayOtPay, v.otPay);
});

test('non-HSL payload (weekend: null) renders the classic two lines', () => {
  const p = hslPayload();
  p.weekend = null;
  const v = mapPayloadToPayStub(p);
  assert.equal(v.hasWeekend, false);
  assert.equal(v.weekdayPay, v.mfPay);
  assert.equal(v.weekdayOtPay, v.otPay);
});

test('classic fields are byte-identical with and without the weekend block', () => {
  const withBlock = mapPayloadToPayStub(hslPayload());
  const p = hslPayload();
  delete p.weekend;
  const withoutBlock = mapPayloadToPayStub(p);
  for (const k of [
    'name', 'department', 'weekStart', 'weekEnd', 'weekHuman', 'salaryDate',
    'mfHours', 'mfOtHours', 'mfRate', 'otRate', 'mfPay', 'otPay',
    'techBonus', 'attendanceBonus', 'performanceBonus', 'adjustment',
    'orphanagePay', 'mesaDisbursement', 'mesaDeduction',
    'totalPayPhp', 'fxRate', 'totalPayUsd',
  ] as const) {
    assert.deepEqual(withBlock[k], withoutBlock[k], `field ${k} drifted`);
  }
});

// ── Edge shapes the queue/jsonb can serve ────────────────────────────────────

test('an HSL week with no weekend hours: block present, weekend lines zero', () => {
  const p = hslPayload();
  p.weekend = {
    hours: { regular: 0, ot: 0 },
    pay_php: { regular: 0, ot: 0 },
    premium_php_per_hour: 15,
  };
  const v = mapPayloadToPayStub(p);
  assert.equal(v.hasWeekend, true); // rows render (₱0.00), like the other always-on lines
  assert.equal(v.weekendHours, 0);
  assert.equal(v.weekendPay, 0);
  assert.equal(v.weekdayPay, v.mfPay);
  assert.equal(v.weekdayHours, v.mfHours);
});

test('jsonb string round-trip: numeric strings coerce like every other field', () => {
  const p = hslPayload();
  p.weekend = {
    hours: { regular: '2', ot: '2' },
    pay_php: { regular: '480', ot: '705' },
    premium_php_per_hour: '15',
  };
  const v = mapPayloadToPayStub(p);
  assert.equal(v.weekendHours, 2);
  assert.equal(v.weekendPay, 480);
  assert.equal(v.weekendOtPay, 705);
  assert.equal(v.weekdayPay, 8550);
});

test('missing premium field falls back to ₱15/h', () => {
  const p = hslPayload();
  p.weekend = { hours: { regular: 2, ot: 0 }, pay_php: { regular: 480, ot: 0 } };
  const v = mapPayloadToPayStub(p);
  assert.equal(v.weekendRate, 225 + WEEKEND_PREMIUM_PHP_PER_HOUR);
});

test('null weekend pay (no-rate row) renders ₱0 weekend money, weekday keeps the total', () => {
  const p = hslPayload();
  p.weekend = {
    hours: { regular: 2, ot: 0 },
    pay_php: { regular: null, ot: null },
    premium_php_per_hour: 15,
  };
  const v = mapPayloadToPayStub(p);
  assert.equal(v.weekendPay, 0);
  assert.equal(v.weekdayPay, v.mfPay);
});

test('corrupt block (weekend hours exceed the total) clamps hours at zero, never negative', () => {
  const p = hslPayload();
  p.weekend = {
    hours: { regular: 60, ot: 10 },
    pay_php: { regular: 480, ot: 0 },
    premium_php_per_hour: 15,
  };
  const v = mapPayloadToPayStub(p);
  assert.equal(v.weekdayHours, 0);
  assert.equal(v.weekdayOtHours, 0);
});

// ── The shared derivation helpers directly ──────────────────────────────────

test('parseWeekendBlock: absent / null / non-object all mean "no block"', () => {
  assert.equal(parseWeekendBlock({}), null);
  assert.equal(parseWeekendBlock({ weekend: null }), null);
  assert.equal(parseWeekendBlock({ weekend: 'yes' }), null);
  assert.equal(parseWeekendBlock(null), null);
  assert.equal(parseWeekendBlock(undefined), null);
});

test('parseWeekendBlock: normalizes a full block', () => {
  const w = parseWeekendBlock(hslPayload());
  assert.deepEqual(w, { hours: 2, otHours: 2, pay: 480, otPay: 705, premiumPerHour: 15 });
});

test('deriveWeekendFields: null weekend mirrors the base figures', () => {
  const base = { mfHours: 40, mfOtHours: 2, mfRate: 225, otRate: 337.5, mfPay: 9000, otPay: 675 };
  const d = deriveWeekendFields(base, null);
  assert.equal(d.hasWeekend, false);
  assert.equal(d.weekdayHours, 40);
  assert.equal(d.weekdayPay, 9000);
  assert.equal(d.weekendRate, 0);
});

test('deriveWeekendFields: a custom premium moves the weekend rates', () => {
  const base = { mfHours: 40, mfOtHours: 0, mfRate: 200, otRate: 300, mfPay: 8040, otPay: 0 };
  const d = deriveWeekendFields(base, { hours: 2, otHours: 0, pay: 440, otPay: 0, premiumPerHour: 20 });
  assert.equal(d.weekendRate, 220);
  assert.equal(d.weekendOtRate, 320);
  assert.equal(d.weekdayPay, 7600);
});
