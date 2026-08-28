import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickWizardSnapshotEntry,
  resolveWizardRowValues,
  snapshotEntryIsItemized,
  snapshotIsNewerThanLock,
  snapshotRateContradictsCatalog,
  type StagedLockedRow,
  type WizardSnapshotEntry,
} from './wizard-dispatch-values';

/** A fully itemized snapshot entry — the post-2026-07-18 shape. */
function snap(over: Partial<WizardSnapshotEntry> = {}): WizardSnapshotEntry {
  return {
    workEmail: 'a@simple.biz',
    final: 10_000,
    regularPay: 9_000,
    otPay: 0,
    regularHours: 40,
    otHours: 0,
    totalHours: 40,
    initial: 9_000,
    mesaDeduction: 100,
    mesaDisbursement: 0,
    perfectAttendanceBonus: 0,
    techBonus: 0,
    otherBonuses: 1_100,
    adjustment: 0,
    orphanagePay: 0,
    regularRate: 225,
    otRate: 337.5,
    ...over,
  };
}

function staged(over: Partial<StagedLockedRow> = {}): StagedLockedRow {
  return {
    amountPHP: 8_500,
    amountUSD: 140,
    lockedAt: '2026-08-11T17:30:00.000Z',
    excluded: false,
    payPhp: {
      regular: 8_000,
      ot: 0,
      initial: 8_000,
      bonuses_total: 600,
      perfect_attendance_bonus: 0,
      tech_bonus: 0,
      other_bonuses: 600,
      adjustment: 0,
      orphanage_pay: 0,
      mesa_deduction: 100,
      mesa_disbursement: 0,
      final: 8_500,
    },
    hours: { total: 38.5, regular: 38.5, ot: 0 },
    ...over,
  };
}

const NEWER = '2026-08-11T19:37:00.000Z';
const OLDER = '2026-08-11T12:00:00.000Z';

describe('snapshotIsNewerThanLock', () => {
  it('is true only when the snapshot provably post-dates the lock', () => {
    assert.equal(snapshotIsNewerThanLock(NEWER, '2026-08-11T17:30:00.000Z'), true);
    assert.equal(snapshotIsNewerThanLock(OLDER, '2026-08-11T17:30:00.000Z'), false);
  });

  it('treats an equal timestamp as NOT newer', () => {
    assert.equal(snapshotIsNewerThanLock(NEWER, NEWER), false);
  });

  it('cannot be held back by an absent or unparseable lock time', () => {
    assert.equal(snapshotIsNewerThanLock(NEWER, null), true);
    assert.equal(snapshotIsNewerThanLock(NEWER, 'not-a-date'), true);
  });

  it('is false when the snapshot has no usable timestamp', () => {
    assert.equal(snapshotIsNewerThanLock(null, null), false);
    assert.equal(snapshotIsNewerThanLock('nonsense', null), false);
  });
});

describe('snapshotEntryIsItemized', () => {
  it('requires the whole bonus split', () => {
    assert.equal(snapshotEntryIsItemized(snap()), true);
    assert.equal(snapshotEntryIsItemized(snap({ otherBonuses: undefined })), false);
    assert.equal(snapshotEntryIsItemized(snap({ techBonus: undefined })), false);
    assert.equal(snapshotEntryIsItemized(snap({ perfectAttendanceBonus: undefined })), false);
  });

  it('counts an explicit null as itemized — zero is a real answer', () => {
    assert.equal(snapshotEntryIsItemized(snap({ otherBonuses: null })), true);
  });
});

describe('snapshotRateContradictsCatalog', () => {
  it('fails open with no catalog claim', () => {
    assert.equal(snapshotRateContradictsCatalog(snap(), null), false);
    assert.equal(snapshotRateContradictsCatalog(snap(), undefined), false);
  });

  it('rejects a snapshot priced at a superseded regular rate', () => {
    assert.equal(
      snapshotRateContradictsCatalog(snap({ regularRate: 175, otRate: 262.5 }), { regular: 225, ot: 337.5 }),
      true,
    );
  });

  it('accepts sub-centavo rate noise', () => {
    assert.equal(
      snapshotRateContradictsCatalog(snap({ regularRate: 225.004 }), { regular: 225, ot: 337.5 }),
      false,
    );
  });

  it('ignores the OT column for an HSL sheet-form row (derived differential)', () => {
    const hsl = snap({ otRate: 112.5, hoganSheet: { mf_hours: 32 } });
    assert.equal(snapshotRateContradictsCatalog(hsl, { regular: 225, ot: 337.5 }), false);
    // …but a wrong REGULAR rate is still caught on the same row.
    assert.equal(
      snapshotRateContradictsCatalog({ ...hsl, regularRate: 175 }, { regular: 225, ot: 337.5 }),
      true,
    );
  });

  it('cannot judge a snapshot that carries no rates', () => {
    assert.equal(
      snapshotRateContradictsCatalog(snap({ regularRate: undefined, otRate: undefined }), { regular: 225, ot: 337.5 }),
      false,
    );
  });
});

describe('pickWizardSnapshotEntry', () => {
  it('matches on the work email', () => {
    const e = snap();
    assert.equal(pickWizardSnapshotEntry({ 'a@simple.biz': e }, 'A@Simple.biz '), e);
  });

  it('never matches through a personal-email alias belonging to someone else', () => {
    // The finals map keys the SAME entry under work AND personal email; personal
    // addresses are shared/recycled, so an alias hit could pay another person.
    const e = snap({ workEmail: 'a@simple.biz' });
    const finals = { 'a@simple.biz': e, 'shared@gmail.com': e };
    assert.equal(pickWizardSnapshotEntry(finals, 'shared@gmail.com'), null);
  });

  it('rejects an entry with no finite total', () => {
    assert.equal(
      pickWizardSnapshotEntry({ 'a@simple.biz': snap({ final: Number.NaN }) }, 'a@simple.biz'),
      null,
    );
  });

  it('is null-safe on an absent map or email', () => {
    assert.equal(pickWizardSnapshotEntry(null, 'a@simple.biz'), null);
    assert.equal(pickWizardSnapshotEntry({ 'a@simple.biz': snap() }, ''), null);
  });
});

describe('resolveWizardRowValues', () => {
  const finals = { 'a@simple.biz': snap() };
  const base = { workEmail: 'a@simple.biz', finals, snapshotUpdatedAt: NEWER };

  it('prefers a qualifying snapshot and itemizes from it', () => {
    const v = resolveWizardRowValues({ ...base, staged: staged() });
    assert.equal(v?.source, 'snapshot');
    assert.equal(v?.amountPHP, 10_000);
    assert.equal(v?.breakdown?.bonusTotalPHP, 1_100);
    assert.equal(v?.breakdown?.initialPayPHP, 9_000);
    assert.equal(v?.breakdown?.mesaDeductionPHP, 100);
    assert.equal(v?.breakdown?.totalHours, 40);
    // The bonus total's own parts travel with it, so a worksheet can show WHY
    // the total is what it is instead of an unexplained residual.
    assert.equal(v?.breakdown?.otherBonusesPHP, 1_100);
    assert.equal(v?.breakdown?.adjustmentPHP, 0);
  });

  it('flags a snapshot that re-priced the person AFTER the lock', () => {
    const v = resolveWizardRowValues({ ...base, staged: staged() });
    assert.equal(v?.repricedAfterLock, true);
    assert.equal(v?.lockedAmountPHP, 8_500);
  });

  it('does not flag a re-price when the snapshot agrees with the lock', () => {
    const v = resolveWizardRowValues({ ...base, staged: staged({ amountPHP: 10_000 }) });
    assert.equal(v?.source, 'snapshot');
    assert.equal(v?.repricedAfterLock, false);
  });

  // The re-lock case: staging stamps a fresh locked_at, so a snapshot published
  // before it is stale by definition. The LOCKED figures must win — this is what
  // makes "unlock and re-lock" authoritative over Payment Dispatch.
  it('falls back to the LOCK when the snapshot predates it', () => {
    const v = resolveWizardRowValues({ ...base, snapshotUpdatedAt: OLDER, staged: staged() });
    assert.equal(v?.source, 'lock');
    assert.equal(v?.amountPHP, 8_500);
    assert.equal(v?.amountUSD, 140);
    assert.equal(v?.breakdown?.bonusTotalPHP, 600);
    assert.equal(v?.breakdown?.totalHours, 38.5);
    assert.equal(v?.breakdown?.otherBonusesPHP, 600);
    assert.equal(v?.breakdown?.adjustmentPHP, 0);
    assert.equal(v?.repricedAfterLock, false);
  });

  it('falls back to the LOCK for a wizard-held (do-not-pay) row', () => {
    const v = resolveWizardRowValues({ ...base, staged: staged({ excluded: true }) });
    assert.equal(v?.source, 'lock');
    assert.equal(v?.amountPHP, 8_500);
  });

  it('falls back to the LOCK for a total-only (pre-itemization) snapshot', () => {
    const v = resolveWizardRowValues({
      workEmail: 'a@simple.biz',
      finals: { 'a@simple.biz': snap({ perfectAttendanceBonus: undefined, techBonus: undefined, otherBonuses: undefined }) },
      snapshotUpdatedAt: NEWER,
      staged: staged(),
    });
    assert.equal(v?.source, 'lock');
    assert.equal(v?.amountPHP, 8_500);
  });

  it('falls back to the LOCK and flags a catalog-contradicting snapshot', () => {
    const v = resolveWizardRowValues({
      workEmail: 'a@simple.biz',
      finals: { 'a@simple.biz': snap({ regularRate: 175 }) },
      snapshotUpdatedAt: NEWER,
      staged: staged(),
      catalogClaim: { regular: 225, ot: 337.5 },
    });
    assert.equal(v?.source, 'lock');
    assert.equal(v?.staleRateSnapshot, true);
  });

  it('keeps the snapshot when the catalog agrees', () => {
    const v = resolveWizardRowValues({
      ...base,
      staged: staged(),
      catalogClaim: { regular: 225, ot: 337.5 },
    });
    assert.equal(v?.source, 'snapshot');
    assert.equal(v?.staleRateSnapshot, false);
  });

  it('uses the snapshot for a payee the wizard never staged', () => {
    const v = resolveWizardRowValues({ ...base, staged: null });
    assert.equal(v?.source, 'snapshot');
    assert.equal(v?.amountPHP, 10_000);
    assert.equal(v?.lockedAmountPHP, null);
    assert.equal(v?.repricedAfterLock, false);
  });

  // Rule 3 of the replay contract: an absent saved value falls back to LIVE
  // computation, never to ₱0. This module says "nothing"; the caller keeps
  // computeCurrentPay's figure.
  it('returns null when neither carrier can speak for the payee', () => {
    assert.equal(resolveWizardRowValues({ ...base, workEmail: 'nobody@simple.biz', staged: null }), null);
    assert.equal(
      resolveWizardRowValues({ workEmail: 'a@simple.biz', finals: {}, snapshotUpdatedAt: null, staged: null }),
      null,
    );
  });

  it('returns null when a staged row carries no locked total and no snapshot qualifies', () => {
    const v = resolveWizardRowValues({
      ...base,
      snapshotUpdatedAt: OLDER,
      staged: staged({ amountPHP: null, payPhp: null }),
    });
    assert.equal(v, null);
  });

  it('reports an unavailable breakdown rather than inventing one', () => {
    // A step-6 (Validation) held row is staged with a total but `payload: null`.
    const v = resolveWizardRowValues({
      ...base,
      snapshotUpdatedAt: OLDER,
      staged: staged({ payPhp: null, hours: null }),
    });
    assert.equal(v?.source, 'lock');
    assert.equal(v?.amountPHP, 8_500);
    assert.equal(v?.breakdown, null);
  });

  it('carries a NEGATIVE bonus total through (Adj. outweighing the bonuses)', () => {
    // Live 2026-08-02 cycle: aimei@ locked ₱6,023.50 = ₱6,272.06 initial with a
    // −₱248.56 Adj. The chip must be able to say so.
    const v = resolveWizardRowValues({
      workEmail: 'a@simple.biz',
      finals: {
        'a@simple.biz': snap({
          final: 6_023.5,
          initial: 6_272.06,
          regularPay: 6_272.06,
          otherBonuses: 0,
          adjustment: -248.56,
          mesaDeduction: 0,
        }),
      },
      snapshotUpdatedAt: NEWER,
      staged: staged({ amountPHP: 6_023.5 }),
    });
    assert.equal(v?.amountPHP, 6_023.5);
    assert.equal(v?.breakdown?.bonusTotalPHP, -248.56);
    // And the withholding is nameable on its own, not just visible as a negative
    // aggregate: ₱0 earned, −₱248.56 adjusted.
    assert.equal(v?.breakdown?.otherBonusesPHP, 0);
    assert.equal(v?.breakdown?.adjustmentPHP, -248.56);
  });

  it('splits the bonus total into its four named parts, from either carrier', () => {
    const parts = { perfectAttendanceBonus: 5_000, techBonus: 1_850, otherBonuses: 600, adjustment: -250 };
    const fromSnapshot = resolveWizardRowValues({
      workEmail: 'a@simple.biz',
      finals: { 'a@simple.biz': snap({ ...parts, final: 16_200, initial: 9_000, mesaDeduction: 0 }) },
      snapshotUpdatedAt: NEWER,
      staged: null,
    })!.breakdown!;
    const fromLock = resolveWizardRowValues({
      workEmail: 'a@simple.biz',
      finals: null,
      snapshotUpdatedAt: null,
      staged: staged({
        amountPHP: 16_200,
        payPhp: {
          regular: 9_000, ot: 0, initial: 9_000,
          bonuses_total: 7_200,
          perfect_attendance_bonus: 5_000, tech_bonus: 1_850, other_bonuses: 600, adjustment: -250,
          orphanage_pay: 0, mesa_deduction: 0, mesa_disbursement: 0, final: 16_200,
        },
      }),
    })!.breakdown!;
    for (const b of [fromSnapshot, fromLock]) {
      const split = b.pabBonusPHP + b.techBonusPHP + b.otherBonusesPHP + b.adjustmentPHP;
      assert.equal(Math.round(split * 100) / 100, b.bonusTotalPHP);
      assert.equal(b.adjustmentPHP, -250);
      assert.equal(b.otherBonusesPHP, 600);
    }
  });

  it('reconciles: initial + bonuses + orphanage − mesa + disbursement === total', () => {
    const v = resolveWizardRowValues({
      workEmail: 'a@simple.biz',
      finals: {
        'a@simple.biz': snap({
          initial: 9_000,
          otherBonuses: 1_100,
          orphanagePay: 500,
          mesaDeduction: 100,
          mesaDisbursement: 300,
          final: 10_800,
        }),
      },
      snapshotUpdatedAt: NEWER,
      staged: null,
    });
    const b = v!.breakdown!;
    const recomposed =
      (b.initialPayPHP ?? 0) + b.bonusTotalPHP + b.orphanagePayPHP - b.mesaDeductionPHP + b.mesaDisbursementPHP;
    assert.equal(Math.round(recomposed * 100) / 100, v!.amountPHP);
  });
});
