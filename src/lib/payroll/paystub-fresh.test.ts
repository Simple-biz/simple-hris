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
