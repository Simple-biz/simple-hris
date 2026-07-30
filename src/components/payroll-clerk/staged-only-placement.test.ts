import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStagedOnlyPlacement, buildQueueFromRates, type StagedOnlyPayee } from './mock-queue';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { CurrentPayEntry } from '@/lib/payroll/current-pay';

/**
 * Payment Dispatch's queue is built from `employee_hourly_rates` (the legacy
 * rates sheet). Since the Payment Catalog became the rate source of truth,
 * catalog-paid people have NO rates row, so the queue builder can never emit
 * them — the wizard-staged safety net is the only thing that surfaces them.
 *
 * That net used to synthesize a row from the staged paystub ALONE: it never
 * consulted `employee_ids`, so it hardcoded `bankPreferredRaw: null` and
 * `payable: null`. Live result (vanessade@simple.biz, 2026-07-29): a person with
 * complete GoTyme wire details and Bank Preferred = Wise on both the People tab
 * and the Payment Catalog showed in Excluded as "No bank" + "No rate on file"
 * and "Can't pay here" — unpayable no matter how many times her bank details
 * were re-saved. 7 people / ₱59,911 were stranded that way in one cycle.
 *
 * These tests pin the net to the SAME enrichment + routing precedence
 * buildQueueFromRates applies to everyone else.
 */

function idsRow(over: Partial<EmployeeIdRow> = {}): EmployeeIdRow {
  return {
    employee_id: 'SELF-EC191F06E4C943',
    name: 'Delatado, Vanessa "Vanessa"',
    work_email: 'vanessade@simple.biz',
    personal_email: 'vanessadelatado.va@gmail.com',
    preferred_bank_slot: 'primary',
    bank_name: 'GoTyme',
    account_holder_name: 'VANESSA JOY DE LEON DELATADO',
    account_number: '012903983941',
    routing_number: null,
    alt_bank_name: null,
    alt_account_holder_name: null,
    alt_account_number: null,
    alt_routing_number: null,
    preferred_processor: 'wise',
    bank_preferred: null,
    hurupay_email: null,
    wepay_email: null,
    higlobe_email: null,
    higlobe_account_name: null,
    wise_email: null,
    wise_tag: null,
    phone_number: null,
    swift_code: 'GOTYPHM2XXX',
    full_address: '565 Nierva Street, Brgy.La Purisima, Nabua, Camarines Sur',
    ...over,
  };
}

function staged(over: Partial<StagedOnlyPayee> = {}): StagedOnlyPayee {
  return {
    recipient_email: 'vanessade@simple.biz',
    personal_email: 'vanessadelatado.va@gmail.com',
    recipient_name: 'Vanessa Joy Delatado',
    department_key: 'edit',
    amount_php: 11427.31,
    amount_usd: 185.27,
    excluded: false,
    sent_at: null,
    ...over,
  };
}

function payEntry(over: Partial<CurrentPayEntry> = {}): CurrentPayEntry {
  return {
    totalHours: 44.82,
    regularHours: 40,
    otHours: 4.82,
    regularPayPHP: 9000,
    otPayPHP: 1627.31,
    initialPayPHP: 10627.31,
    initialPayUSD: 172.3,
    pabBonusPHP: 800,
    techBonusPHP: 0,
    bonusTotalPHP: 800,
    mesaDeductionPHP: 0,
    totalPayPHP: 11427.31,
    totalPayUSD: 185.27,
    totalPayCOP: null,
    hasRate: true,
    payCurrency: 'PHP',
    countryCurrency: null,
    departmentKey: 'edit',
    departmentName: 'Edit Team',
    ...over,
  };
}

test('staged-only payee with complete bank details is PAYABLE, not excluded as no-bank', () => {
  const p = buildStagedOnlyPlacement({
    staged: staged(),
    idsRow: idsRow(),
    pay: payEntry(),
  });

  assert.equal(p.kind, 'pending', 'a person with a resolvable processor belongs in the payable queue');
  if (p.kind !== 'pending') return;
  assert.equal(p.row.processor, 'wise');
  assert.equal(p.row.id, 'vanessade@simple.biz');
  // The wizard's staged final is what the paystub promised — that's the amount to pay.
  assert.equal(p.row.amountPHP, 11427.31);
  assert.equal(p.row.amountUSD, 185.27);
  // Bank details must come from employee_ids — the whole point of the fix.
  assert.equal(p.row.details.bank_name, 'GoTyme');
  assert.equal(p.row.details.account_number, '012903983941');
  assert.equal(p.row.details.account_holder_name, 'VANESSA JOY DE LEON DELATADO');
  assert.equal(p.row.details.swift_code, 'GOTYPHM2XXX');
  // Never null again: ExcludedQueue's bankLabel() prints "No bank" for a null raw.
  assert.ok(p.row.bankPreferredRaw, 'bankPreferredRaw must be populated from employee_ids');
  // Hours come from the pay layer (which covers catalog-paid people).
  assert.equal(p.row.totalHours, 44.82);
  assert.equal(p.row.departmentKey, 'edit');
});

test('staged-only payee with NO resolvable processor stays excluded as no_bank', () => {
  const p = buildStagedOnlyPlacement({
    staged: staged({ recipient_email: 'marionnec@simple.biz', amount_php: 8644.67, amount_usd: 140.15 }),
    idsRow: idsRow({ preferred_processor: null, bank_preferred: null }),
    pay: undefined,
  });

  assert.equal(p.kind, 'excluded');
  if (p.kind !== 'excluded') return;
  assert.deepEqual(p.row.reasons, ['no_bank']);
  assert.equal(p.row.payable, null, 'no processor means nothing to route — not payable');
  // 'no_rate' must NOT be claimed: the rate came from the Payment Catalog, and
  // the staged amount proves one resolved. The actionable reason is the bank.
  assert.ok(!p.row.reasons.includes('no_rate'));
});

test('staged-only payee with no employee_ids row at all is excluded as no_bank', () => {
  const p = buildStagedOnlyPlacement({
    staged: staged(),
    idsRow: undefined,
    pay: payEntry(),
  });

  assert.equal(p.kind, 'excluded');
  if (p.kind !== 'excluded') return;
  assert.deepEqual(p.row.reasons, ['no_bank']);
  assert.equal(p.row.payable, null);
});

test('wizard-excluded staged-only payee is held in Excluded but STAYS payable from there', () => {
  const p = buildStagedOnlyPlacement({
    staged: staged({ excluded: true, sent_at: '2026-07-27T10:00:00Z' }),
    idsRow: idsRow(),
    pay: payEntry(),
  });

  assert.equal(p.kind, 'excluded');
  if (p.kind !== 'excluded') return;
  assert.ok(p.row.reasons.includes('do_not_pay'));
  assert.ok(!p.row.reasons.includes('no_bank'), 'she has a bank — do not also claim no_bank');
  assert.ok(p.row.payable, 'a held person with a bank must still be payable once cleared');
  assert.equal(p.row.payable?.processor, 'wise');
  assert.equal(p.row.payable?.details.bank_name, 'GoTyme');
  assert.equal(p.row.paystubSentAt, '2026-07-27T10:00:00Z');
});

test('employee_ids.bank_preferred outranks preferred_processor (parity with buildQueueFromRates)', () => {
  const p = buildStagedOnlyPlacement({
    staged: staged(),
    idsRow: idsRow({ bank_preferred: 'hurupay', preferred_processor: 'wise', hurupay_email: 'v@huru.com' }),
    pay: payEntry(),
  });

  assert.equal(p.kind, 'pending');
  if (p.kind !== 'pending') return;
  assert.equal(p.row.processor, 'hurupay', 'Bank Preferred is the send-from rail and wins');
  assert.equal(p.row.details.hurupay_email, 'v@huru.com');
});

test('staged-only payee with no amount anywhere is excluded as no_pay', () => {
  const p = buildStagedOnlyPlacement({
    staged: staged({ amount_php: null, amount_usd: null }),
    idsRow: idsRow(),
    pay: undefined,
  });

  assert.equal(p.kind, 'excluded');
  if (p.kind !== 'excluded') return;
  assert.ok(p.row.reasons.includes('no_pay'));
});

test('missing hours degrade to null rather than blocking payment', () => {
  const p = buildStagedOnlyPlacement({
    staged: staged(),
    idsRow: idsRow(),
    pay: undefined,
  });

  // The wizard already computed this person's pay for the cycle; absent Hubstaff
  // hours is a display gap, not grounds to strand their salary.
  assert.equal(p.kind, 'pending');
  if (p.kind !== 'pending') return;
  assert.equal(p.row.totalHours, null);
  assert.equal(p.row.amountPHP, 11427.31);
});

test('COP-paid staged-only payee keeps a native COP amount; PHP payees do not', () => {
  const cop = buildStagedOnlyPlacement({
    staged: staged(),
    idsRow: idsRow(),
    pay: payEntry({ payCurrency: 'COP', totalPayCOP: 720000 }),
  });
  assert.equal(cop.kind, 'pending');
  if (cop.kind !== 'pending') return;
  assert.equal(cop.row.payCurrency, 'COP');
  assert.equal(cop.row.amountCOP, 720000);

  const php = buildStagedOnlyPlacement({ staged: staged(), idsRow: idsRow(), pay: payEntry() });
  assert.equal(php.kind, 'pending');
  if (php.kind !== 'pending') return;
  assert.equal(php.row.amountCOP, null);
});

test('COP-COUNTRY staged-only payee (Colombian on the PHP rails) keeps the marker + native COP amount', () => {
  const co = buildStagedOnlyPlacement({
    staged: staged(),
    idsRow: idsRow(),
    // PHP-denominated pay (normal processor tabs), Colombian receiving bank.
    pay: payEntry({ countryCurrency: 'COP', totalPayCOP: 592300 }),
  });
  assert.equal(co.kind, 'pending');
  if (co.kind !== 'pending') return;
  assert.equal(co.row.payCurrency, 'PHP', 'stays on the PHP rails — not moved to the COP tab');
  assert.equal(co.row.countryCurrency, 'COP', 'marker rides the row for the COP secondary-line swap');
  assert.equal(co.row.amountCOP, 592300, 'native COP figure available to copy in the dialog');
});

// ── Regression guards on the untouched rates-driven path ────────────────────
// The enrichment above is shared with buildQueueFromRates; these pin its
// existing behaviour so the extraction can't silently change live payroll.

function ratesRow(over: Partial<EmployeeHourlyRateRow> = {}): EmployeeHourlyRateRow {
  return {
    work_email: 'someone@simple.biz',
    personal_email: null,
    regular_rate: '225',
    ot_rate: '337.5',
    department: 'Edit Team',
    bank_preferred: null,
    hurupay_email: null,
    higlobe_email: null,
    higlobe_account_name: null,
    phone_number: null,
    full_address: null,
    city: null,
    province_state: null,
    mesa_member: null,
    mesa_member_since: null,
    mesa_fpu_completed_on: null,
    mesa_account_number: null,
    ...over,
  };
}

test('buildQueueFromRates: employee_ids values still win over rates-side ones', () => {
  const { active } = buildQueueFromRates(
    [
      ratesRow({
        bank_preferred: 'x1161',
        hurupay_email: 'stale@rates.com',
        higlobe_email: 'stale-hg@rates.com',
        higlobe_account_name: 'Stale HG',
        phone_number: '0900',
        full_address: 'Rates Address',
        city: 'Rates City',
        province_state: 'Rates Province',
      }),
    ],
    { 'someone@simple.biz': payEntry({ departmentKey: 'edit', departmentName: 'Edit Team' }) },
    new Map([
      [
        'someone@simple.biz',
        idsRow({
          work_email: 'someone@simple.biz',
          personal_email: null,
          bank_preferred: null,
          preferred_processor: 'higlobe',
          higlobe_email: 'fresh@higlobe.com',
          higlobe_account_name: 'Fresh HG',
        }),
      ],
    ]),
  );

  assert.equal(active.length, 1);
  assert.equal(active[0]!.processor, 'higlobe', 'chosen processor beats the legacy x1161 cell');
  assert.equal(active[0]!.details.higlobe_email, 'fresh@higlobe.com');
  assert.equal(active[0]!.details.higlobe_account_name, 'Fresh HG');
  // Rates-only fields still fill in where employee_ids has nothing.
  assert.equal(active[0]!.details.city, 'Rates City');
  assert.equal(active[0]!.details.province_state, 'Rates Province');
  assert.equal(active[0]!.bankPreferredRaw, 'x1161');
});

test('buildQueueFromRates: legacy rates cell still routes someone who picked nothing', () => {
  const { active } = buildQueueFromRates(
    [ratesRow({ work_email: 'legacy@simple.biz', bank_preferred: 'Higloble' })],
    { 'legacy@simple.biz': payEntry() },
    new Map(),
  );

  assert.equal(active.length, 1);
  assert.equal(active[0]!.processor, 'higlobe', 'the typo-tolerant legacy mapper is still consulted');
});

test('buildQueueFromRates: alternative bank slot still wins for display', () => {
  const { active } = buildQueueFromRates(
    [ratesRow({ work_email: 'alt@simple.biz', bank_preferred: 'wires' })],
    { 'alt@simple.biz': payEntry() },
    new Map([
      [
        'alt@simple.biz',
        idsRow({
          work_email: 'alt@simple.biz',
          personal_email: null,
          preferred_bank_slot: 'alternative',
          bank_name: 'Primary Bank',
          account_number: '1111',
          alt_bank_name: 'Alt Bank',
          alt_account_number: '2222',
          alt_account_holder_name: 'Alt Holder',
          alt_routing_number: 'ALTSWIFT',
        }),
      ],
    ]),
  );

  assert.equal(active.length, 1);
  assert.equal(active[0]!.details.bank_name, 'Alt Bank');
  assert.equal(active[0]!.details.account_number, '2222');
  assert.equal(active[0]!.details.swift_code, 'ALTSWIFT');
});
