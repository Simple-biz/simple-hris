import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceChangedWeek2dp, proratePayForMidPeriodChange } from './prorate-mid-period';
import {
  historyMatchesCatalogAsOf,
  type RateHistoryByEmail,
  type RateHistoryRow,
} from './rate-history-resolve';

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

test('mid-week transfer pays old-rate days then new-rate days, priced per 2dp leg', () => {
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

// ── The individual-catalog gate (2026-07-30) ────────────────────────────────
// An employee-scope Payment Catalog rate used to skip proration entirely (flat
// all period, matching Dispatch's rateOverride). That gate blocked every
// catalog-managed person — which is nearly everyone since the catalog became
// the rate source of truth. New rule, identical in both engines: when the
// person's dated history is CATALOG-CONSISTENT (the history rate resolved as
// of the last worked day equals the structure, PHP only), prorate through
// history — it was catalog-authored. Any disagreement keeps today's flat path,
// so stale history can never resurrect.

const sec = (hms: string) => {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

/** Capillo's real Jul 19–25 week: Lead Gen → Sales Assistant eff Jul 21, with a
 *  correction the next day — THREE dated rates: 175 → 210 (Jul 21) → 225 (Jul 22). */
const CAPILLO_HISTORY = historyMap([
  { email: EMAIL, regularRate: 175, otRate: 262.5, effectiveFrom: new Date(2026, 4, 31) },
  { email: EMAIL, regularRate: 210, otRate: 315, effectiveFrom: new Date(2026, 6, 21) },
  { email: EMAIL, regularRate: 225, otRate: 337.5, effectiveFrom: new Date(2026, 6, 22) },
]);
const CAPILLO_DAYS = [
  { date: new Date(2026, 6, 20), seconds: sec('7:56:07') },
  { date: new Date(2026, 6, 21), seconds: sec('10:51:08') },
  { date: new Date(2026, 6, 22), seconds: sec('10:25:07') },
  { date: new Date(2026, 6, 23), seconds: sec('10:11:57') },
  { date: new Date(2026, 6, 24), seconds: sec('10:00:22') },
];

test('a catalog-consistent individual rate prorates through its own history', () => {
  const r = proratePayForMidPeriodChange({
    days: CAPILLO_DAYS,
    isHsl: false,
    history: CAPILLO_HISTORY,
    histEmail: EMAIL,
    fallbackReg: 210,
    fallbackOt: 315,
    catalogRate: { currency: 'PHP', regular: 225, ot: 337.5 },
  });
  assert.ok(r, 'consistent catalog must not block the split');
  // 2dp-leg pricing (ruling 2026-08-18): each displayed hours × rate leg
  // multiplies out to its money exactly — 7.94×175=1389.50, 10.85×210=2278.50,
  // 21.21×225=4772.25 — and the line totals are the sums of the legs.
  assert.equal(r.regularPay, 8440.25);
  assert.equal(r.otPay, 3175.88);
  assert.deepEqual(r.segments.regular, [
    { ratePhp: 175, hours: 7.94, payPhp: 1389.5 },
    { ratePhp: 210, hours: 10.85, payPhp: 2278.5 },
    { ratePhp: 225, hours: 21.21, payPhp: 4772.25 },
  ]);
  assert.deepEqual(r.segments.ot, [{ ratePhp: 337.5, hours: 9.41, payPhp: 3175.88 }]);
  assert.equal(r.change?.effectiveDate, '2026-07-21');
});

test('an INCONSISTENT catalog rate keeps the flat path (stale sources never blend)', () => {
  // Capillo today: the structure still says 210 while history moved on to 225.
  const r = proratePayForMidPeriodChange({
    days: CAPILLO_DAYS,
    isHsl: false,
    history: CAPILLO_HISTORY,
    histEmail: EMAIL,
    fallbackReg: 210,
    fallbackOt: 315,
    catalogRate: { currency: 'PHP', regular: 210, ot: 315 },
  });
  assert.equal(r, null);
});

test('a non-PHP catalog rate keeps the flat path (FX-blended splits are meaningless)', () => {
  const r = proratePayForMidPeriodChange({
    days: CAPILLO_DAYS,
    isHsl: false,
    history: CAPILLO_HISTORY,
    histEmail: EMAIL,
    fallbackReg: 210,
    fallbackOt: 315,
    catalogRate: { currency: 'USD', regular: 4, ot: 6 },
  });
  assert.equal(r, null);
});

test('no catalog rate at all behaves exactly as before (transfer scenario pin)', () => {
  const withParam = proratePayForMidPeriodChange({
    days: TRANSFER_DAYS,
    isHsl: false,
    history: TRANSFER_HISTORY,
    histEmail: EMAIL,
    fallbackReg: 225,
    fallbackOt: 281.25,
    catalogRate: null,
  });
  assert.deepEqual(withParam, transferResult());
});

// ── historyMatchesCatalogAsOf (the shared consistency rule) ─────────────────

const asRows = (m: RateHistoryByEmail) => m.get(EMAIL);

test('consistency: the terminal history rate matching the structure passes', () => {
  assert.equal(
    historyMatchesCatalogAsOf(asRows(CAPILLO_HISTORY), { currency: 'PHP', regular: 225, ot: 337.5 }, new Date(2026, 6, 24)),
    true,
  );
});

test('consistency: a structure the history has moved past fails', () => {
  assert.equal(
    historyMatchesCatalogAsOf(asRows(CAPILLO_HISTORY), { currency: 'PHP', regular: 210, ot: 315 }, new Date(2026, 6, 24)),
    false,
  );
});

test('consistency: non-PHP structures always fail', () => {
  assert.equal(
    historyMatchesCatalogAsOf(asRows(CAPILLO_HISTORY), { currency: 'USD', regular: 225, ot: 337.5 }, new Date(2026, 6, 24)),
    false,
  );
});

test('consistency: no history row covering asOf fails (nothing to vouch for the rate)', () => {
  const onlyFuture = historyMap([
    { email: EMAIL, regularRate: 225, otRate: 337.5, effectiveFrom: new Date(2026, 6, 22) },
  ]);
  assert.equal(
    historyMatchesCatalogAsOf(asRows(onlyFuture), { currency: 'PHP', regular: 225, ot: 337.5 }, new Date(2026, 6, 19)),
    false,
  );
  assert.equal(
    historyMatchesCatalogAsOf(undefined, { currency: 'PHP', regular: 225, ot: 337.5 }, new Date(2026, 6, 24)),
    false,
  );
});

test('consistency: a null history OT is lenient, a different OT is not', () => {
  const noOt = historyMap([
    { email: EMAIL, regularRate: 225, otRate: null, effectiveFrom: new Date(2026, 6, 22) },
  ]);
  assert.equal(
    historyMatchesCatalogAsOf(asRows(noOt), { currency: 'PHP', regular: 225, ot: 337.5 }, new Date(2026, 6, 24)),
    true,
  );
  const wrongOt = historyMap([
    { email: EMAIL, regularRate: 225, otRate: 300, effectiveFrom: new Date(2026, 6, 22) },
  ]);
  assert.equal(
    historyMatchesCatalogAsOf(asRows(wrongOt), { currency: 'PHP', regular: 225, ot: 337.5 }, new Date(2026, 6, 24)),
    false,
  );
});

// ── Mid-week transfer INTO HSL: day-scoped weekend treatment ────────────────
// Kane's rule (2026-07-30): a person transferred INTO HSL mid-week gets the
// Weekend Hours treatment (+₱15/h Sat/Sun premium + weekend itemization) for
// THAT week — but only for weekend days ON/AFTER the transfer's effective
// date. A weekend day worked before the transfer (still in the old dept) pays
// plain rate and stays on the Regular line. `hslFrom` carries the effective
// date; null/omitted = HSL all week (unchanged behavior).

test('hslFrom scopes the weekend premium: pre-transfer Sunday plain, post-transfer Saturday +15', () => {
  // Sun Jul 19 4h (old dept, rate 175) · Wed Jul 22 8h (new rate 225) · Sat Jul 25 4h.
  // Transfer + rate change effective Wed Jul 22.
  const r = proratePayForMidPeriodChange({
    days: [
      { date: new Date(2026, 6, 19), seconds: 4 * 3600 },
      { date: new Date(2026, 6, 22), seconds: 8 * 3600 },
      { date: new Date(2026, 6, 25), seconds: 4 * 3600 },
    ],
    isHsl: true,
    hslFrom: new Date(2026, 6, 22),
    history: TRANSFER_HISTORY,
    histEmail: EMAIL,
    fallbackReg: 225,
    fallbackOt: 281.25,
  });
  assert.ok(r);
  // Sun 4×175 (NO premium) + Wed 8×225 + Sat 4×(225+15) = 700 + 1800 + 960 = 3,460
  assert.equal(r.regularPay, 3460);
  // Weekend rollup + carve segments cover ONLY the post-transfer Saturday.
  assert.deepEqual(r.weekend, { regularHours: 4, otHours: 0, regularPay: 960, otPay: 0 });
  assert.deepEqual(r.segments.weekendRegular, [{ ratePhp: 225, hours: 4, payPhp: 960 }]);
  // The pre-transfer Sunday stays inside the plain regular segments.
  assert.deepEqual(r.segments.regular, [
    { ratePhp: 175, hours: 4, payPhp: 700 },
    { ratePhp: 225, hours: 12, payPhp: 2760 },
  ]);
});

test('hslFrom omitted keeps the whole-week premium (existing behavior pin)', () => {
  const r = proratePayForMidPeriodChange({
    days: [
      { date: new Date(2026, 6, 19), seconds: 4 * 3600 },
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
  // Sun 4×(175+15) + Wed 8×225 + Sat 4×(225+15) = 760 + 1800 + 960 = 3,520
  assert.equal(r.regularPay, 3520);
  assert.deepEqual(r.weekend, { regularHours: 8, otHours: 0, regularPay: 1720, otPay: 0 });
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

// ── 2026-08-11 (Kane): HSL pays the Hogan sheet's three-stage form ──────────
// M–F hours never re-rate; ALL Sat+Sun hours earn the +15 premium (past-cap
// included); overtime money is ONLY the derived differential — past-cap hours ×
// 0.5 × that day's REGULAR rate. The stored OT rate is not a money input for
// HSL. This reverses the 2026-08-07 within-cap scoping, whose pin previously
// lived here (Sat 4h → 4 × 281.25 plain OT, no carve).

test('HSL weekend hours past the 40h cap keep the +15; OT is the 0.5× differential', () => {
  // Mon–Fri 8h/day fills the 40h cap; Sat 4h crosses it entirely on the weekend.
  const r = proratePayForMidPeriodChange({
    days: [
      { date: new Date(2026, 6, 20), seconds: 8 * 3600 },
      { date: new Date(2026, 6, 21), seconds: 8 * 3600 },
      { date: new Date(2026, 6, 22), seconds: 8 * 3600 },
      { date: new Date(2026, 6, 23), seconds: 8 * 3600 },
      { date: new Date(2026, 6, 24), seconds: 8 * 3600 },
      { date: new Date(2026, 6, 25), seconds: 4 * 3600 },
    ],
    isHsl: true,
    history: TRANSFER_HISTORY,
    histEmail: EMAIL,
    fallbackReg: 225,
    fallbackOt: 281.25,
  });
  assert.ok(r);
  // Every hour is base-paid once: Mon+Tue 16×175 + Wed–Fri 24×225 + Sat 4×(225+15).
  assert.equal(r.regularPay, 9160);
  // Sat 4h past the cap add ONLY the differential: 4 × (0.5 × 225) = ₱450.
  assert.equal(r.otPay, 450);
  assert.deepEqual(r.segments.ot, [{ ratePhp: 112.5, hours: 4, payPhp: 450 }]);
  assert.deepEqual(r.otRatesUsed, [112.5]);
  // The weekend carve covers ALL weekend hours — past-cap included.
  assert.deepEqual(r.weekend, { regularHours: 4, otHours: 0, regularPay: 960, otPay: 0 });
  assert.deepEqual(r.segments.weekendRegular, [{ ratePhp: 225, hours: 4, payPhp: 960 }]);
  assert.deepEqual(r.segments.weekendOt, []);
});

test('HSL: a stored OT rate never moves money — only the regular rate does', () => {
  // Constant ₱225 regular all week; the history's stored OT (281.25 = 1.25×,
  // i.e. corrupt) must neither price the differential nor force an override
  // when the regular rate matches the cache. This is what routes single-rate
  // HSL weeks to the sheet-exact computeHoganWeekPay path in the caller.
  const constant = proratePayForMidPeriodChange({
    days: [
      { date: new Date(2026, 6, 22), seconds: 8 * 3600 },
      { date: new Date(2026, 6, 25), seconds: 4 * 3600 },
    ],
    isHsl: true,
    history: historyMap([
      { email: EMAIL, regularRate: 225, otRate: 281.25, effectiveFrom: new Date(2026, 0, 1) },
    ]),
    histEmail: EMAIL,
    fallbackReg: 225,
    fallbackOt: 337.5, // cache says 1.5× — history's stored OT disagrees, but neither pays
  });
  assert.equal(constant, null);
});

// ── Ruling 2026-08-18 ("doc stands" — Kane): changed-week 2dp-leg pricing ────
// A week whose rate genuinely changed mid-period prices every leg at 2dp
// HOURS × rate, so the statement's per-rate basis line multiplies out to the
// money exactly. HSL OT on a changed week counts ALL hours worked toward the
// 40h threshold — pre-transfer days included. (The Hogan sheet's AK/AL
// transition columns exclude the old-rate hours from its OT threshold; that
// reading was REJECTED — HRIS deliberately pays more than the sheet here.)
// Pinned on the real case that surfaced it: cheskac@simple.biz, pay week
// Sun 2026-08-09 → Sat 2026-08-15, Lead Gen ₱175 → HSL Executive Guest
// Services ₱355 effective Fri 2026-08-14.

const hms = (h: number, m: number, s: number) => h * 3600 + m * 60 + s;

const CHESKA_DAYS = [
  { date: new Date(2026, 7, 10), seconds: hms(10, 6, 15) }, // Mon — Lead Gen
  { date: new Date(2026, 7, 11), seconds: hms(9, 0, 42) }, // Tue — Lead Gen
  { date: new Date(2026, 7, 12), seconds: hms(9, 0, 10) }, // Wed — Lead Gen
  { date: new Date(2026, 7, 13), seconds: hms(9, 1, 2) }, // Thu — Lead Gen
  { date: new Date(2026, 7, 14), seconds: hms(8, 8, 19) }, // Fri — HSL EGS
];

const CHESKA_HISTORY = historyMap([
  { email: EMAIL, regularRate: 175, otRate: 262.5, effectiveFrom: new Date(2026, 7, 9) },
  { email: EMAIL, regularRate: 355, otRate: 532.5, effectiveFrom: new Date(2026, 7, 14) },
]);

function cheskaResult() {
  const r = proratePayForMidPeriodChange({
    days: CHESKA_DAYS,
    isHsl: true,
    hslFrom: new Date(2026, 7, 14),
    history: CHESKA_HISTORY,
    histEmail: EMAIL,
    fallbackReg: 355,
    fallbackOt: 532.5,
    catalogRate: { currency: 'PHP', regular: 355, ot: 532.5 },
  });
  assert.ok(r, 'a mid-week transfer with catalog-consistent history must prorate');
  return r;
}

test('cheskac 2026-08-09 week: 4 Lead Gen days at ₱175, 1 HSL day at ₱355, legs at 2dp', () => {
  const r = cheskaResult();
  // 37.14h × 175 = 6,499.50 · 8.14h × 355 = 2,889.70 — exactly as displayed.
  assert.deepEqual(r.segments.regular, [
    { ratePhp: 175, hours: 37.14, payPhp: 6499.5 },
    { ratePhp: 355, hours: 8.14, payPhp: 2889.7 },
  ]);
  assert.equal(r.regularPay, 9389.2);
  assert.equal(r.change?.effectiveDate, '2026-08-14');
});

test('cheskac OT: the 40h threshold counts ALL hours — the Lead Gen days included', () => {
  const r = cheskaResult();
  // Rounded totals: 37.14 + 8.14 = 45.28h → 5.28h OT, all attributed to the
  // newest rate (the past-cap hours are chronologically the Friday hours):
  // 5.28 × (0.5 × 355 = 177.50) = ₱937.20.
  assert.deepEqual(r.segments.ot, [{ ratePhp: 177.5, hours: 5.28, payPhp: 937.2 }]);
  assert.equal(r.otPay, 937.2);
  assert.deepEqual(r.otRatesUsed, [177.5]);
  // No weekend hours were worked — nothing to carve.
  assert.deepEqual(r.weekend, { regularHours: 0, otHours: 0, regularPay: 0, otPay: 0 });
  assert.deepEqual(r.segments.weekendRegular, []);
});

test('changed-week legs multiply out to their money exactly (the 2dp invariant)', () => {
  const r = cheskaResult();
  const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  for (const s of [...r.segments.regular, ...r.segments.ot]) {
    assert.equal(s.payPhp, r2(s.hours * s.ratePhp), `${s.hours}h × ₱${s.ratePhp}`);
  }
  const sum = (xs: Array<{ payPhp: number }>) => r2(xs.reduce((a, x) => a + x.payPhp, 0));
  assert.equal(sum(r.segments.regular), r.regularPay);
  assert.equal(sum(r.segments.ot), r.otPay);
});

test('priceChangedWeek2dp: HSL OT spills into the older rate when the newest leg is smaller', () => {
  // 39h at ₱175 then 3h at ₱355 → total 42h, OT 2h. The newest leg (3h) can
  // absorb all 2h — but push it to 1h and the remaining 1h attributes to the
  // ₱175 leg: OT must never be priced at a rate that has no hours left.
  const spill = priceChangedWeek2dp({
    isHsl: true,
    legs: [
      { ratePhp: 175, weekdaySec: 41 * 3600, weekendSec: 0 },
      { ratePhp: 355, weekdaySec: 1 * 3600, weekendSec: 0 },
    ],
    otLegs: [],
  });
  // total 42h → OT 2h: 1h @ 177.5 (newest, capped by its leg) + 1h @ 87.5.
  assert.deepEqual(spill.otSegments, [
    { ratePhp: 87.5, hours: 1, payPhp: 87.5 },
    { ratePhp: 177.5, hours: 1, payPhp: 177.5 },
  ]);
  assert.equal(spill.otPay, 265);
});
