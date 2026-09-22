import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PayStubStatement } from '@/components/paystub/PayStubStatement';
import { mapPayloadToPayStub, type PayStubView } from './paystub-view';
import { renderPayStubEmailHtml } from './paystub-email-html';
import {
  PAY_STUB_FIELD_KEYS,
  allFieldsSettled,
  allSourcesSettled,
  resolvePayStubFieldStates,
  type PayStubFieldStates,
} from './paystub-field-state';

// ── The Step-8 preview's per-line pending state (2026-09-22) ─────────────────
//
// The Payroll Wizard's "Preview Emails" dialog renders the SHARED statement off
// `dispatchData` rows whose fetches have not all landed, and every one of those
// loaders resets to the same empty value it initialises with — so *in flight*,
// *failed* and *genuinely none* printed as one identical ₱0.00.
//
// Two things are pinned here, and the first matters more than the feature:
//
//  1. **Omitting the prop is byte-identical.** Every employee-facing mount, the
//     emailed copy and both exports must render exactly what they rendered
//     before. Same contract the weekend, proration, transfer and
//     time-adjustment blocks each carry.
//  2. **A pending marker can never leave the preview.** It is a React prop and
//     not a `PayStubView` field, precisely because the view is what the email
//     renderer, the workbook builder and the staged queue payload are built
//     from. These tests hold that door shut at runtime as well as in the types.

/** A realistic non-HSL payload: no weekend carve-out, no orphanage, no adjustment. */
function plainPayload(): Record<string, unknown> {
  return {
    name: 'Dela Cruz, Maria S.',
    email: 'mariad@simple.biz',
    personal_email: 'maria.delacruz@gmail.com',
    department_name: 'Lead Generation',
    pay_period: { week: { start: '2026-09-06', end: '2026-09-12' }, fx_rate: 58.75 },
    hours: { total: 42, regular: 40, ot: 2 },
    rates_php: { regular: 300, ot: 375 },
    pay_php: {
      regular: 12000,
      ot: 750,
      initial: 12750,
      perfect_attendance_bonus: 5000,
      tech_bonus: 1850,
      other_bonuses: 1200,
      adjustment: 0,
      mesa_deduction: 100,
      mesa_disbursement: 0,
      orphanage_pay: 0,
      bonuses_total: 8050,
      final: 20700,
    },
    time_adjustment: { hours: 0, pay_php: 0, days: [] },
  };
}

/** The same week with money on all three of the ABSENT-not-zero lines. */
function richPayload(): Record<string, unknown> {
  const p = plainPayload();
  return {
    ...p,
    pay_php: { ...(p.pay_php as Record<string, unknown>), orphanage_pay: 500 },
    weekend: {
      hours: { regular: 8, ot: 0 },
      pay_php: { regular: 2520, ot: 0 },
      premium_php_per_hour: 15,
    },
    time_adjustment: {
      hours: 0.5,
      pay_php: 150,
      days: [{ date: '2026-09-10', hours: 0.5 }],
    },
  };
}

function render(view: PayStubView, fieldStates?: PayStubFieldStates): string {
  return renderToStaticMarkup(
    React.createElement(PayStubStatement, { view, fieldStates }),
  );
}

/** All-settled, with the named sources overridden, folded to field states. */
function states(over: Record<string, 'pending' | 'unavailable'>): PayStubFieldStates {
  return resolvePayStubFieldStates({ ...allSourcesSettled(), ...over } as never);
}

const PENDING_MARK = 'paystub-pending-bar';
const UNAVAILABLE_MARK = 'Unavailable';

describe('the byte-identical contract — every surface but the wizard preview', () => {
  for (const [label, payload] of [
    ['a plain non-HSL week', plainPayload()],
    ['a week with weekend, orphanage and a time adjustment', richPayload()],
  ] as const) {
    it(`omitting fieldStates renders exactly as before — ${label}`, () => {
      const view = mapPayloadToPayStub(payload);
      assert.equal(render(view), render(view, undefined));
    });

    it(`an all-settled map is identical to omitting it — ${label}`, () => {
      // Belt and braces: the component substitutes `allFieldsSettled()` for an
      // omitted prop, so these two must be the same string or the substitution
      // itself is changing the document.
      const view = mapPayloadToPayStub(payload);
      assert.equal(render(view, allFieldsSettled()), render(view));
    });

    it(`neither marker appears anywhere when settled — ${label}`, () => {
      const html = render(mapPayloadToPayStub(payload));
      assert.ok(!html.includes(PENDING_MARK), 'no shimmer on a settled statement');
      assert.ok(!html.includes(UNAVAILABLE_MARK), 'no Unavailable on a settled statement');
    });
  }

  it('a settled statement still prints ₱0.00 on the always-render lines', () => {
    // paystub-dispatch.md § Line visibility: Regular, Overtime, Tech, Attendance,
    // Performance, Adjustment and the MESA pair always render, ₱0.00 included, so
    // the breakdown reconciles to Net the same way on every document. The pending
    // state scopes that to SETTLED data; it does not repeal it.
    const html = render(mapPayloadToPayStub(plainPayload()));
    assert.ok(html.includes('Adjustment'));
    assert.ok(html.includes('₱0.00'), 'a settled zero is still a printed zero');
  });
});

describe('a pending line swaps its figure, keeps its row, and holds Net back', () => {
  it('the PAB merge in flight shimmers ONLY Attendance Incentive and the totals', () => {
    const view = mapPayloadToPayStub(plainPayload());
    const html = render(view, states({ pabMerge: 'pending' }));
    assert.ok(html.includes(PENDING_MARK));
    // The label and its position survive — only the cells that would assert a
    // figure are swapped.
    assert.ok(html.includes('Attendance Incentive'));
    assert.ok(!html.includes('₱5,000.00'), 'the PAB figure must not be asserted');
    // Untouched lines keep their real amounts.
    assert.ok(html.includes('₱12,000.00'), 'Regular Hours is unaffected');
    assert.ok(html.includes('₱1,850.00'), 'Tech Allowance is unaffected');
    // Net is the sum of every line above it, so it cannot stay confident.
    assert.ok(!html.includes('₱20,700.00'), 'Net must not be asserted under a pending line');
  });

  it('rates in flight reach every peso line but never the MESA reimbursement', () => {
    const view = mapPayloadToPayStub(plainPayload());
    const html = render(view, states({ rates: 'pending' }));
    assert.ok(!html.includes('₱12,000.00'));
    assert.ok(!html.includes('₱300.00'), 'the hours × rate detail is a claim too');
    assert.ok(html.includes('MESA Reimbursement'));
  });

  it('a pending line drops its signed colour — a red bar would assert a deduction', () => {
    const view = mapPayloadToPayStub(plainPayload());
    const html = render(view, states({ mesaOptOut: 'pending' }));
    assert.ok(html.includes('MESA Deduction'));
    assert.ok(!html.includes('-₱100.00'), 'the wrong NON-zero must not be asserted');
    assert.ok(!html.includes('!text-[#b3261e]'), 'no red on an unknown figure');
    // ...while the reimbursement keeps its teal, because it is settled.
    assert.ok(html.includes('!text-[#0f766e]'));
  });

  it('an FX read in flight holds the USD figure but NOT the peso Net', () => {
    const view = mapPayloadToPayStub(plainPayload());
    const html = render(view, states({ fx: 'pending' }));
    assert.ok(html.includes('₱20,700.00'), 'the peso Net does not depend on the rate');
    assert.ok(!html.includes(' USD'), 'the dollar figure is Net × an unread rate');
    assert.ok(html.includes(PENDING_MARK));
  });
});

describe('unavailable is terminal — it says the word and never animates', () => {
  it('a failed additions read prints Unavailable on Adjustment and Orphanage', () => {
    const view = mapPayloadToPayStub(richPayload());
    const html = render(view, states({ additions: 'unavailable' }));
    assert.ok(html.includes(UNAVAILABLE_MARK));
    assert.ok(html.includes('Adjustment'));
    assert.ok(!html.includes('₱500.00'), 'the orphanage figure must not be asserted');
  });

  it('a failed read NEVER shimmers — that is the forever-spinner', () => {
    // payroll-wizard-step-load.md §: a flag that never settles must not drive an
    // animation; kpi-calculator-week-unresolved-hang: an unresolvable input is
    // TERMINAL, not pending.
    const everythingFailed = Object.fromEntries(
      PAY_STUB_FIELD_KEYS.map((k) => [k, 'unavailable' as const]),
    ) as PayStubFieldStates;
    const html = render(mapPayloadToPayStub(richPayload()), everythingFailed);
    assert.ok(!html.includes(PENDING_MARK), 'nothing may animate when nothing is coming');
    assert.ok(html.includes(UNAVAILABLE_MARK));
  });

  it('unavailable outranks pending on the same statement', () => {
    // `weekHours` and not `pabMerge` for the pending half: since every line that
    // reads `pabMerge` also reads `additions`, a failed blob makes those lines
    // unavailable outright and there is no shimmer left to observe. The hours
    // lines are the ones genuinely independent of the additions blob.
    const view = mapPayloadToPayStub(plainPayload());
    const html = render(view, states({ additions: 'unavailable', weekHours: 'pending' }));
    assert.ok(html.includes(UNAVAILABLE_MARK));
    assert.ok(html.includes(PENDING_MARK), 'the still-loading line keeps its shimmer');
    // Net inherits the WORST of the two.
    assert.ok(!html.includes('₱20,700.00'));
  });
});

describe('the three ABSENT-not-zero lines render while unsettled (Kane 2026-09-22)', () => {
  it('an unloaded Time Adjustment shows its row instead of vanishing', () => {
    // showsTimeAdjustmentLine keys on the MONEY, so an unloaded credit suppresses
    // the row AND leaves Net short — a vanished line is less visible than a
    // zeroed one, not more.
    const view = mapPayloadToPayStub(plainPayload());
    assert.ok(!render(view).includes('Time Adjustment'), 'settled: correctly absent');
    const html = render(view, states({ timeAdjustments: 'pending' }));
    assert.ok(html.includes('Time Adjustment'), 'pending: the row is there to be seen');
    assert.ok(html.includes(PENDING_MARK));
  });

  it('an unloaded Orphanage shows its row instead of vanishing', () => {
    const view = mapPayloadToPayStub(plainPayload());
    assert.ok(!render(view).includes('Orphanage'));
    assert.ok(render(view, states({ additions: 'pending' })).includes('Orphanage'));
  });

  it('an unloaded Weekend shows its row instead of vanishing', () => {
    const view = mapPayloadToPayStub(plainPayload());
    assert.ok(!render(view).includes('Weekend Hours'));
    assert.ok(render(view, states({ weekHours: 'pending' })).includes('Weekend Hours'));
  });

  it('once settled the shared predicate decides again, both ways', () => {
    // This is what keeps the three renderers in agreement about every statement
    // anyone is ever sent (paystub-dispatch.md § Line visibility).
    const plain = render(mapPayloadToPayStub(plainPayload()), allFieldsSettled());
    assert.ok(!plain.includes('Orphanage'));
    const rich = render(mapPayloadToPayStub(richPayload()), allFieldsSettled());
    assert.ok(rich.includes('Orphanage'));
    assert.ok(rich.includes('Weekend Hours'));
    assert.ok(rich.includes('Time Adjustment'));
  });
});

describe('the bar must be able to be SEEN — Kane: "it just blanked itself"', () => {
  it('carries no sizing utilities, so it cannot render zero-size', () => {
    // The first cut sized it with `w-[62px] h-[11px]` on an empty <span>. An
    // empty inline element whose only size comes from two arbitrary utilities is
    // INVISIBLE the moment either fails to generate — and the whole job of a
    // placeholder is to be visible. `.paystub-pending-bar` now carries its own
    // em-relative width/height in CSS. Do not put sizing classes back.
    const html = render(mapPayloadToPayStub(plainPayload()), states({ pabMerge: 'pending' }));
    const bar = /<span class="([^"]*paystub-pending-bar[^"]*)"/.exec(html);
    assert.ok(bar, 'the bar renders');
    assert.equal(bar[1].trim(), 'paystub-pending-bar', 'no extra classes carry its size');
  });

  it('is marked aria-hidden and paired with readable text', () => {
    const html = render(mapPayloadToPayStub(plainPayload()), states({ pabMerge: 'pending' }));
    assert.ok(html.includes('aria-hidden="true"'));
    assert.ok(html.includes('still loading'), 'a screen reader hears the state');
  });
});

describe('the marker can never leave the preview — the structural guarantee', () => {
  it('mapPayloadToPayStub output carries no field-state key', () => {
    // The view is what renderPayStubEmailHtml, buildPayStubsWorkbook and the
    // staged paystub_dispatch_queue payload are all built from. One stray key
    // here and a shimmer is emailed, exported and re-rendered days later.
    for (const payload of [plainPayload(), richPayload()]) {
      const view = mapPayloadToPayStub(payload) as unknown as Record<string, unknown>;
      for (const k of PAY_STUB_FIELD_KEYS) {
        assert.ok(!(`${k}State` in view), `${k}State must not be on the view`);
      }
      assert.ok(!('fieldStates' in view), 'fieldStates must not be on the view');
      assert.ok(!('pending' in view), 'pending must not be on the view');
    }
  });

  it('the emailed statement carries neither marker, for either payload', () => {
    for (const payload of [plainPayload(), richPayload()]) {
      const html = renderPayStubEmailHtml(mapPayloadToPayStub(payload));
      assert.ok(!html.includes(PENDING_MARK));
      assert.ok(!html.includes(UNAVAILABLE_MARK));
      assert.ok(!html.includes('still loading'));
    }
  });

  it('the emailed statement still prints the figures the preview would shimmer', () => {
    // The email is rendered from the view alone, so a preview that is mid-load
    // cannot make the emailed copy of the SAME view lose a number. Asserted on
    // the digits, not on "₱": the email renderer escapes the sign to `&#8369;`
    // for clients that mangle the UTF-8 byte, which the component does not.
    const html = renderPayStubEmailHtml(mapPayloadToPayStub(plainPayload()));
    assert.ok(html.includes('&#8369;5,000.00'), 'Attendance Incentive is present');
    assert.ok(html.includes('&#8369;20,700.00'), 'Net is present');
  });
});
