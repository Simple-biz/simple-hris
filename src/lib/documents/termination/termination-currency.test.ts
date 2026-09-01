/** [TERMINATION-DOCS]
 * Risk 4 — the native currency, RESOLVED at the carrier and carried all the way
 * onto the rendered page.
 *
 * Round-2 audit finding C6: every carrier and the blank constructor in
 * `termination-rates.ts` hardcoded `currency: 'PHP'`, so `TerminationRate.currency`
 * could never be USD or COP, the route's currency plumbing could only ever echo
 * PHP, and a USD payee's hourly rate printed as pesos on a signed legal document.
 * The resolver-side tests below are therefore paired with `rateLabel` — the exact
 * function the renderer draws the leader row with (termination-document.ts:546)
 * — and with a real one-page render, so "carried end to end" is asserted rather
 * than asserted about.
 *
 * The carriers come from the recording double in `./test-support/`; no database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { installTerminationServerStubs } from './test-support/stub-server-modules';
import { setTestSupabaseClient } from './test-support/supabase-server-stub';
import { createFakeSupabase, type FakeSupabase, type FakeTableFixture } from './test-support/fake-supabase';
import { ilikeTableFixture } from './test-support/ilike-fixture';
import { resolveRosterDeptKey } from '@/lib/payment-catalog/person-comp';
import type { TerminationFacts, TerminationRate } from './types';
import type { TerminationRateContext } from './termination-arbitration';

installTerminationServerStubs();

/**
 * EVERY value import below is lazy, and that is load-bearing rather than tidy.
 *
 * A static `import … from './termination-document'` is evaluated BEFORE this
 * module's body runs, so it would load `coe-facts` — and with it
 * `@/lib/supabase/pay-structures-db` — while the resolution hook is not yet
 * installed. That module would then be cached holding the REAL
 * `createSupabaseServiceRoleClient`, and the currency read this file exists to
 * test would run against it instead of the double: every fixture below would
 * silently become "the catalog read failed". Same chain through
 * `./termination-route-rules` → `./termination-arbitration` → `coe-facts`.
 * Type-only imports are erased, so those stay at the top.
 */
type RatesModule = typeof import('./termination-rates');
type DocumentModule = typeof import('./termination-document');
type RouteRulesModule = typeof import('./termination-route-rules');

let loaded: RatesModule | null = null;
async function ratesModule(): Promise<RatesModule> {
  if (!loaded) loaded = await import('./termination-rates');
  return loaded;
}

let loadedDoc: DocumentModule | null = null;
async function documentModule(): Promise<DocumentModule> {
  if (!loadedDoc) loadedDoc = await import('./termination-document');
  return loadedDoc;
}

let loadedRules: RouteRulesModule | null = null;
async function routeRulesModule(): Promise<RouteRulesModule> {
  if (!loadedRules) loadedRules = await import('./termination-route-rules');
  return loadedRules;
}

/** `rateLabel` — the exact function the renderer draws the leader row with. */
async function rateLabel(rate: TerminationRate | null): Promise<string | null> {
  const { __terminationInternals } = await documentModule();
  return __terminationInternals.rateLabel(rate);
}

const LEAVER = 'juand@simple.biz';
const DEPARTMENT = 'Sales Assistant';
/** Computed, never guessed: the catalog keys department structures by the SAME
 *  resolver the roster uses, so the fixture cannot drift from the mapping. */
const DEPARTMENT_KEY = resolveRosterDeptKey(DEPARTMENT, []) ?? 'sales-assistant';

function context(over: Partial<TerminationRateContext> = {}): TerminationRateContext {
  return {
    workEmail: LEAVER,
    workAliases: [LEAVER],
    departmentRaw: DEPARTMENT,
    offDate: '2026-08-18',
    ...over,
  };
}

/** One `payment_catalog_pay_structures` row, in the shape `mapRow` reads
 *  (pay-structures-db.ts:18-30). */
function structure(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    scope: 'employee',
    department_key: DEPARTMENT_KEY,
    employee_email: LEAVER,
    employee_name: 'Juan Dela Cruz',
    regular_rate: 8,
    ot_rate: null,
    currency: 'PHP',
    created_by: 'kaner@simple.biz',
    created_at: '2025-01-02T00:00:00.000Z',
    updated_by: null,
    updated_at: null,
    ...over,
  };
}

function hireRecord(rate: string): FakeTableFixture {
  return ilikeTableFixture([
    { work_email: LEAVER, regular_rate: rate, created_at: '2024-03-04T00:00:00.000Z' },
  ]);
}

function dispatchRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    recipient_email: LEAVER,
    status: 'paid',
    payee_type: 'employee',
    cycle_source_file: 'cycle-2026-08-14.csv',
    sent_date: '2026-08-14',
    created_at: '2026-08-14T02:00:00.000Z',
    ...over,
  };
}

function tables(over: Record<string, FakeTableFixture> = {}) {
  return {
    hr_pending_employees: ilikeTableFixture([]),
    employee_rate_history: [] as Record<string, unknown>[],
    payment_dispatches: [] as Record<string, unknown>[],
    disbursement_records: [] as Record<string, unknown>[],
    paystub_dispatch_queue: [] as Record<string, unknown>[],
    app_settings: [] as Record<string, unknown>[],
    payment_catalog_pay_structures: [] as Record<string, unknown>[],
    ...over,
  };
}

function harness(spec: Record<string, FakeTableFixture>): FakeSupabase {
  const fake = createFakeSupabase({ tables: spec });
  setTestSupabaseClient(fake.client);
  return fake;
}

// ── The rendered page ────────────────────────────────────────────────────────

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const BASE_FACTS: TerminationFacts = {
  identity: {
    workEmail: LEAVER,
    personalEmail: 'juan.delacruz@gmail.com',
    masterRowId: '9b1d4c7e-2f30-4a51-8c62-7d4e5f6a8b90',
    onCurrentUpload: true,
    candidateRowIds: ['9b1d4c7e-2f30-4a51-8c62-7d4e5f6a8b90'],
    matchedColumn: 'Work Email',
    offDateSource: 'global_master_list',
  },
  workerName: 'Juan Dela Cruz',
  terminationDate: '2026-08-18',
  terminationDateLabel: 'August 18, 2026',
  reasonKey: 'end_of_contract',
  reasonLabel: 'End of contract',
  rawReason: 'End of Contract',
  endingDepartmentRaw: DEPARTMENT,
  endingDepartmentLabel: DEPARTMENT,
  startDate: '2024-03-04',
  startDateLabel: 'March 4, 2024',
  startingRate: { amount: null, currency: null, source: null, blankReason: null },
  endingRate: { amount: null, currency: null, source: null, blankReason: null },
  blanks: [],
  degraded: [],
};

/** Render the letter the resolver's own rates produced, and hand back the page
 *  count — the only end-to-end proof available, since the PDF's text is drawn in
 *  a subset font that cannot be read back out. `rateLabel` below is the exact
 *  string the renderer draws, so the two together cover the figure and the page. */
async function renderWith(starting: TerminationRate, ending: TerminationRate): Promise<number> {
  const { renderTerminationDocument } = await documentModule();
  const bytes = await renderTerminationDocument({
    facts: { ...BASE_FACTS, startingRate: starting, endingRate: ending },
    documentId: '3c6f9a11-88de-4d0b-b0a2-5e7c1d9f4a33',
    generatedAtIso: '2026-08-31T02:15:00.000Z',
    signature: {
      dataUrl: PNG_1PX,
      name: 'Alissa Re',
      title: 'Payroll Coordinator',
      email: 'payroll@simple.biz',
      signedAtIso: '2026-08-31T02:15:00.000Z',
    },
  });
  return (await PDFDocument.load(bytes)).getPageCount();
}

// ── USD ──────────────────────────────────────────────────────────────────────

test('a USD payee: the catalog denominates the hire rate, and the page prints $8.00', async () => {
  harness(
    tables({
      payment_catalog_pay_structures: [structure({ currency: 'USD' })],
      hr_pending_employees: hireRecord('8.00'),
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.starting.amount, 8);
  assert.equal(res.starting.currency, 'USD', 'the hire rate was re-denominated as pesos');
  assert.equal(res.starting.source, 'hr_pending');
  assert.equal(res.starting.blankReason, null);

  // The renderer's own function, on the resolver's own object.
  assert.equal(await rateLabel(res.starting), '$8.00');
  assert.equal(await renderWith(res.starting, res.ending), 1);
});

// ── COP ──────────────────────────────────────────────────────────────────────

test('a COP payee: the hire rate prints "$COP 320.000", never a peso figure', async () => {
  harness(
    tables({
      payment_catalog_pay_structures: [structure({ currency: 'COP', regular_rate: 320000 })],
      hr_pending_employees: hireRecord('320,000'),
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.starting.amount, 320000, 'parseRateText must survive the grouping comma');
  assert.equal(res.starting.currency, 'COP');
  assert.equal(await rateLabel(res.starting), '$COP 320.000');
  assert.equal(await renderWith(res.starting, res.ending), 1);
});

test('a COP payee: the PHP-equivalent payroll week is a BLANK in COP, not ₱18,000.00', async () => {
  // `disbursement_records.regular_rate_php` is pesos by construction, so for a
  // payee priced in COP it is an FX conversion of one week — not the rate they
  // were engaged at. Printing it would state a ~57x-wrong number on a signed
  // letter and store 'PHP' beside it.
  harness(
    tables({
      payment_catalog_pay_structures: [structure({ currency: 'COP', regular_rate: 320000 })],
      payment_dispatches: [dispatchRow()],
      disbursement_records: [
        { recipient_email: LEAVER, source_file: 'cycle-2026-08-14.csv', regular_rate_php: 18000 },
      ],
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.ending.amount, null, 'a peso-rail week was printed as the ending rate');
  assert.equal(res.ending.blankReason, 'non_php_payee');
  assert.equal(res.ending.currency, 'COP', 'the blank must still carry the currency to ask in');
  assert.equal(res.ending.source, 'disbursement_record', 'the carrier that held it is recorded');
  assert.equal(await rateLabel(res.ending), null);
});

// ── A DEPARTMENT currency is not a person's currency ─────────────────────────

test('a department priced in USD blanks the figure rather than restating it in USD', async () => {
  // A leaver has no rates-sheet row left to prove they were on the PHP middle
  // layer, so a department default cannot denominate their stored number. It is
  // enough to say "not provably pesos", and no more than that.
  harness(
    tables({
      payment_catalog_pay_structures: [
        structure({ scope: 'department', employee_email: null, currency: 'USD' }),
      ],
      hr_pending_employees: hireRecord('175.00'),
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.starting.amount, null, '175 was restated as $175.00 off a department default');
  assert.equal(res.starting.blankReason, 'non_php_payee');
  assert.equal(res.starting.currency, 'USD');
});

test('a department priced in PHP agrees with the sheet layer, so the figure stands', async () => {
  // The positive control for the test above: without it, "a department base
  // blanks the rate" could be satisfied by blanking every department.
  harness(
    tables({
      payment_catalog_pay_structures: [
        structure({ scope: 'department', employee_email: null, currency: 'PHP' }),
      ],
      hr_pending_employees: hireRecord('175.00'),
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.starting.amount, 175);
  assert.equal(res.starting.currency, 'PHP');
  assert.equal(await rateLabel(res.starting), '₱175.00');
});

test('an EMPLOYEE structure outranks the department base, both ways round', async () => {
  harness(
    tables({
      payment_catalog_pay_structures: [
        structure({
          id: '22222222-2222-4222-8222-222222222222',
          scope: 'department',
          employee_email: null,
          currency: 'PHP',
        }),
        structure({ currency: 'USD' }),
      ],
      hr_pending_employees: hireRecord('8.00'),
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.starting.currency, 'USD', 'the department base outranked the person');
  assert.equal(res.starting.amount, 8);
});

// ── Nothing at all in the catalog: the PHP rails, as EVIDENCE ────────────────

test('no structure anywhere resolves PHP — the rates sheet is the only other layer', async () => {
  const fake = harness(tables({ hr_pending_employees: hireRecord('225.00') }));
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.starting.amount, 225);
  assert.equal(res.starting.currency, 'PHP');
  // And the catalog was genuinely consulted — a PHP answer that came from
  // skipping the read is the bug this whole file exists to close.
  assert.equal(fake.opsFor('payment_catalog_pay_structures').length, 1);
});

// ── A FAILED catalog read states nothing, and the route then demands one ─────

test('a failed catalog read leaves the rate BLANK with no currency, never a silent PHP', async () => {
  const failing: FakeTableFixture = () => ({
    data: null,
    error: { message: 'canceling statement due to statement timeout' },
  });
  harness(
    tables({
      payment_catalog_pay_structures: failing,
      hr_pending_employees: hireRecord('225.00'),
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.starting.amount, null, 'an undenominated figure was printed anyway');
  assert.equal(res.starting.currency, null);
  assert.equal(res.starting.blankReason, 'currency_unresolved');
  assert.match(res.degraded.join(' | '), /payment_catalog_pay_structures/);
  // Nothing prints, at the renderer too — four gates, and this is the last.
  assert.equal(await rateLabel({ ...res.starting, amount: 225 }), null);
});

test('the route REQUIRES a currency when the record states none, and accepts the rep’s', async () => {
  // The blank above reaches the panel, which renders a currency picker; the
  // route is what makes that mandatory rather than decorative.
  const { resolveFilledRateCurrency } = await routeRulesModule();
  const missing = resolveFilledRateCurrency({
    label: 'Starting rate',
    supplied: undefined,
    resolved: null,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.rejection.status, 400);
    assert.match(missing.rejection.message, /needs a currency/);
  }

  const chosen = resolveFilledRateCurrency({
    label: 'Starting rate',
    supplied: 'USD',
    resolved: null,
  });
  assert.equal(chosen.ok, true);
  if (chosen.ok) assert.equal(chosen.value, 'USD');

  // Still validated against the union — "no resolved currency" is not a licence
  // to store whatever the body carried.
  const bogus = resolveFilledRateCurrency({
    label: 'Starting rate',
    supplied: 'EUR',
    resolved: null,
  });
  assert.equal(bogus.ok, false);
});

// ── The defect itself, pinned in source ─────────────────────────────────────

test('no rate carrier hardcodes a currency, and the type admits "none"', () => {
  // The audit's C6 verbatim: "every rate carrier and the blank constructor in
  // termination-rates.ts hardcode `currency: 'PHP'`, so TerminationRate.currency
  // can never be USD or COP". Both halves are pinned — a re-introduced literal
  // fails here, and so does a currency field narrowed back to non-nullable,
  // which would force some construction site to invent one.
  const dir = path.resolve(process.cwd(), 'src/lib/documents/termination');
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const rates = strip(fs.readFileSync(path.join(dir, 'termination-rates.ts'), 'utf8'));
  const literals = rates.match(/currency:\s*'(PHP|USD|COP)'/g) ?? [];
  assert.deepEqual(
    literals,
    ["currency: 'PHP'"],
    'a rate carrier names a currency of its own again — every carrier must read the resolution',
  );
  // …and that ONE literal is the payroll-rails resolution, reached only after a
  // SUCCESSFUL catalog read found no structure. It is evidence, not a default.
  assert.match(rates, /return \{ currency: 'PHP', confirmed: true, source: 'payroll_rails' \};/);
  assert.match(rates, /resolvePayeeCurrency\(/);
  assert.match(rates, /listPayStructures\(\)/, 'the currency is no longer read from the catalog');

  const types = strip(fs.readFileSync(path.join(dir, 'types.ts'), 'utf8'));
  assert.match(types, /currency:\s*TerminationCurrency \| null;/);

  // And the last gate on the page: an amount with no currency never prints.
  const doc = strip(fs.readFileSync(path.join(dir, 'termination-document.ts'), 'utf8'));
  assert.match(doc, /if \(!rate\.currency\) return null;/);

  // The DDL says the same thing one layer down.
  const ddl = fs.readFileSync(
    path.resolve(process.cwd(), 'references/sql/migrate/2026-08-31_termination_docs.sql'),
    'utf8',
  );
  assert.match(ddl, /termination_documents_currency_present_with_rate/);
  assert.match(ddl, /starting_rate is null or starting_rate_currency is not null/);
});

// ── G1 stays true through the new read ──────────────────────────────────────

test('G1: the catalog read carries no email filter, so no personal inbox can price a letter', async () => {
  // `PayStructure.employeeEmail` is documented as "work/personal", and one
  // personal inbox backs two identities. The structures are matched IN MEMORY
  // against the WORK alias set, so nothing personal can reach a query or a
  // printed figure.
  const fake = harness(
    tables({
      payment_catalog_pay_structures: [structure({ currency: 'USD' })],
      hr_pending_employees: hireRecord('8.00'),
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  await resolveTerminationRates(context({ workAliases: [LEAVER, 'juan.delacruz@gmail.com'] }));

  const catalogOps = fake.opsFor('payment_catalog_pay_structures');
  assert.ok(catalogOps.length > 0, 'the catalog was never read');
  for (const op of catalogOps) {
    assert.equal(
      op.chain.some((c) => c.includes('@')),
      false,
      `the catalog read carried an email address: ${op.chain.join('.')}`,
    );
  }
});
