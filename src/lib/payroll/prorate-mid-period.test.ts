import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proratePayForMidPeriodChange } from './prorate-mid-period';
import type { RateHistoryByEmail, RateHistoryRow } from './rate-history-resolve';

// ── Scenario: the approved prorated-paystub mock (department transfer) ───────
// Pay week Sun Jul 19 – Sat Jul 25 2026, non-HSL. Transfer effective Wed Jul 22
// moves the rate ₱175.00 → ₱225.00 (OT 218.75 → 281.25). Hours land so that
// 16.25h of regular time pays at the old rate (Mon+Tue) and 23.75h at the new
// (Wed–Fri), with all 2.50h of OT falling AFTER the change (Fri overflow + Sat):
//
//   Regular = 16.25×175 + 23.75×225 = 2,843.75 + 5,343.75 = ₱8,187.50
//   OT      = 2.50×281.25           = ₱703.13  (single rate — no split)
//
// The engine already paid these amounts correctly; what this file adds is the
// per-rate SEGMENTS (hours + pay at each rate, in pay order) that let a pay
// statement print the basis line "16.25h @ ₱175.00 · 23.75h @ ₱225.00" instead
// of advertising a single rate that cannot explain the amount.

const EMAIL = 'juan@work.example.com';

function historyMap(rows: RateHistoryRow[]): RateHistoryByEmail {
  // resolveRateAsOfDate expects DESC by effectiveFrom.
  const sorted = [...rows].sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  return new Map([[EMAIL, sorted]]);
}

const TRANSFER_HISTORY = historyMap([
  { email: EMAIL, regularRate: 175, otRate: 218.75, effectiveFrom: new Date(2026, 0, 1) },
  { email: EMAIL, regularRate: 225, otRate: 281.25, effectiveFrom: new Date(2026, 6, 22) },
]);

/** Mon 20 8h · Tue 21 8.25h · Wed 22 8h · Thu 23 8h · Fri 24 8.25h · Sat 25 2h = 42.5h */
const TRANSFER_DAYS = [
  { date: new Date(2026, 6, 20), seconds: 8 * 3600 },
  { date: new Date(2026, 6, 21), seconds: 8.25 * 3600 },
  { date: new Date(2026, 6, 22), seconds: 8 * 3600 },
  { date: new Date(2026, 6, 23), seconds: 8 * 3600 },
  { date: new Date(2026, 6, 24), seconds: 8.25 * 3600 },
  { date: new Date(2026, 6, 25), seconds: 2 * 3600 },
];

function transferResult() {
  const r = proratePayForMidPeriodChange({
    days: TRANSFER_DAYS,
    isHsl: false,
    history: TRANSFER_HISTORY,
    histEmail: EMAIL,
    fallbackReg: 225,
    fallbackOt: 281.25,
  });
  assert.ok(r, 'a mid-week rate change must produce a prorated result');
  return r;
}

// ── Pins: behavior that already shipped and must not move ───────────────────

test('mid-week transfer pays old-rate days then new-rate days, rounded once', () => {
  const r = transferResult();
  assert.equal(r.regularPay, 8187.5);
  assert.equal(r.otPay, 703.13);
});

test('mid-week transfer reports the change with its effective date', () => {
  const r = transferResult();
  assert.deepEqual(r.change, {
    oldRegular: 175,
    newRegular: 225,
    oldOt: 218.75,
    newOt: 281.25,
    effectiveDate: '2026-07-22',
  });
});

test('mid-week transfer reports the distinct rates paid, in first-use order', () => {
  const r = transferResult();
  assert.deepEqual(r.regularRatesUsed, [175, 225]);
  assert.deepEqual(r.otRatesUsed, [281.25]);
});

test('constant history rate equal to the cache returns null (single-rate path)', () => {
  const r = proratePayForMidPeriodChange({
    days: TRANSFER_DAYS,
    isHsl: false,
    history: historyMap([
      { email: EMAIL, regularRate: 225, otRate: 281.25, effectiveFrom: new Date(2026, 0, 1) },
    ]),
    histEmail: EMAIL,
    fallbackReg: 225,
    fallbackOt: 281.25,
  });
  assert.equal(r, null);
});

// ── New behavior: per-rate segments for the statement's basis line ──────────

test('segments itemize regular hours and pay at each rate, in pay order', () => {
  const r = transferResult();
  assert.deepEqual(r.segments.regular, [
    { ratePhp: 175, hours: 16.25, payPhp: 2843.75 },
    { ratePhp: 225, hours: 23.75, payPhp: 5343.75 },
  ]);
});

test('an OT line paid entirely at one rate yields a single segment', () => {
  const r = transferResult();
  assert.deepEqual(r.segments.ot, [{ ratePhp: 281.25, hours: 2.5, payPhp: 703.13 }]);
});

test('segments sum back to the prorated line pay exactly', () => {
  const r = transferResult();
  const sum = (xs: Array<{ payPhp: number }>) =>
    Math.round(xs.reduce((s, x) => s + x.payPhp, 0) * 100) / 100;
  assert.equal(sum(r.segments.regular), r.regularPay);
  assert.equal(sum(r.segments.ot), r.otPay);
});

test('non-HSL weeks carry empty weekend segments', () => {
  const r = transferResult();
  assert.deepEqual(r.segments.weekendRegular, []);
  assert.deepEqual(r.segments.weekendOt, []);
});

test('a zero-second day never mints a segment', () => {
  const r = proratePayForMidPeriodChange({
    days: [
      { date: new Date(2026, 6, 20), seconds: 8 * 3600 },
      { date: new Date(2026, 6, 22), seconds: 0 }, // present but unworked
      { date: new Date(2026, 6, 23), seconds: 8 * 3600 },
    ],
    isHsl: false,
    history: TRANSFER_HISTORY,
    histEmail: EMAIL,
    fallbackReg: 225,
    fallbackOt: 281.25,
  });
  assert.ok(r);
  assert.deepEqual(
    r.segments.regular.map((s) => s.ratePhp),
    [175, 225],
  );
  assert.deepEqual(r.segments.regular, [
    { ratePhp: 175, hours: 8, payPhp: 1400 },
    { ratePhp: 225, hours: 8, payPhp: 1800 },
  ]);
});

// ── HSL: the weekend premium rides inside the segment that paid it ──────────
// Mon Jul 20 8h @175 · Wed Jul 22 8h @225 · Sat Jul 25 4h @225+15.
// Full regular = 8×175 + 8×225 + 4×240 = ₱4,160; the 225-segment carries the
// Sat premium money (2,760) and the weekend carve-out segment mirrors it (960),
// so weekday-by-subtraction per rate stays exact: 2,760 − 960 = 8h × 225.

test('HSL weekend money stays inside its rate segment, with a weekend carve-out per rate', () => {
  const r = proratePayForMidPeriodChange({
    days: [
      { date: new Date(2026, 6, 20), seconds: 8 * 3600 },
      { date: new Date(2026, 6, 22), seconds: 8 * 3600 },
      { date: new Date(2026, 6, 25), seconds: 4 * 3600 },
    ],
    isHsl: true,
    history: TRANSFER_HISTORY,
    histEmail: EMAIL,
    fallbackReg: 225,
    fallbackOt: 281.25,
  });
  assert.ok(r);
  assert.equal(r.regularPay, 4160);
  assert.deepEqual(r.segments.regular, [
    { ratePhp: 175, hours: 8, payPhp: 1400 },
    { ratePhp: 225, hours: 12, payPhp: 2760 },
  ]);
  assert.deepEqual(r.segments.weekendRegular, [{ ratePhp: 225, hours: 4, payPhp: 960 }]);
  // Existing weekend rollup is untouched by the segment addition.
  assert.deepEqual(r.weekend, { regularHours: 4, otHours: 0, regularPay: 960, otPay: 0 });
});
