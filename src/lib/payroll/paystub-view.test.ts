import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapPayloadToPayStub,
  deriveWeekendFields,
  parseWeekendBlock,
  parseProrationBlock,
  deriveProrationFields,
  WEEKEND_PREMIUM_PHP_PER_HOUR,
} from './paystub-view';

// ── HSL "Weekend Hours" on the paystub (2026-07-30; merged single row 2026-08-07) ──
// The Employee Dashboard modal, the Accounting stub viewer and the Pay Stubs
// tab all render `GET /api/…/paystub` responses built by `mapPayloadToPayStub`.
// HSL payloads carry a `weekend` block carving Sat+Sun out of the regular/OT
// figures; everything staged BEFORE the block existed (and every non-HSL
// payload) must keep rendering byte-identical. Since 2026-08-07 the statement
// shows ONE merged "Weekend Hours" row (no "Weekend Overtime" sibling) whose
// `weekendBasis` itemizes hours per premium-inclusive rate. These tests pin
// both sides, plus the arithmetic invariant that makes the split safe: the
// three earnings lines always sum back to the original two.

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

test('HSL payload: weekend block merges into ONE Weekend Hours line', () => {
  const v = mapPayloadToPayStub(hslPayload());
  assert.equal(v.hasWeekend, true);
  // Full totals untouched — every summing consumer keeps working.
  assert.equal(v.mfHours, 40);
  assert.equal(v.mfOtHours, 2);
  assert.equal(v.mfPay, 9030);
  assert.equal(v.otPay, 705);
  // ONE merged weekend line: both buckets' hours and money, with a per-rate
  // basis so the amount stays explicable arithmetic (the buckets pay at
  // different premium-inclusive rates).
  assert.equal(v.weekendHours, 4); // 2 regular-bucket + 2 OT-bucket
  assert.equal(v.weekendPay, 1185); // 480 + 705
  assert.deepEqual(v.weekendBasis, [
    { ratePhp: 240, hours: 2 }, // base 225 + ₱15
    { ratePhp: 352.5, hours: 2 }, // OT 337.50 + ₱15
  ]);
  // Weekday lines: the remainder, derived by subtraction — unchanged.
  assert.equal(v.weekdayHours, 38);
  assert.equal(v.weekdayOtHours, 0);
  assert.equal(v.weekdayPay, 8550); // 38h × 225 — exact
  assert.equal(v.weekdayOtPay, 0); // all OT fell on the weekend
});

test('the three earnings lines sum exactly to the original two (and to final)', () => {
  const p = hslPayload();
  const v = mapPayloadToPayStub(p);
  const earnings = v.weekdayPay + v.weekdayOtPay + v.weekendPay;
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
    Math.round((v.weekdayPay + v.weekdayOtPay + v.weekendPay) * 100) / 100,
    Math.round((v.mfPay + v.otPay) * 100) / 100,
  );
});

// ── Back-compat: everything that exists today keeps rendering identically ───

test('legacy payload (staged before the weekend block existed) is untouched', () => {
  const p = hslPayload();
  delete p.weekend;
  const v = mapPayloadToPayStub(p);
  assert.equal(v.hasWeekend, false);
  assert.equal(v.weekendHours, 0);
  assert.equal(v.weekendPay, 0);
  assert.deepEqual(v.weekendBasis, []);
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

test('an HSL week with no weekend hours: block present, weekend line zero', () => {
  const p = hslPayload();
  p.weekend = {
    hours: { regular: 0, ot: 0 },
    pay_php: { regular: 0, ot: 0 },
    premium_php_per_hour: 15,
  };
  const v = mapPayloadToPayStub(p);
  assert.equal(v.hasWeekend, true); // the row renders (₱0.00), like the other always-on lines
  assert.equal(v.weekendHours, 0);
  assert.equal(v.weekendPay, 0);
  // A zero-hours line still shows a rate, exactly as before the merge.
  assert.deepEqual(v.weekendBasis, [{ ratePhp: 240, hours: 0 }]);
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
  assert.equal(v.weekendHours, 4);
  assert.equal(v.weekendPay, 1185);
  assert.equal(v.weekdayPay, 8550);
});

test('missing premium field falls back to ₱15/h', () => {
  const p = hslPayload();
  p.weekend = { hours: { regular: 2, ot: 0 }, pay_php: { regular: 480, ot: 0 } };
  const v = mapPayloadToPayStub(p);
  assert.equal(v.weekendBasis[0]?.ratePhp, 225 + WEEKEND_PREMIUM_PHP_PER_HOUR);
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
  assert.deepEqual(d.weekendBasis, []);
});

test('deriveWeekendFields: a custom premium moves both basis rates', () => {
  const base = { mfHours: 40, mfOtHours: 1, mfRate: 200, otRate: 300, mfPay: 8040, otPay: 320 };
  const d = deriveWeekendFields(base, { hours: 2, otHours: 1, pay: 440, otPay: 320, premiumPerHour: 20 });
  assert.equal(d.weekendHours, 3);
  assert.equal(d.weekendPay, 760);
  assert.deepEqual(d.weekendBasis, [
    { ratePhp: 220, hours: 2 },
    { ratePhp: 320, hours: 1 },
  ]);
  assert.equal(d.weekdayPay, 7600);
  assert.equal(d.weekdayOtPay, 0);
});

test('deriveWeekendFields: a single-bucket weekend has a single-entry basis', () => {
  const base = { mfHours: 40, mfOtHours: 6, mfRate: 355, otRate: 532.5, mfPay: 14200, otPay: 3285 };
  // All Sat/Sun hours landed past the 40h cap — the common HSL full-timer case.
  const d = deriveWeekendFields(base, { hours: 0, otHours: 6, pay: 0, otPay: 3285, premiumPerHour: 15 });
  assert.equal(d.weekendHours, 6);
  assert.equal(d.weekendPay, 3285);
  assert.deepEqual(d.weekendBasis, [{ ratePhp: 547.5, hours: 6 }]);
  assert.equal(d.weekdayOtHours, 0);
  assert.equal(d.weekdayOtPay, 0);
});

// ── Mid-week transfer proration (2026-07-30) ─────────────────────────────────
// A transfer effective mid-week pays a line at two rates. The payload's
// `proration` block carries the per-rate segments the wizard's engine computed;
// the view exposes, PER LINE, the previous→current rate pair + the hour basis —
// only for lines whose money genuinely spanned two rates (single-rate lines
// keep the classic render, no chip). No extra earnings rows, ever.

/** The approved mock: Juan Dela Cruz, Sales Assistant → PM Team eff. Wed Jul 22.
 *  Regular 40h = 16.25h @175 + 23.75h @225 = ₱8,187.50 · OT 2.5h all @281.25. */
function proratedPayload(): Record<string, unknown> {
  return {
    name: 'Juan Dela Cruz',
    email: 'juan@simple.biz',
    department_name: 'PM Team',
    hours: { total: 42.5, regular: 40, ot: 2.5 },
    weekend: null,
    rates_php: { regular: 225, ot: 281.25 },
    pay_php: {
      regular: 8187.5,
      ot: 703.13,
      initial: 8890.63,
      bonuses_total: 0,
      perfect_attendance_bonus: 0,
      tech_bonus: 0,
      other_bonuses: 0,
      adjustment: 0,
      mesa_deduction: 100,
      mesa_disbursement: 0,
      orphanage_pay: 0,
      final: 8790.63,
    },
    proration: {
      effective_date: '2026-07-22',
      old_rates_php: { regular: 175, ot: 218.75 },
      new_rates_php: { regular: 225, ot: 281.25 },
      segments: {
        regular: [
          { rate_php: 175, hours: 16.25, pay_php: 2843.75 },
          { rate_php: 225, hours: 23.75, pay_php: 5343.75 },
        ],
        ot: [{ rate_php: 281.25, hours: 2.5, pay_php: 703.13 }],
        weekend_regular: [],
        weekend_ot: [],
      },
    },
    pay_period: {
      week: { start: '2026-07-19', end: '2026-07-25' },
      fx_rate: 58,
    },
  };
}

test('prorated payload: the two-rate line carries previous→current + hour basis', () => {
  const v = mapPayloadToPayStub(proratedPayload());
  assert.ok(v.proration, 'proration view must exist');
  assert.equal(v.proration.effectiveDate, '2026-07-22');
  assert.equal(v.proration.effectiveHuman, 'Jul 22');
  assert.deepEqual(v.proration.regular, {
    previousRate: 175,
    currentRate: 225,
    segments: [
      { ratePhp: 175, hours: 16.25 },
      { ratePhp: 225, hours: 23.75 },
    ],
  });
});

test('prorated payload: a line paid at ONE rate renders classic (no chip)', () => {
  const v = mapPayloadToPayStub(proratedPayload());
  assert.equal(v.proration?.ot, null);
  assert.equal(v.proration?.weekend, null);
});

test('payload without a proration block (or null) has no proration view', () => {
  const p = proratedPayload();
  delete p.proration;
  assert.equal(mapPayloadToPayStub(p).proration, null);
  const p2 = proratedPayload();
  p2.proration = null;
  assert.equal(mapPayloadToPayStub(p2).proration, null);
});

test('a block whose lines are ALL single-rate yields no proration view at all', () => {
  const p = proratedPayload();
  (p.proration as Record<string, unknown>).segments = {
    regular: [{ rate_php: 225, hours: 40, pay_php: 9000 }],
    ot: [{ rate_php: 281.25, hours: 2.5, pay_php: 703.13 }],
    weekend_regular: [],
    weekend_ot: [],
  };
  assert.equal(mapPayloadToPayStub(p).proration, null);
});

test('classic fields are byte-identical with and without the proration block', () => {
  const withBlock = mapPayloadToPayStub(proratedPayload());
  const p = proratedPayload();
  delete p.proration;
  const withoutBlock = mapPayloadToPayStub(p);
  for (const k of [
    'name', 'department', 'weekStart', 'weekEnd', 'weekHuman', 'salaryDate',
    'mfHours', 'mfOtHours', 'mfRate', 'otRate', 'mfPay', 'otPay',
    'hasWeekend', 'weekdayHours', 'weekdayOtHours', 'weekdayPay', 'weekdayOtPay',
    'techBonus', 'attendanceBonus', 'performanceBonus', 'adjustment',
    'orphanagePay', 'mesaDisbursement', 'mesaDeduction',
    'totalPayPhp', 'fxRate', 'totalPayUsd',
  ] as const) {
    assert.deepEqual(withBlock[k], withoutBlock[k], `field ${k} drifted`);
  }
});

test('jsonb string round-trip: proration numbers coerce like every other field', () => {
  const p = proratedPayload();
  (p.proration as Record<string, unknown>).segments = {
    regular: [
      { rate_php: '175', hours: '16.25', pay_php: '2843.75' },
      { rate_php: '225', hours: '23.75', pay_php: '5343.75' },
    ],
    ot: [],
    weekend_regular: [],
    weekend_ot: [],
  };
  const v = mapPayloadToPayStub(p);
  assert.deepEqual(v.proration?.regular?.segments, [
    { ratePhp: 175, hours: 16.25 },
    { ratePhp: 225, hours: 23.75 },
  ]);
});

// HSL: the statement's Regular/Overtime rows show the WEEKDAY portion, so the
// basis must be weekday-scoped too — full segments minus the weekend carve-out,
// per rate. The merged Weekend line takes its basis from the block's per-day
// weekend segments (at rate + premium) and chips only when a BUCKET genuinely
// spanned the change.

test('HSL prorated week: regular basis is weekday-scoped (full minus weekend, per rate)', () => {
  const p = proratedPayload();
  p.weekend = {
    hours: { regular: 4, ot: 0 },
    pay_php: { regular: 960, ot: 0 },
    premium_php_per_hour: 15,
  };
  (p.proration as Record<string, unknown>).segments = {
    // Mon 8h @175 · Wed 8h @225 · Sat 4h @225(+15): full 225-segment holds 12h.
    regular: [
      { rate_php: 175, hours: 8, pay_php: 1400 },
      { rate_php: 225, hours: 12, pay_php: 2760 },
    ],
    ot: [],
    weekend_regular: [{ rate_php: 225, hours: 4, pay_php: 960 }],
    weekend_ot: [],
  };
  const v = mapPayloadToPayStub(p);
  assert.deepEqual(v.proration?.regular, {
    previousRate: 175,
    currentRate: 225,
    segments: [
      { ratePhp: 175, hours: 8 },
      { ratePhp: 225, hours: 8 },
    ],
  });
  // Weekend money all at one rate → classic weekend row, no chip — and the
  // basis comes from the block's per-day segments (rate + premium).
  assert.equal(v.proration?.weekend, null);
  assert.deepEqual(v.weekendBasis, [{ ratePhp: 240, hours: 4 }]);
});

test('HSL weekday remainder at a single rate renders that line classic', () => {
  const p = proratedPayload();
  p.weekend = {
    hours: { regular: 4, ot: 0 },
    pay_php: { regular: 960, ot: 0 },
    premium_php_per_hour: 15,
  };
  (p.proration as Record<string, unknown>).segments = {
    // The entire new-rate portion sat on the weekend → weekday is old-rate only.
    regular: [
      { rate_php: 175, hours: 8, pay_php: 1400 },
      { rate_php: 225, hours: 4, pay_php: 960 },
    ],
    ot: [],
    weekend_regular: [{ rate_php: 225, hours: 4, pay_php: 960 }],
    weekend_ot: [],
  };
  // Weekday remainder is old-rate only and the weekend line is new-rate only —
  // every DISPLAYED row reconciles at a single rate, so nothing chips: the
  // all-null lines collapse the whole view to null (classic statement).
  assert.equal(mapPayloadToPayStub(p).proration, null);
});

test('HSL weekend line split across the change shows premium-inclusive rates', () => {
  const p = proratedPayload();
  p.weekend = {
    hours: { regular: 8, ot: 0 },
    pay_php: { regular: 1720, ot: 0 },
    premium_php_per_hour: 15,
  };
  (p.proration as Record<string, unknown>).segments = {
    regular: [
      { rate_php: 175, hours: 4, pay_php: 760 },
      { rate_php: 225, hours: 4, pay_php: 960 },
    ],
    ot: [],
    weekend_regular: [
      { rate_php: 175, hours: 4, pay_php: 760 },
      { rate_php: 225, hours: 4, pay_php: 960 },
    ],
    weekend_ot: [],
  };
  const v = mapPayloadToPayStub(p);
  // Sat+Sun spanned the change: the merged weekend line chips, and its basis
  // carries the premium-inclusive rate on each side of the change.
  assert.deepEqual(v.proration?.weekend, {
    previousRate: 190,
    currentRate: 240,
    segments: [
      { ratePhp: 190, hours: 4 },
      { ratePhp: 240, hours: 4 },
    ],
  });
  assert.deepEqual(v.weekendBasis, [
    { ratePhp: 190, hours: 4 },
    { ratePhp: 240, hours: 4 },
  ]);
  // The weekday remainder is empty on both rates → classic regular row.
  assert.equal(v.proration?.regular, null);
});

// ── The whole weekend on ONE side of the change (Kane, 2026-08-07) ──────────
// Reported as "her Weekend hour 250 not 240 — is this math error?". It is not:
// reat@simple.biz worked only Sunday Jul 26, the day BEFORE her ₱235 → ₱225
// change took effect on Mon Jul 27, so the weekend paid ₱235 + ₱15 = ₱250 while
// the statement's headline rate had already moved to ₱225. The arithmetic was
// right and the DISCLOSURE was missing: no bucket "spanned" the change, so the
// old gate chipped nothing and the stub showed a bare `8.10h × ₱250.00` under a
// `31.90h × ₱225.00` regular line with no way to reconcile the two. A weekend
// paid at anything other than the week's CURRENT rate must say so.

test('weekend entirely BEFORE the change still chips — the rate differs from the headline', () => {
  const p = proratedPayload();
  // reat@simple.biz, cycle 2026-07-26 → 08-01, scaled to this fixture's shape.
  p.rates_php = { regular: 225, ot: 337.5 };
  p.weekend = {
    hours: { regular: 8.1, ot: 0 },
    pay_php: { regular: 2024.51, ot: 0 },
    premium_php_per_hour: 15,
  };
  p.proration = {
    effective_date: '2026-07-27',
    old_rates_php: { regular: 235, ot: 352.5 },
    new_rates_php: { regular: 225, ot: 337.5 },
    segments: {
      regular: [
        { rate_php: 235, hours: 8.1, pay_php: 2024.51 },
        { rate_php: 225, hours: 31.9, pay_php: 7177.94 },
      ],
      ot: [{ rate_php: 337.5, hours: 1.68, pay_php: 566.91 }],
      // The whole weekend sits on the OLD side — one segment, so the old
      // "did a bucket span the change?" gate saw nothing to disclose.
      weekend_regular: [{ rate_php: 235, hours: 8.1, pay_php: 2024.51 }],
      weekend_ot: [],
    },
  };
  const v = mapPayloadToPayStub(p);
  // The basis is unchanged — ₱250 is genuinely what those 8.1h paid.
  assert.deepEqual(v.weekendBasis, [{ ratePhp: 250, hours: 8.1 }]);
  // …but the line now carries the chip and the week's rate change, so the
  // reader can see WHY ₱250 is not the headline ₱225 + ₱15.
  assert.deepEqual(v.proration?.weekend, {
    previousRate: 250,
    currentRate: 240,
    segments: [{ ratePhp: 250, hours: 8.1 }],
  });
  assert.equal(v.proration?.effectiveHuman, 'Jul 27');
});

test('weekend entirely AFTER the change stays classic — its rate IS the headline', () => {
  // Mirror image: the weekend paid at the CURRENT rate, so there is nothing
  // unexplained on that line and it must not chip.
  const p = proratedPayload();
  p.weekend = {
    hours: { regular: 8, ot: 0 },
    pay_php: { regular: 1920, ot: 0 },
    premium_php_per_hour: 15,
  };
  (p.proration as Record<string, unknown>).segments = {
    regular: [
      { rate_php: 175, hours: 16.25, pay_php: 2843.75 },
      { rate_php: 225, hours: 23.75, pay_php: 5343.75 },
    ],
    ot: [{ rate_php: 281.25, hours: 2.5, pay_php: 703.13 }],
    weekend_regular: [{ rate_php: 225, hours: 8, pay_php: 1920 }],
    weekend_ot: [],
  };
  const v = mapPayloadToPayStub(p);
  assert.deepEqual(v.weekendBasis, [{ ratePhp: 240, hours: 8 }]);
  assert.equal(v.proration?.weekend, null);
});

test('weekend OT alone on the old side chips against the OT rate pair', () => {
  // The off-headline rate is in the OT bucket, so the disclosed pair must be
  // the OT rates (+ premium) — not the regular ones.
  const p = proratedPayload();
  p.weekend = {
    hours: { regular: 0, ot: 4 },
    pay_php: { regular: 0, ot: 935 },
    premium_php_per_hour: 15,
  };
  (p.proration as Record<string, unknown>).segments = {
    regular: [
      { rate_php: 175, hours: 16.25, pay_php: 2843.75 },
      { rate_php: 225, hours: 23.75, pay_php: 5343.75 },
    ],
    ot: [{ rate_php: 218.75, hours: 4, pay_php: 875 }],
    weekend_regular: [],
    weekend_ot: [{ rate_php: 218.75, hours: 4, pay_php: 935 }],
  };
  const v = mapPayloadToPayStub(p);
  assert.deepEqual(v.proration?.weekend, {
    previousRate: 233.75, // 218.75 + 15
    currentRate: 296.25, //  281.25 + 15
    segments: [{ ratePhp: 233.75, hours: 4 }],
  });
});

test('a reg+OT weekend mix inside a proration week never chips the weekend line', () => {
  // The regular line spans the change (so a proration view exists), but the
  // weekend money is one rate per bucket. Two DIFFERENT rates still appear on
  // the merged weekend line — the ordinary regular/OT mix — and that must not
  // read as a proration: no chip, no "effective" suffix, just the basis.
  const p = proratedPayload();
  p.weekend = {
    hours: { regular: 2, ot: 1 },
    pay_php: { regular: 480, ot: 296.25 },
    premium_php_per_hour: 15,
  };
  (p.proration as Record<string, unknown>).segments = {
    regular: [
      { rate_php: 175, hours: 8, pay_php: 1400 },
      { rate_php: 225, hours: 32, pay_php: 7200 },
    ],
    ot: [{ rate_php: 281.25, hours: 2.5, pay_php: 703.13 }],
    weekend_regular: [{ rate_php: 225, hours: 2, pay_php: 480 }],
    weekend_ot: [{ rate_php: 281.25, hours: 1, pay_php: 296.25 }],
  };
  const v = mapPayloadToPayStub(p);
  assert.ok(v.proration, 'the regular line still carries the proration view');
  assert.equal(v.proration.weekend, null);
  assert.deepEqual(v.weekendBasis, [
    { ratePhp: 240, hours: 2 },
    { ratePhp: 296.25, hours: 1 },
  ]);
});

// ── The shared proration helpers directly ───────────────────────────────────

test('parseProrationBlock: absent / null / non-object all mean "no block"', () => {
  assert.equal(parseProrationBlock({}), null);
  assert.equal(parseProrationBlock({ proration: null }), null);
  assert.equal(parseProrationBlock({ proration: 'yes' }), null);
  assert.equal(parseProrationBlock(null), null);
  assert.equal(parseProrationBlock(undefined), null);
});

test('parseProrationBlock: normalizes a full block, dropping malformed segments', () => {
  const b = parseProrationBlock({
    proration: {
      effective_date: '2026-07-22',
      old_rates_php: { regular: 175, ot: 218.75 },
      new_rates_php: { regular: 225, ot: 281.25 },
      segments: {
        regular: [
          { rate_php: 175, hours: 16.25, pay_php: 2843.75 },
          { rate_php: 'oops', hours: 1, pay_php: 1 }, // malformed → dropped
        ],
        ot: 'nope', // malformed list → empty
        weekend_regular: [],
        weekend_ot: [],
      },
    },
  });
  assert.ok(b);
  assert.equal(b.effectiveDate, '2026-07-22');
  assert.deepEqual(b.oldRates, { regular: 175, ot: 218.75 });
  assert.deepEqual(b.newRates, { regular: 225, ot: 281.25 });
  assert.deepEqual(b.segments.regular, [{ ratePhp: 175, hours: 16.25, payPhp: 2843.75 }]);
  assert.deepEqual(b.segments.ot, []);
});

test('deriveProrationFields: null block → null view', () => {
  assert.equal(deriveProrationFields(null, null), null);
});
