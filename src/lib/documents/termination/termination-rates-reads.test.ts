/** [TERMINATION-DOCS]
 * `resolveTerminationRates` — the two money facts on the signed page.
 *
 * This is the module the round-1 audit found breaching G1: it queried
 * `hr_pending_employees.personal_email` over every alias, so ONE shared gmail
 * could hand `carlath@simple.biz`'s letter the ACTIVE `carla@simple.biz`'s hire
 * rate, printed as the STARTING RATE and stored on the log row. Nothing tested
 * the alias path at all. So the tests here are about the QUERIES: which column,
 * which value, and what happens to the printed figure when a read fails.
 *
 * Every carrier is answered by the recording double in `./test-support/`. No
 * database; the client factory itself is replaced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTerminationServerStubs } from './test-support/stub-server-modules';
import { setTestSupabaseClient } from './test-support/supabase-server-stub';
import {
  chainArgs,
  createFakeSupabase,
  type FakeSupabase,
  type FakeTableFixture,
} from './test-support/fake-supabase';
import { ilikeTableFixture } from './test-support/ilike-fixture';
import type { TerminationRateContext } from './termination-arbitration';

installTerminationServerStubs();

type RatesModule = typeof import('./termination-rates');
let loaded: RatesModule | null = null;
/** Imported lazily so the resolution hook above is installed first. */
async function ratesModule(): Promise<RatesModule> {
  if (!loaded) loaded = await import('./termination-rates');
  return loaded;
}

const SHARED_GMAIL = 'carlathomas0112@gmail.com';
const LEAVER = 'carlath@simple.biz';
const ACTIVE = 'carla@simple.biz';

/** The context the arbitration hands over. Typed against the arbitration's own
 *  interface, so a rename there is a compile error here rather than a test that
 *  quietly stops exercising the real shape. */
function context(over: Partial<TerminationRateContext> = {}): TerminationRateContext {
  return {
    workEmail: LEAVER,
    workAliases: [LEAVER],
    departmentRaw: 'Support',
    offDate: '2026-06-03',
    ...over,
  };
}

function dispatchRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    recipient_email: LEAVER,
    status: 'paid',
    payee_type: 'employee',
    cycle_source_file: 'cycle-2026-05-30.csv',
    sent_date: '2026-05-30',
    created_at: '2026-05-30T02:00:00.000Z',
    ...over,
  };
}

/** Every table the two resolvers can touch, present and empty. A table left out
 *  is answered with an ERROR by the double and recorded in `unregistered`, so a
 *  NEW carrier query cannot slip in unnoticed. */
function tables(over: Record<string, FakeTableFixture> = {}) {
  return {
    hr_pending_employees: ilikeTableFixture([]),
    employee_rate_history: [] as Record<string, unknown>[],
    payment_dispatches: [] as Record<string, unknown>[],
    disbursement_records: [] as Record<string, unknown>[],
    paystub_dispatch_queue: [] as Record<string, unknown>[],
    app_settings: [] as Record<string, unknown>[],
    // The currency carrier. EMPTY is not "no answer": a catalog read that
    // succeeds and finds no structure is the evidence that this person is priced
    // by the rates sheet, which is PHP by construction — which is why the rates
    // below still resolve in PHP. A MISSING fixture would be a read ERROR, and
    // then nothing can denominate a figure at all.
    payment_catalog_pay_structures: [] as Record<string, unknown>[],
    ...over,
  };
}

function harness(spec: Record<string, FakeTableFixture>): FakeSupabase {
  const fake = createFakeSupabase({ tables: spec });
  setTestSupabaseClient(fake.client);
  return fake;
}

// ── G1: a printed money fact is never derived from a personal address ────────

test('G1: no rate query names a personal-email column, or carries a personal address', async () => {
  const fake = harness(tables());
  const { resolveTerminationRates } = await ratesModule();

  // The personal address is handed in as an alias ON PURPOSE: the resolver must
  // not turn it into a query even when something upstream puts it in reach.
  await resolveTerminationRates(context({ workAliases: [LEAVER, SHARED_GMAIL] }));

  const named = fake.ops.flatMap((op) => [op.columns ?? '', ...op.chain]);
  assert.deepEqual(
    named.filter((entry) => /personal_email/i.test(entry)),
    [],
    'a rate query named a personal-email column — one shared inbox backs two identities',
  );

  // The other half: every email-valued filter names a WORK column. A personal
  // address handed in as an alias can then only ever be looked up in a work
  // column, where it finds nothing — a BLANK, not somebody else's money.
  const WORK_COLUMNS = new Set(['work_email', 'employee_email', 'recipient_email', 'source_file']);
  const emailFilters = fake.ops.flatMap((op) =>
    op.chain
      .filter((c) => /^(ilike|eq|in)\(/.test(c) && c.includes('@'))
      .map((c) => ({ table: op.table, filter: c, column: c.slice(c.indexOf('(') + 1).split(',')[0] })),
  );
  assert.ok(emailFilters.length > 0, 'no email-keyed rate query ran at all');
  for (const f of emailFilters) {
    assert.ok(
      WORK_COLUMNS.has(f.column),
      `${f.table} filtered ${f.column} on an email address: ${f.filter}`,
    );
  }
});

test('G1: a hire record that exists only under a shared inbox does NOT price the letter', async () => {
  // The audit's exact failure: `carlath@` is a pre-pipeline hire with no staged
  // row of their own, while the ACTIVE `carla@`'s staged row carries the shared
  // gmail. Matching on that inbox printed carla@'s hire rate as carlath@'s
  // starting rate. A BLANK the rep fills is the honest answer.
  const hire = ilikeTableFixture([
    {
      work_email: ACTIVE,
      personal_email: SHARED_GMAIL,
      regular_rate: '175.00',
      created_at: '2025-01-02T00:00:00.000Z',
    },
  ]);
  harness(tables({ hr_pending_employees: hire }));
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context({ workAliases: [LEAVER, SHARED_GMAIL] }));

  assert.equal(res.starting.amount, null, "the other identity's hire rate was printed");
  assert.equal(res.starting.blankReason, 'no_hire_record');
  assert.equal(res.starting.source, null);
});

test('the hire record for THIS work email does price the letter', async () => {
  // The positive control for the test above: without it, "never priced from a
  // shared inbox" could be satisfied by never pricing anything.
  const hire = ilikeTableFixture([
    {
      work_email: LEAVER,
      regular_rate: '1,234.50',
      created_at: '2024-01-08T00:00:00.000Z',
    },
  ]);
  const fake = harness(tables({ hr_pending_employees: hire }));
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  // parseRateText, not Number(): the column is TEXT and holds thousands
  // separators, which Number() reads as NaN.
  assert.equal(res.starting.amount, 1234.5);
  assert.equal(res.starting.source, 'hr_pending');
  assert.equal(res.starting.currency, 'PHP');
  assert.deepEqual(chainArgs(fake.opsFor('hr_pending_employees')[0], 'ilike'), [
    'work_email',
    LEAVER,
  ]);
});

test('G6: a carrier holding ZERO is a BLANK, never a printed 0.00', async () => {
  // "A zero rate is not a rate" — every carrier is a TEXT column or a JSON blob,
  // so a missing figure arrives as `0` as readily as null. A hit STOPS the chain
  // (an older unrelated rate must not stand in for it) and reports why.
  const hire = ilikeTableFixture([
    { work_email: LEAVER, regular_rate: '0', created_at: '2024-01-08T00:00:00.000Z' },
  ]);
  harness(tables({ hr_pending_employees: hire }));
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.starting.amount, null);
  assert.equal(res.starting.blankReason, 'zero_rate');
  assert.equal(res.starting.source, 'hr_pending', 'the carrier that held the zero is recorded');
});

// ── A failed read is a BLANK, never a figure ────────────────────────────────

test('a rate-carrier read that FAILS produces a BLANK marked read_degraded', async () => {
  // The alternative — falling through to an older carrier because this one
  // errored — prints a figure from the wrong week on a signed page and says
  // nothing about it.
  const failing: FakeTableFixture = () => ({
    data: null,
    error: { message: 'canceling statement due to statement timeout' },
  });
  harness(
    tables({
      hr_pending_employees: failing,
      employee_rate_history: failing,
      payment_dispatches: failing,
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.starting.amount, null);
  assert.equal(res.starting.blankReason, 'read_degraded');
  assert.equal(res.ending.amount, null);
  assert.equal(res.ending.blankReason, 'read_degraded');
  assert.match(res.degraded.join(' | '), /payment_dispatches/);
});

test('never paid is "never_paid", not a rate borrowed from somewhere else', async () => {
  harness(tables());
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.ending.amount, null);
  assert.equal(res.ending.blankReason, 'never_paid');
});

// ── The ending rate: the last week money actually moved ─────────────────────

test('the ending rate is keyed on the WORK email, excludes contractor settlements, and picks the latest CALENDAR day', async () => {
  const fake = harness(
    tables({
      payment_dispatches: [
        // The genuine latest paid week.
        dispatchRow({}),
        // An OLDER week carrying a sheet-shaped date. As a raw string
        // '9/3/2025' sorts ABOVE '2026-05-30' ('9' > '2'), so a lexicographic
        // comparison picks this one and prints a rate from nine months earlier.
        dispatchRow({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          cycle_source_file: 'cycle-2025-09-05.csv',
          sent_date: '9/3/2025',
        }),
        // A contractor invoice settlement carries the LIVE cycle's source file,
        // so it would speak for a salary week that was never paid.
        dispatchRow({
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          payee_type: 'contractor',
          cycle_source_file: 'cycle-2026-10-10.csv',
          sent_date: '2026-10-10',
        }),
        // Unpaid rows are not evidence that money moved.
        dispatchRow({
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          status: 'pending',
          cycle_source_file: 'cycle-2026-11-11.csv',
          sent_date: '2026-11-11',
        }),
      ],
      disbursement_records: (op) => {
        const file = chainArgs(op, 'eq')?.[1];
        if (file === 'cycle-2025-09-05.csv') {
          return [{ recipient_email: LEAVER, source_file: file, regular_rate_php: 262.5 }];
        }
        if (file === 'cycle-2026-05-30.csv') {
          return [{ recipient_email: LEAVER, source_file: file, regular_rate_php: 225 }];
        }
        return [];
      },
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(res.ending.amount, 225, 'the wrong week supplied the ending rate');
  assert.equal(res.ending.source, 'disbursement_record');

  // The ledger is read on the work email, exactly — never a pattern, never an
  // `.or()`, never a personal address.
  const ledger = fake.opsFor('payment_dispatches')[0];
  assert.ok(ledger.chain.includes(`eq(recipient_email,${LEAVER})`), ledger.chain.join('.'));
  // And the disbursement fallback is scoped to (source_file, recipient_email) —
  // a whole-cycle load is 1,000+ rows and throws on error.
  const disb = fake.opsFor('disbursement_records')[0];
  assert.ok(disb.chain.includes(`eq(recipient_email,${LEAVER})`), disb.chain.join('.'));
});

test('the 4,000-row dispatch ledger PAGES — the newest row past 1000 still wins', async () => {
  // `payment_dispatches` passed 3,700 rows in Jul 2026 and PostgREST truncates
  // at 1000 even with `.range()`. A truncated read here prints the rate from
  // whichever week happened to survive the cut.
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 1001; i += 1) {
    rows.push(
      dispatchRow({
        id: `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`,
        // The LAST row is the most recent week, so it can only be found on page 2.
        cycle_source_file: i === 1000 ? 'cycle-2026-09-05.csv' : 'cycle-2026-05-30.csv',
        sent_date: i === 1000 ? '2026-09-05' : '2026-05-30',
      }),
    );
  }
  const fake = harness(
    tables({
      payment_dispatches: rows,
      disbursement_records: (op) => {
        const file = chainArgs(op, 'eq')?.[1];
        return file === 'cycle-2026-09-05.csv'
          ? [{ recipient_email: LEAVER, source_file: file, regular_rate_php: 262.5 }]
          : [{ recipient_email: LEAVER, source_file: file, regular_rate_php: 225 }];
      },
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  const res = await resolveTerminationRates(context());

  assert.equal(
    fake.opsFor('payment_dispatches').length,
    2,
    'the ledger read stopped after one 1000-row page',
  );
  assert.equal(res.ending.amount, 262.5, 'the newest paid week was past the 1000-row cap');
});

// ── The history read ────────────────────────────────────────────────────────

test('the rate history is read with an exact .in() list of WORK addresses, never .or()', async () => {
  const fake = harness(tables());
  const { resolveTerminationRates } = await ratesModule();

  await resolveTerminationRates(
    context({ workAliases: [LEAVER, 'carla.thomas@simple.biz'] }),
  );

  const history = fake.opsFor('employee_rate_history')[0];
  assert.ok(history, 'the rate history was never read');
  const inArgs = chainArgs(history, 'in') ?? [];
  assert.equal(inArgs[0], 'employee_email');
  // `.in()` is an exact-match LIST, not a pattern: no wildcard hazard, and no
  // `.or()` string for PostgREST to mis-split on the dots in an address.
  assert.deepEqual(JSON.parse(inArgs.slice(1).join(',')), [LEAVER, 'carla.thomas@simple.biz']);
  assert.deepEqual(
    fake.allChainEntries().filter((c) => c.startsWith('or(')),
    [],
  );
});

test('no rate carrier is read that this test did not declare', async () => {
  // The double answers an undeclared table with an ERROR and records it. A new
  // carrier appearing here means a money fact now comes from somewhere no test
  // has ever looked at.
  const fake = harness(
    tables({
      payment_dispatches: [dispatchRow({})],
      disbursement_records: [
        { recipient_email: LEAVER, source_file: 'cycle-2026-05-30.csv', regular_rate_php: 225 },
      ],
    }),
  );
  const { resolveTerminationRates } = await ratesModule();

  await resolveTerminationRates(context());

  assert.deepEqual([...new Set(fake.unregistered)], []);
});
