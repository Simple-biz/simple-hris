import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAY_STUB_FIELD_KEYS,
  PAY_STUB_SOURCE_KEYS,
  allFieldsSettled,
  allSourcesSettled,
  anyFieldUnavailable,
  anyFieldUnsettled,
  resolvePayStubFieldStates,
  showsWhileUnsettled,
  worstState,
  type PayStubSourceKey,
  type PayStubSourceStates,
} from './paystub-field-state';

/** All-settled, with the named sources overridden. */
function sources(over: Partial<Record<PayStubSourceKey, 'pending' | 'unavailable'>> = {}): PayStubSourceStates {
  return { ...allSourcesSettled(), ...over };
}

describe('worstState — unavailable is terminal and outranks pending', () => {
  it('empty is settled', () => {
    assert.equal(worstState([]), 'settled');
  });

  it('all settled is settled', () => {
    assert.equal(worstState(['settled', 'settled']), 'settled');
  });

  it('one pending makes it pending', () => {
    assert.equal(worstState(['settled', 'pending', 'settled']), 'pending');
  });

  it('unavailable beats pending, whatever the order', () => {
    // A field with one FAILED input can never become fully settled, so animating
    // it would be the forever-spinner payroll-wizard-step-load.md forbids.
    assert.equal(worstState(['pending', 'unavailable']), 'unavailable');
    assert.equal(worstState(['unavailable', 'pending']), 'unavailable');
  });
});

describe('the omitted-prop contract — everything settled', () => {
  it('allFieldsSettled covers every field key and nothing else', () => {
    const s = allFieldsSettled();
    assert.deepEqual(Object.keys(s).sort(), [...PAY_STUB_FIELD_KEYS].sort());
    for (const k of PAY_STUB_FIELD_KEYS) assert.equal(s[k], 'settled');
  });

  it('allSourcesSettled covers every source key and nothing else', () => {
    const s = allSourcesSettled();
    assert.deepEqual(Object.keys(s).sort(), [...PAY_STUB_SOURCE_KEYS].sort());
  });

  it('a fully-settled source map resolves every field to settled', () => {
    const states = resolvePayStubFieldStates(allSourcesSettled());
    assert.deepEqual(states, allFieldsSettled());
    assert.equal(anyFieldUnsettled(states), false);
    assert.equal(anyFieldUnavailable(states), false);
  });
});

describe('the defect this closes — an in-flight loader never reads as a settled zero', () => {
  it('the PAB merge in flight makes ONLY Attendance Incentive (and Net) pending', () => {
    // Measured: while !pabMergeLoaded, hubstaffRowsForPab is null, so
    // perfectAttendanceEligible returns an EMPTY SET by design, the auto-toggle
    // writes perfect_attendance: false, and the statement prints ₱0.00 for
    // everyone — indistinguishable from a real attendance failure.
    const s = resolvePayStubFieldStates(sources({ pabMerge: 'pending' }));
    assert.equal(s.attendanceBonus, 'pending');
    assert.equal(s.total, 'pending');
    assert.equal(s.totalUsd, 'pending');
    assert.equal(s.regular, 'settled');
    assert.equal(s.adjustment, 'settled');
    assert.equal(s.performanceBonus, 'settled');
  });

  it('the additions blob in flight makes Adjustment AND Orphanage pending', () => {
    // The same condition publishFinalPaySnapshot already refuses to write on:
    // "dispatchData would still carry zeroed adjustments/orphanage/bonus toggles".
    const s = resolvePayStubFieldStates(sources({ additions: 'pending' }));
    assert.equal(s.adjustment, 'pending');
    assert.equal(s.orphanage, 'pending');
    assert.equal(s.attendanceBonus, 'settled');
  });

  it('either KPI loader alone makes Performance Bonus pending', () => {
    for (const k of ['managerKpi', 'hslKpi'] as const) {
      const s = resolvePayStubFieldStates(sources({ [k]: 'pending' }));
      assert.equal(s.performanceBonus, 'pending', k);
    }
  });

  it('rates in flight reach every peso line — they gate on hasRates', () => {
    const s = resolvePayStubFieldStates(sources({ rates: 'pending' }));
    for (const k of [
      'regular', 'overtime', 'weekend', 'timeAdjustment', 'techBonus',
      'attendanceBonus', 'performanceBonus', 'adjustment', 'orphanage', 'mesaDeduction',
    ] as const) {
      assert.equal(s[k], 'pending', k);
    }
    // ...but not the disbursement, which is a flat approved amount.
    assert.equal(s.mesaDisbursement, 'settled');
  });

  it('the MESA opt-out ledger gates the DEDUCTION — a wrong non-zero, not a zero', () => {
    // isMesaOptedOut returns false on an empty set, so during the ledger fetch an
    // opted-out member's stub prints a confident −₱100.00.
    const s = resolvePayStubFieldStates(sources({ mesaOptOut: 'pending' }));
    assert.equal(s.mesaDeduction, 'pending');
    assert.equal(s.mesaDisbursement, 'settled');
  });

  it('the master roster gates Tech Allowance through the 30-day service rule', () => {
    const s = resolvePayStubFieldStates(sources({ masterRoster: 'pending' }));
    assert.equal(s.techBonus, 'pending');
    assert.equal(s.attendanceBonus, 'settled');
  });

  it('the time-adjustment rows gate their own line and nothing else', () => {
    const s = resolvePayStubFieldStates(sources({ timeAdjustments: 'pending' }));
    assert.equal(s.timeAdjustment, 'pending');
    assert.equal(s.regular, 'settled');
  });
});

describe('Net inherits — a shimmering line under a confident total is the 2026-09-22 defect', () => {
  it('every peso line holds Net back', () => {
    const lines = [
      'weekHours', 'rates', 'pabMerge', 'pabPeriod', 'additions', 'managerKpi',
      'hslKpi', 'timeAdjustments', 'mesaDisbursements', 'mesaOptOut', 'masterRoster',
    ] as const;
    for (const src of lines) {
      const s = resolvePayStubFieldStates(sources({ [src]: 'pending' }));
      assert.equal(s.total, 'pending', `${src} must hold Net back`);
    }
  });

  it('FX alone moves the USD and COP figures but NOT the peso Net', () => {
    // mapPayloadToPayStub falls back to a hardcoded 58 when the cycle rate is
    // absent, so the dollar figure is plausible, wrong and indistinguishable.
    const s = resolvePayStubFieldStates(sources({ fx: 'pending' }));
    assert.equal(s.total, 'settled');
    assert.equal(s.totalUsd, 'pending');
    assert.equal(s.totalCop, 'pending');
  });

  it('a failed peso line makes Net unavailable, not pending', () => {
    const s = resolvePayStubFieldStates(sources({ additions: 'unavailable' }));
    assert.equal(s.adjustment, 'unavailable');
    assert.equal(s.total, 'unavailable');
    assert.equal(anyFieldUnavailable(s), true);
  });

  it('a failed input beside an in-flight one still resolves unavailable', () => {
    const s = resolvePayStubFieldStates(sources({ additions: 'unavailable', pabMerge: 'pending' }));
    assert.equal(s.total, 'unavailable');
  });
});

describe('settledByPolicy — a zero the RULES decided must never shimmer', () => {
  it('a non-final PAB week keeps Attendance Incentive settled through an in-flight merge', () => {
    // PAB is ₱0.00 on every week of the month but the last. Shimmering it on the
    // other three tells a clerk to wait for money that is never coming.
    const s = resolvePayStubFieldStates(sources({ pabMerge: 'pending' }), {
      settledByPolicy: ['attendanceBonus'],
    });
    assert.equal(s.attendanceBonus, 'settled');
  });

  it('a policy-settled line does not hold Net back', () => {
    const s = resolvePayStubFieldStates(sources({ pabMerge: 'pending' }), {
      settledByPolicy: ['attendanceBonus'],
    });
    assert.equal(s.total, 'settled');
    assert.equal(anyFieldUnsettled(s), false);
  });

  it('it only moves the named field — the rest still resolve from their loaders', () => {
    const s = resolvePayStubFieldStates(sources({ pabMerge: 'pending', additions: 'pending' }), {
      settledByPolicy: ['attendanceBonus'],
    });
    assert.equal(s.attendanceBonus, 'settled');
    assert.equal(s.adjustment, 'pending');
    assert.equal(s.total, 'pending');
  });

  it('it can only move a field TOWARDS settled — it never invents an unsettled one', () => {
    const s = resolvePayStubFieldStates(allSourcesSettled(), { settledByPolicy: ['orphanage'] });
    assert.deepEqual(s, allFieldsSettled());
  });

  it('forcing every contributor settles Net even with every loader in flight', () => {
    const everythingPending = Object.fromEntries(
      PAY_STUB_SOURCE_KEYS.map((k) => [k, 'pending' as const]),
    ) as PayStubSourceStates;
    const s = resolvePayStubFieldStates(everythingPending, {
      settledByPolicy: PAY_STUB_FIELD_KEYS,
    });
    assert.deepEqual(s, allFieldsSettled());
  });
});

describe('showsWhileUnsettled — the three ABSENT-not-zero lines', () => {
  it('a settled line obeys the shared predicate exactly, both ways', () => {
    // This is what keeps the three renderers in agreement about every statement
    // anyone is ever sent (paystub-dispatch.md § Line visibility).
    assert.equal(showsWhileUnsettled(true, 'settled'), true);
    assert.equal(showsWhileUnsettled(false, 'settled'), false);
  });

  it('an unsettled line renders even when the predicate would suppress it', () => {
    // An unloaded Orphanage / Time Adjustment vanishes today, and a vanished row
    // is less visible than a zeroed one, not more — Kane 2026-09-22.
    assert.equal(showsWhileUnsettled(false, 'pending'), true);
    assert.equal(showsWhileUnsettled(false, 'unavailable'), true);
  });

  it('it never HIDES a line the predicate wants shown', () => {
    for (const st of ['settled', 'pending', 'unavailable'] as const) {
      assert.equal(showsWhileUnsettled(true, st), true, st);
    }
  });
});

describe('anyFieldUnsettled / anyFieldUnavailable', () => {
  it('both false on the all-clear', () => {
    const s = allFieldsSettled();
    assert.equal(anyFieldUnsettled(s), false);
    assert.equal(anyFieldUnavailable(s), false);
  });

  it('pending is unsettled but not unavailable', () => {
    const s = resolvePayStubFieldStates(sources({ hslKpi: 'pending' }));
    assert.equal(anyFieldUnsettled(s), true);
    assert.equal(anyFieldUnavailable(s), false);
  });

  it('unavailable is both', () => {
    const s = resolvePayStubFieldStates(sources({ hslKpi: 'unavailable' }));
    assert.equal(anyFieldUnsettled(s), true);
    assert.equal(anyFieldUnavailable(s), true);
  });
});
