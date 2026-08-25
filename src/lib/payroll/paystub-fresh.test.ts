import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeSnapshotIntoStaged,
  catalogClaimForEmails,
  type StagedPaystubLike,
  type CatalogRateClaim,
} from './paystub-fresh';

// ── The bug the catalog-rate guard pins ─────────────────────────────────────
// 2026-07-29 16:13Z: an employee's rate was corrected to ₱225/h in the Payment
// Catalog (source of truth). At 16:31Z — EIGHTEEN MINUTES LATER — a still-open
// Payroll Wizard tab, whose in-memory data predated the fix, republished the
// week's `payroll.wizard.final_pay` snapshot with figures computed at the old
// ₱175/h. Because the snapshot was newer than the queue row's lock, the merge
// would have overwritten corrected staged values with the stale ones — and the
// result is INTERNALLY consistent (175 shown, 175 paid), so no downstream
// consistency check can catch it. The only authority that can is the catalog
// itself: a snapshot carrying a rate the catalog contradicts is provably from
// a stale session, no matter how fresh its timestamp.

const LOCKED_AT = '2026-07-28T21:51:00.000Z';
const SNAP_NEWER = '2026-07-29T16:31:05.000Z';
const SNAP_OLDER = '2026-07-27T09:00:00.000Z';

const CLAIM_225: CatalogRateClaim = { regular: 225, ot: 337.5 };

function stagedRow(): StagedPaystubLike {
  return {
    recipient_email: 'nathanr@simple.biz',
    payload: {
      email: 'nathanr@simple.biz',
      hours: { total: 44.14, regular: 40, ot: 4.14 },
      rates_php: { regular: 225, ot: 337.5 },
      pay_php: { regular: 9000, ot: 1398.38, initial: 10398.38, final: 10298.38 },
      pay_period: { fx_rate: 56 },
    },
    pay_period: { fx_rate: 56 },
    locked_at: LOCKED_AT,
    excluded: false,
  };
}

/** A fully itemized snapshot entry (post-2026-07-21 shape, rates included). */
function snapEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    final: 7987.63,
    regularPay: 7000,
    otPay: 1087.63,
    regularHours: 40,
    otHours: 4.14,
    totalHours: 44.14,
    initial: 8087.63,
    mesaDeduction: 100,
    mesaDisbursement: 0,
    perfectAttendanceBonus: 0,
    techBonus: 0,
    otherBonuses: 0,
    adjustment: 0,
    orphanagePay: 0,
    regularRate: 175,
    otRate: 262.5,
    ...over,
  };
}

function snapValue(entry: Record<string, unknown>): string {
  return JSON.stringify({ finals: { 'nathanr@simple.biz': entry }, fx_rate: 56 });
}

test('the real 2026-07-29 case: a stale-session snapshot contradicting the catalog is REJECTED', () => {
  const staged = stagedRow();
  const r = mergeSnapshotIntoStaged(staged, snapValue(snapEntry()), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, false);
  assert.equal(r.staleRateSnapshot, true);
  // Staged payload returned byte-identical — the corrected figures survive.
  assert.equal(r.payload, staged.payload);
});

test('a snapshot whose rates MATCH the catalog merges normally', () => {
  const staged = stagedRow();
  const entry = snapEntry({
    regularRate: 225,
    otRate: 337.5,
    regularPay: 9000,
    otPay: 1398.38,
    final: 10398.38, // differs from staged final → changed → refresh
    initial: 10398.38,
    mesaDeduction: 0,
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, true);
  assert.equal(r.staleRateSnapshot ?? false, false);
  const pay = (r.payload as Record<string, Record<string, unknown>>).pay_php;
  assert.equal(pay.regular, 9000);
  assert.equal(pay.final, 10398.38);
});

test('without a catalog claim the guard is inert (pre-guard behavior)', () => {
  const staged = stagedRow();
  const r = mergeSnapshotIntoStaged(staged, snapValue(snapEntry()), SNAP_NEWER);
  assert.equal(r.refreshed, true); // stale figures DO merge — this is why the claim matters
  const pay = (r.payload as Record<string, Record<string, unknown>>).pay_php;
  assert.equal(pay.regular, 7000);
});

test('a snapshot without rate fields cannot be validated and keeps the old behavior', () => {
  const staged = stagedRow();
  const entry = snapEntry({ regularRate: undefined, otRate: undefined });
  delete entry.regularRate;
  delete entry.otRate;
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, true);
  assert.equal(r.staleRateSnapshot ?? false, false);
});

test('an OT-only contradiction is enough to reject', () => {
  const staged = stagedRow();
  const entry = snapEntry({ regularRate: 225, otRate: 262.5 });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.staleRateSnapshot, true);
  assert.equal(r.refreshed, false);
});

test('sub-centavo rate differences are tolerated (rounding is not staleness)', () => {
  const staged = stagedRow();
  const entry = snapEntry({
    regularRate: 225.004,
    otRate: 337.504,
    regularPay: 9000,
    otPay: 1398.38,
    final: 10398.38,
    initial: 10398.38,
    mesaDeduction: 0,
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.staleRateSnapshot ?? false, false);
  assert.equal(r.refreshed, true);
});

test('the newer-than-lock rule still runs FIRST: an old snapshot is ignored, not flagged', () => {
  const staged = stagedRow();
  const r = mergeSnapshotIntoStaged(staged, snapValue(snapEntry()), SNAP_OLDER, CLAIM_225);
  assert.equal(r.refreshed, false);
  assert.equal(r.staleRateSnapshot ?? false, false);
});

test('excluded rows never merge, with or without a claim', () => {
  const staged = { ...stagedRow(), excluded: true };
  const r = mergeSnapshotIntoStaged(staged, snapValue(snapEntry()), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, false);
  assert.equal(r.staleRateSnapshot ?? false, false);
});

test('catalogClaimForEmails resolves through alias emails and misses cleanly', () => {
  const claims = new Map<string, CatalogRateClaim>([['nathanr@simple.biz', CLAIM_225]]);
  assert.deepEqual(
    catalogClaimForEmails(claims, [null, 'Nathanr@Simple.biz ']),
    CLAIM_225,
  );
  assert.equal(catalogClaimForEmails(claims, ['someoneelse@simple.biz']), null);
  assert.equal(catalogClaimForEmails(new Map(), ['nathanr@simple.biz']), null);
});

// ── HSL weekend block through the merge (2026-07-30) ────────────────────────
// The snapshot's regular/OT figures overwrite the staged ones, so the weekend
// block that itemizes them must travel in the same write — otherwise the
// Employee Dashboard modal would show fresh totals over a stale weekend split.

/** An HSL staged row: 40h regular (2h on the weekend) + 2h OT (all weekend). */
function hslStagedRow(): StagedPaystubLike {
  return {
    recipient_email: 'nathanr@simple.biz',
    payload: {
      email: 'nathanr@simple.biz',
      hours: { total: 44, regular: 40, ot: 2 },
      weekend: {
        hours: { regular: 2, ot: 2 },
        pay_php: { regular: 480, ot: 705 },
        premium_php_per_hour: 15,
      },
      rates_php: { regular: 225, ot: 337.5 },
      // Fully itemized, exactly as the wizard stages it — the change detector
      // compares every key, so an abbreviated fixture would flag `undefined`
      // vs 0 as a change and mask the weekend-specific behavior under test.
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
      pay_period: { fx_rate: 56 },
    },
    pay_period: { fx_rate: 56 },
    locked_at: LOCKED_AT,
    excluded: false,
  };
}

const weekend = (p: unknown) =>
  (p as Record<string, unknown>).weekend as Record<string, Record<string, unknown>> | null;

test('a snapshot carrying weekend fields rebuilds the staged weekend block', () => {
  const staged = hslStagedRow();
  // The wizard recomputed after lock: one weekend OT hour moved off the week.
  const entry = snapEntry({
    regularRate: 225,
    otRate: 337.5,
    regularPay: 9030,
    otPay: 352.5,
    initial: 9382.5,
    final: 9282.5,
    otHours: 1,
    totalHours: 43,
    weekendRegularHours: 2,
    weekendOtHours: 1,
    weekendRegularPay: 480,
    weekendOtPay: 352.5,
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, true);
  const w = weekend(r.payload);
  assert.ok(w);
  assert.equal(w.hours.regular, 2);
  assert.equal(w.hours.ot, 1);
  assert.equal(w.pay_php.regular, 480);
  assert.equal(w.pay_php.ot, 352.5);
  // Premium carried over from the staged block.
  assert.equal((w as Record<string, unknown>).premium_php_per_hour, 15);
});

test('a weekend-only change is a change (refresh fires)', () => {
  const staged = hslStagedRow();
  const entry = snapEntry({
    regularRate: 225,
    otRate: 337.5,
    regularPay: 9030,
    otPay: 705,
    initial: 9735,
    final: 9635,
    otHours: 2,
    totalHours: 44,
    mesaDeduction: 100,
    // Same totals, different carve-out (e.g. hours re-bucketed across the cap).
    weekendRegularHours: 3,
    weekendOtHours: 1,
    weekendRegularPay: 720,
    weekendOtPay: 352.5,
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, true);
  const w = weekend(r.payload);
  assert.ok(w);
  assert.equal(w.hours.regular, 3);
  assert.equal(w.pay_php.regular, 720);
});

test('an OLD-shape snapshot (no weekend fields) leaves the staged weekend block untouched', () => {
  const staged = hslStagedRow();
  const entry = snapEntry({
    regularRate: 225,
    otRate: 337.5,
    regularPay: 9500, // changed figure so the merge fires
    otPay: 705,
    initial: 10205,
    final: 10105,
  }); // note: NO weekend* keys at all
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, true);
  const w = weekend(r.payload);
  assert.ok(w, 'staged weekend block must survive an old-shape snapshot');
  assert.equal(w.hours.regular, 2);
  assert.equal(w.pay_php.regular, 480);
});

test('all-null weekend fields (non-HSL row) null out a stale staged block', () => {
  const staged = hslStagedRow();
  const entry = snapEntry({
    regularRate: 225,
    otRate: 337.5,
    regularPay: 9000,
    otPay: 675,
    initial: 9675,
    final: 9575,
    weekendRegularHours: null,
    weekendOtHours: null,
    weekendRegularPay: null,
    weekendOtPay: null,
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, true);
  assert.equal(weekend(r.payload), null);
});

test('an old-shape snapshot over a payload WITHOUT a weekend block never invents the key', () => {
  const staged = stagedRow(); // no weekend key at all
  const entry = snapEntry({
    regularRate: 225,
    otRate: 337.5,
    regularPay: 9000,
    otPay: 1398.38,
    final: 10398.38,
    initial: 10398.38,
    mesaDeduction: 0,
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, true);
  assert.equal('weekend' in (r.payload as Record<string, unknown>), false);
});

test('identical weekend fields alone do not force a refresh', () => {
  const staged = hslStagedRow();
  const entry = snapEntry({
    regularRate: 225,
    otRate: 337.5,
    regularPay: 9030,
    otPay: 705,
    initial: 9735,
    final: 9635,
    otHours: 2,
    totalHours: 44,
    mesaDeduction: 100,
    weekendRegularHours: 2,
    weekendOtHours: 2,
    weekendRegularPay: 480,
    weekendOtPay: 705,
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, false);
});

// ── Mid-week proration block through the merge (2026-07-30) ─────────────────
// Same contract as the weekend block: the snapshot's figures overwrite the
// staged ones, so the proration block that explains them must travel in the
// same write — fresh totals over a stale (or missing) basis would put a
// "Prorated ₱175→₱225" explanation under money computed some other way.

/** The approved mock staged: transfer eff. Jul 22, 16.25h@175 + 23.75h@225. */
function stagedProrationBlock(): Record<string, unknown> {
  return {
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
  };
}

/** Fully itemized prorated staged row (an abbreviated pay_php would flag
 *  `undefined` vs 0 as a change and mask the proration-specific behavior). */
function proratedStagedRow(): StagedPaystubLike {
  return {
    recipient_email: 'nathanr@simple.biz',
    payload: {
      email: 'nathanr@simple.biz',
      hours: { total: 42.5, regular: 40, ot: 2.5 },
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
      proration: stagedProrationBlock(),
      pay_period: { fx_rate: 56 },
    },
    pay_period: { fx_rate: 56 },
    locked_at: LOCKED_AT,
    excluded: false,
  };
}

/** Snapshot overrides matching proratedStagedRow figure-for-figure. */
function proratedSnapOverrides(): Record<string, unknown> {
  return {
    final: 8790.63,
    regularPay: 8187.5,
    otPay: 703.13,
    regularHours: 40,
    otHours: 2.5,
    totalHours: 42.5,
    initial: 8890.63,
    mesaDeduction: 100,
    regularRate: 225,
    otRate: 281.25,
  };
}

const proration = (p: unknown) =>
  (p as Record<string, unknown>).proration as Record<string, unknown> | null;

test('a snapshot carrying a proration block replaces the staged one', () => {
  const staged = proratedStagedRow();
  // Post-lock recompute moved an hour across the change (16.25→15.25 / 23.75→24.75).
  const nextBlock = stagedProrationBlock();
  (nextBlock.segments as Record<string, unknown>).regular = [
    { rate_php: 175, hours: 15.25, pay_php: 2668.75 },
    { rate_php: 225, hours: 24.75, pay_php: 5568.75 },
  ];
  const entry = snapEntry({
    ...proratedSnapOverrides(),
    regularPay: 8237.5,
    initial: 8940.63,
    final: 8840.63,
    proration: nextBlock,
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, true);
  assert.deepEqual(proration(r.payload), nextBlock);
});

test('a proration-only change is a change (refresh fires)', () => {
  const staged = proratedStagedRow();
  const nextBlock = stagedProrationBlock();
  nextBlock.effective_date = '2026-07-23'; // the transfer date was corrected
  const entry = snapEntry({ ...proratedSnapOverrides(), proration: nextBlock });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, true);
  assert.equal(proration(r.payload)?.effective_date, '2026-07-23');
});

test('an OLD-shape snapshot (no proration field) leaves the staged block untouched', () => {
  const staged = proratedStagedRow();
  const entry = snapEntry({
    ...proratedSnapOverrides(),
    regularPay: 8300, // changed figure so the merge fires
    initial: 9003.13,
    final: 8903.13,
  }); // note: NO proration key at all
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, true);
  assert.deepEqual(proration(r.payload), stagedProrationBlock());
});

test('proration: null clears a stale staged block (the change no longer exists)', () => {
  const staged = proratedStagedRow();
  const entry = snapEntry({ ...proratedSnapOverrides(), proration: null });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, true);
  assert.equal(proration(r.payload), null);
});

test('an identical proration block alone does not force a refresh', () => {
  const staged = proratedStagedRow();
  // jsonb round-trips reorder object keys — the comparison must not care.
  const scrambled = {
    segments: {
      weekend_ot: [],
      ot: [{ pay_php: 703.13, hours: 2.5, rate_php: 281.25 }],
      weekend_regular: [],
      regular: [
        { pay_php: 2843.75, rate_php: 175, hours: 16.25 },
        { hours: 23.75, rate_php: 225, pay_php: 5343.75 },
      ],
    },
    new_rates_php: { ot: 281.25, regular: 225 },
    old_rates_php: { ot: 218.75, regular: 175 },
    effective_date: '2026-07-22',
  };
  const entry = snapEntry({ ...proratedSnapOverrides(), proration: scrambled });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, false);
});

test('an old-shape snapshot over a payload WITHOUT a proration block never invents the key', () => {
  const staged = stagedRow(); // no proration key at all
  const entry = snapEntry({
    regularRate: 225,
    otRate: 337.5,
    regularPay: 9000,
    otPay: 1398.38,
    final: 10398.38,
    initial: 10398.38,
    mesaDeduction: 0,
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, true);
  assert.equal('proration' in (r.payload as Record<string, unknown>), false);
});

// ── Hogan sheet-form block through the merge (2026-08-11) ────────────────────
// Same travel-together contract as the weekend block: the `hogan_sheet` legs
// ARE the statement's M-F / Weekend / OT-Differential lines, so a refresh that
// moves the figures must move the block in the same write. And a sheet-form
// snapshot stores the DERIVED 0.5× differential as `otRate`, which must never
// trip the catalog staleness gate — the regular-rate check covers it.

const hoganOf = (p: unknown) =>
  (p as Record<string, unknown>).hogan_sheet as Record<string, unknown> | null | undefined;

test('a snapshot carrying hoganSheet rewrites the staged block in the same merge', () => {
  const staged = hslStagedRow();
  (staged.payload as Record<string, unknown>).hogan_sheet = {
    mf_hours: 40,
    we_hours: 4,
    ot_hours: 4,
    rates_php: { regular: 225, weekend: 240, ot_differential: 112.5 },
    pay_php: { base: 9000, weekend: 960, ot_differential: 450 },
  };
  const entry = snapEntry({
    regularRate: 225,
    otRate: 112.5,
    regularPay: 9960,
    otPay: 337.5,
    initial: 10297.5,
    final: 10197.5,
    otHours: 3,
    totalHours: 43,
    weekendRegularHours: 3,
    weekendOtHours: 0,
    weekendRegularPay: 720,
    weekendOtPay: 0,
    hoganSheet: {
      mf_hours: 40,
      we_hours: 3,
      ot_hours: 3,
      rates_php: { regular: 225, weekend: 240, ot_differential: 112.5 },
      pay_php: { base: 9000, weekend: 720, ot_differential: 337.5 },
    },
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, true);
  const h = hoganOf(r.payload);
  assert.ok(h);
  assert.equal(h.we_hours, 3);
  assert.deepEqual(h.pay_php, { base: 9000, weekend: 720, ot_differential: 337.5 });
});

test('an old-shape snapshot (no hoganSheet field) leaves the staged block untouched', () => {
  const staged = hslStagedRow();
  (staged.payload as Record<string, unknown>).hogan_sheet = {
    mf_hours: 40,
    we_hours: 4,
    ot_hours: 4,
    rates_php: { regular: 225, weekend: 240, ot_differential: 112.5 },
    pay_php: { base: 9000, weekend: 960, ot_differential: 450 },
  };
  const entry = snapEntry({
    regularRate: 225,
    otRate: 337.5,
    regularPay: 9030,
    otPay: 352.5,
    initial: 9382.5,
    final: 9282.5,
    otHours: 1,
    totalHours: 43,
    weekendRegularHours: 2,
    weekendOtHours: 1,
    weekendRegularPay: 480,
    weekendOtPay: 352.5,
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.refreshed, true);
  const h = hoganOf(r.payload);
  assert.ok(h, 'staged hogan_sheet must survive an old-shape snapshot merge');
  assert.equal(h.we_hours, 4);
});

test('a sheet-form differential otRate never trips the catalog staleness gate', () => {
  const staged = hslStagedRow();
  const entry = snapEntry({
    regularRate: 225,
    // 0.5 × 225 — nothing like the catalog's stored 337.50, and rightly so.
    otRate: 112.5,
    regularPay: 9030,
    otPay: 450,
    initial: 9480,
    final: 9380,
    otHours: 4,
    totalHours: 44,
    weekendRegularHours: 4,
    weekendOtHours: 0,
    weekendRegularPay: 960,
    weekendOtPay: 0,
    hoganSheet: {
      mf_hours: 40,
      we_hours: 4,
      ot_hours: 4,
      rates_php: { regular: 225, weekend: 240, ot_differential: 112.5 },
      pay_php: { base: 9000, weekend: 960, ot_differential: 450 },
    },
  });
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER, CLAIM_225);
  assert.equal(r.staleRateSnapshot ?? false, false);
  assert.equal(r.refreshed, true);
});

// ── Mid-week transfer disclosure through the merge (2026-08-25) ──────────────
//
// Same tri-state contract as the other three blocks — but this one explains no
// MONEY, so it can be the ONLY thing that differs between the snapshot and the
// staged payload. That makes the "transfer-only change fires a refresh" case
// load-bearing rather than incidental: without it, a transfer released after
// the lock could never reach an unpaid stub.

const transferBlock = (p: unknown) =>
  (p as Record<string, unknown>).department_transfer as Record<string, unknown> | null;

const ONE_LEG = { legs: [{ from: 'Lead Gen', to: 'HSL', effective_date: '2026-08-13' }] };

/** The prorated fixture pair minus its proration block: that payload spells out
 *  EVERY `pay_php` key, so `transferOnly()` really does hold every figure still
 *  — which is what makes "only the transfer block moved" a real assertion
 *  rather than an accident of a sparse fixture. */
function transferBaseRow(): StagedPaystubLike {
  const row = proratedStagedRow();
  delete (row.payload as Record<string, unknown>).proration;
  return row;
}

function transferStagedRow(): StagedPaystubLike {
  const row = transferBaseRow();
  (row.payload as Record<string, unknown>).department_transfer = {
    legs: [{ from: 'Lead Gen', to: 'HSL', effective_date: '2026-08-13' }],
  };
  return row;
}

/** Snapshot overrides matching `transferBaseRow()` figure-for-figure. The
 *  explicit `proration: null` matters: the base row carries no block, and the
 *  snapshot must not invent one while we are testing something else. */
function transferOnly(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...proratedSnapOverrides(), proration: null, ...over };
}

test('a snapshot carrying a transfer block replaces the staged one', () => {
  const staged = transferStagedRow();
  // A second leg was released after the lock — the round trip is now complete.
  const nextBlock = {
    legs: [
      { from: 'Lead Gen', to: 'HSL', effective_date: '2026-08-11' },
      { from: 'HSL', to: 'Lead Gen', effective_date: '2026-08-13' },
    ],
  };
  const entry = snapEntry(transferOnly({ departmentTransfer: nextBlock }));
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, true);
  assert.deepEqual(transferBlock(r.payload), nextBlock);
});

test('a transfer-ONLY change fires the refresh (not one figure moved)', () => {
  const staged = transferBaseRow(); // no transfer block at all
  const entry = snapEntry(transferOnly({ departmentTransfer: ONE_LEG }));
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, true);
  assert.deepEqual(transferBlock(r.payload), ONE_LEG);
});

test('an OLD-shape snapshot (no departmentTransfer key) leaves the staged block untouched', () => {
  const staged = transferStagedRow();
  const entry = snapEntry(transferOnly({ regularPay: 8300, initial: 9003.13, final: 8903.13 }));
  delete entry.departmentTransfer; // older snapshots have no such key
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, true);
  assert.deepEqual(transferBlock(r.payload), ONE_LEG);
});

test('departmentTransfer: null clears a stale staged block', () => {
  const staged = transferStagedRow();
  const entry = snapEntry(transferOnly({ departmentTransfer: null }));
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, true);
  assert.equal(transferBlock(r.payload), null);
});

test('an identical transfer block alone does not force a refresh', () => {
  const staged = transferStagedRow();
  // jsonb round-trips reorder object keys, and may hand the legs back in any
  // order — neither may read as a change.
  const scrambled = { legs: [{ to: 'HSL', effective_date: '2026-08-13', from: 'Lead Gen' }] };
  const entry = snapEntry(transferOnly({ departmentTransfer: scrambled }));
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, false);
});

test('an empty leg list and an absent block mean the same thing — no refresh', () => {
  const staged = transferBaseRow(); // no transfer block
  const entry = snapEntry(transferOnly({ departmentTransfer: { legs: [] } }));
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, false);
});

test('an old-shape snapshot over a payload WITHOUT a transfer block never invents the key', () => {
  const staged = transferBaseRow();
  const entry = snapEntry(transferOnly({ regularPay: 8300, initial: 9003.13, final: 8903.13 }));
  delete entry.departmentTransfer;
  const r = mergeSnapshotIntoStaged(staged, snapValue(entry), SNAP_NEWER);
  assert.equal(r.refreshed, true);
  assert.equal('department_transfer' in (r.payload as Record<string, unknown>), false);
});
