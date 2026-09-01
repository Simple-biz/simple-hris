/** [TERMINATION-DOCS]
 * `resolveTerminationFacts` — the READS, not the arithmetic.
 *
 * `termination-facts.test.ts` covers the pure `./termination-arbitration` with
 * injected rows. That proves the refusal ladder is right and says NOTHING about
 * the five parallel queries that feed it: which column was filtered, whether the
 * pattern was LIKE-escaped, whether a read ERROR was treated as "nobody left",
 * whether `gmlActive`'s polarity survives an email the status map never
 * mentions, whether the rate reads are skipped when a refusal already fired.
 * Round-1 audit, MAJOR: "A pure core that is correct proves nothing about the
 * query that feeds it."
 *
 * So this file runs the REAL server module — and the real `fetchGmlStatusMap`
 * and `loadOffboardEvidenceByEmail` with it — against a recording Supabase
 * double, and asserts on the operations themselves. `./test-support/` explains
 * how a `server-only` module becomes loadable without the module losing its
 * `import 'server-only'` line (it still has it; `termination-guard-map.test.ts`
 * asserts that for all six). Nothing here touches a database: the client factory
 * is replaced outright, so the PRODUCTION service-role credentials in
 * `.env.local` cannot be reached even by accident.
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
import { ilikeTableFixture, masterListFixture } from './test-support/ilike-fixture';
import { setTestCycleHours, testCycleHoursCalls } from './test-support/cycle-hours-control';

installTerminationServerStubs();

type FactsModule = typeof import('./termination-facts');
let loaded: FactsModule | null = null;
/** Imported lazily so the resolution hook above is installed first. */
async function factsModule(): Promise<FactsModule> {
  if (!loaded) loaded = await import('./termination-facts');
  return loaded;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The documented cross-wire: ONE gmail behind two master identities —
 *  `carla@simple.biz` (ACTIVE) and `carlath@simple.biz` (resigned 2026-06-03),
 *  offboard-evidence.ts:41-48. */
const SHARED_GMAIL = 'carlathomas0112@gmail.com';
const LEAVER = 'carlath@simple.biz';
const ACTIVE = 'carla@simple.biz';
const CURRENT_UPLOAD = '412';

function masterRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    Name: 'Carla Thomas',
    'Work Email': LEAVER,
    'Personal Email': SHARED_GMAIL,
    'Alternate Work Email': null,
    'Alternate Work Email 2': null,
    Department: 'Support',
    'Start Date': '2024-01-08',
    off_boarded_at: null,
    off_boarded_reason: null,
    last_seen_upload_id: CURRENT_UPLOAD,
    ...over,
  };
}

/** Every table the whole assembly reads, so an unregistered table (which the
 *  double answers with an ERROR and records) can only mean a NEW query nobody
 *  declared — which is exactly what these tests want to hear about. */
function tables(master: FakeTableFixture, over: Record<string, FakeTableFixture> = {}) {
  return {
    global_master_list: master,
    master_list_uploads: [{ id: CURRENT_UPLOAD }] as Record<string, unknown>[],
    offboarded_sheet: ilikeTableFixture([]),
    offboarding_queue: ilikeTableFixture([]),
    // Rate carriers: present and empty, so the rate reads run and come back
    // BLANK rather than erroring. Their chains are asserted below and in
    // termination-rates-reads.test.ts.
    hr_pending_employees: ilikeTableFixture([]),
    employee_rate_history: [] as Record<string, unknown>[],
    payment_dispatches: [] as Record<string, unknown>[],
    disbursement_records: [] as Record<string, unknown>[],
    // The currency carrier, present and empty — so a rate resolves in PHP off
    // the rates-sheet layer rather than coming back undenominated.
    payment_catalog_pay_structures: [] as Record<string, unknown>[],
    ...over,
  };
}

/** A timesheet that READ FINE and HAS ROWS, none of them this person's — the
 *  shape of a real leaver, and the only shape in which "did not work" is a fact
 *  rather than an absence. An index with no rows at all is a DIFFERENT state
 *  (`unavailable`), and the test below pins it separately. */
const TIMESHEET_WITHOUT_THEM: Parameters<typeof setTestCycleHours>[0] = {
  emails: ['someone.else@simple.biz'],
  nameTokenKeys: ['else someone'],
};

/**
 * One resolution's worth of world: the tables, plus a healthy cycle timesheet
 * that does not name this person. Every test that wants a different timesheet
 * says so explicitly, because "the timesheet could not be read" is a BLOCK and
 * "the timesheet is empty" is a degraded note — neither may be confused with the
 * refusal under test.
 */
function harness(
  spec: Record<string, FakeTableFixture>,
  cycleHours: Parameters<typeof setTestCycleHours>[0] = TIMESHEET_WITHOUT_THEM,
): FakeSupabase {
  const fake = createFakeSupabase({ tables: spec });
  setTestSupabaseClient(fake.client);
  setTestCycleHours(cycleHours);
  return fake;
}

// ── G1: the identity read, and what may appear in a query ───────────────────

test('G1: the identity read filters "Work Email" with an ESCAPED pattern', async () => {
  // `_` is an ILIKE SINGLE-CHARACTER WILDCARD and legal in an email local-part,
  // so an unescaped `a_b@simple.biz` also matches `axb@simple.biz` — a DIFFERENT
  // PERSON. The double implements real ILIKE semantics, so the decoy row below
  // is returned the moment escapeLikePattern is dropped, and the two rows then
  // name two people, which the arbitration refuses as ambiguous.
  const subject = 'a_b@simple.biz';
  const master = masterListFixture([
    masterRow({
      id: '22222222-2222-4222-8222-222222222222',
      Name: 'Ana Bee',
      'Work Email': subject,
      'Personal Email': 'ana.bee@gmail.com',
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
    masterRow({
      id: '33333333-3333-4333-8333-333333333333',
      Name: 'Alex Xavier Bond',
      'Work Email': 'axb@simple.biz',
      'Personal Email': 'axb@gmail.com',
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
  ]);
  const fake = harness(tables(master));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(subject);

  const identityRead = fake
    .opsFor('global_master_list')
    .find((op) => chainArgs(op, 'ilike')?.[0] === '"Work Email"');
  assert.ok(identityRead, 'no read filtered global_master_list on "Work Email"');
  assert.deepEqual(chainArgs(identityRead, 'ilike'), ['"Work Email"', 'a\\_b@simple.biz']);
  // One row, one person: the wildcard did not reach the decoy.
  assert.equal(res.blocked?.code, undefined, res.blocked?.message ?? '');
  assert.deepEqual(res.facts?.identity.candidateRowIds, [
    '22222222-2222-4222-8222-222222222222',
  ]);
});

test('G1: no query anywhere in the assembly carries the personal email', async () => {
  // THE PRINTED-MONEY GUARD. A personal email SEARCHES; a work email
  // IDENTIFIES. One gmail backs two master identities, so a rate, a paystub or
  // an off-board stamp keyed on the shared inbox can belong to the OTHER person
  // — and it is printed on a signed page. This walks every operation the whole
  // assembly performed (master, status map, evidence, sheet, and every rate
  // carrier) and refuses to find the address anywhere.
  const master = masterListFixture([
    masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned' }),
  ]);
  const fake = harness(tables(master));
  const { resolveTerminationFacts } = await factsModule();

  await resolveTerminationFacts(LEAVER);

  const offenders = fake
    .ops.filter((op) => op.chain.some((c) => c.toLowerCase().includes(SHARED_GMAIL)))
    .map((op) => `${op.table}: ${op.chain.join('.')}`);
  assert.deepEqual(offenders, [], `a personal email reached a query:\n${offenders.join('\n')}`);
});

test('G1: nothing in the assembly builds an .or() filter', async () => {
  // PostgREST parses an `.or()` argument as `column.op.value`, so the dots in an
  // email mis-split the filter and it reports a bogus "column does not exist"
  // (global-master-list-db.ts:1359-1373). This is the runtime half of the source
  // grep — an `.or()` reached through a helper would not be in this file's text.
  const fake = harness(
    tables(masterListFixture([masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned' })])),
  );
  const { resolveTerminationFacts } = await factsModule();

  await resolveTerminationFacts(LEAVER);

  assert.deepEqual(
    fake.allChainEntries().filter((c) => c.startsWith('or(')),
    [],
  );
});

test("G1: the evidence read is keyed 'work', so a shared inbox lends no departure", async () => {
  // `loadOffboardEvidenceByEmail('all')` indexes the PERSONAL columns too, and
  // this data routinely holds a WORK address in a "Personal Email" cell. Under
  // 'all', the subject below would inherit the OTHER row's resigned stamp and
  // its date; under 'work' it can only ever see its own.
  const master = masterListFixture([
    // The subject: stamped, but with no reason of its own.
    masterRow({
      id: '44444444-4444-4444-8444-444444444444',
      Name: 'Carla Ruiz',
      'Work Email': ACTIVE,
      'Personal Email': 'carla.ruiz@gmail.com',
      off_boarded_at: '2026-01-05',
      off_boarded_reason: null,
    }),
    // A DIFFERENT person whose "Personal Email" cell holds the subject's WORK
    // address — the shape that makes 'all' dangerous.
    masterRow({
      id: '55555555-5555-4555-8555-555555555555',
      'Work Email': LEAVER,
      'Personal Email': ACTIVE,
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
  ]);
  harness(tables(master));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(ACTIVE);

  assert.equal(res.blocked, null, res.blocked?.message ?? '');
  assert.equal(
    res.facts?.terminationDate,
    '2026-01-05',
    'the subject inherited the other identity\'s departure date — the evidence read is no longer keyed \'work\'',
  );
  assert.equal(res.facts?.reasonKey, null, 'a borrowed reason reached the facts sheet');
  assert.ok(res.facts?.blanks.includes('reason'));
});

// ── G3: an active person can never be terminated on paper ───────────────────

test('G3: a live roster row with NOTHING recording a departure refuses the letter', async () => {
  // The two identities share one gmail, so the status map keys the shared inbox
  // ACTIVE off the unstamped row — and the stamped identity beside it is still
  // issuable. That pair is what makes this fixture worth having: it is the
  // documented cross-wire, answered from ONE table by the real map read.
  const master = masterListFixture([
    masterRow({
      id: '66666666-6666-4666-8666-666666666666',
      'Work Email': LEAVER,
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
    masterRow({
      id: '77777777-7777-4777-8777-777777777777',
      Name: 'Carla Ruiz',
      'Work Email': ACTIVE,
      off_boarded_at: null,
      off_boarded_reason: null,
    }),
  ]);
  harness(tables(master));
  const { resolveTerminationFacts } = await factsModule();

  const active = await resolveTerminationFacts(ACTIVE);
  assert.equal(active.facts, null, 'facts were resolved for a working employee');
  assert.equal(active.blocked?.code, 'still_active');

  // The negative control, on the SAME table: the stamped identity is issuable,
  // so the guard cannot pass by refusing everyone.
  const leaver = await resolveTerminationFacts(LEAVER);
  assert.equal(leaver.blocked, null, leaver.blocked?.message ?? '');
  assert.equal(leaver.facts?.terminationDate, '2026-06-03');
});

test('G3: an email the status map never mentions is NOT treated as active', async () => {
  // The polarity is `map.get(norm)?.active === true`. Flipped to `!== false`,
  // every email absent from the map becomes ACTIVE and no letter can ever be
  // issued — and the absence is REAL: the map's paged scan (gml-status.ts:48-58)
  // runs `.range()` with no `.order()`, so a concurrent master sync can shear a
  // page and drop a row.
  const stamped = masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned' });
  const master: FakeTableFixture = (op) => {
    // The status-map read carries no filter at all; the identity read carries
    // the "Work Email" ilike. Answer the map with NOTHING.
    if (!chainArgs(op, 'ilike')) return [];
    return [stamped];
  };
  harness(tables(master));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  assert.notEqual(
    res.blocked?.code,
    'still_active',
    'an absent map entry was read as ACTIVE — the polarity inverted',
  );
  assert.equal(res.blocked, null, res.blocked?.message ?? '');
  assert.equal(res.facts?.terminationDate, '2026-06-03');

  // The half that pins the polarity itself. With NOTHING recording a departure,
  // `gmlActive` is what arm 3 consults, so an absent map entry read as ACTIVE
  // turns this into `still_active` — a person nobody can ever document.
  const unstampedOnOldUpload = masterRow({ last_seen_upload_id: '99' });
  harness(
    tables((op) => (chainArgs(op, 'ilike') ? [unstampedOnOldUpload] : [])),
  );
  const stranded = await resolveTerminationFacts(LEAVER);
  assert.equal(
    stranded.blocked?.code,
    'no_departure_evidence',
    'an absent map entry was read as ACTIVE — the polarity inverted',
  );
});

test('G3: hours in the current cycle refuse the letter whatever the stamps say', async () => {
  // The one signal a stale off-board stamp cannot forge. The timesheet is
  // matched on ANY address the master rows know the person by, so the fixture
  // below is a hit on the work email while the master row says "resigned".
  const master = masterListFixture([
    masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned' }),
  ]);
  harness(tables(master), { emails: [LEAVER] });
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  assert.equal(res.facts, null, 'facts were resolved for someone on the clock');
  assert.equal(res.blocked?.code, 'still_active');
  assert.match(res.blocked?.message ?? '', /timesheet/i);
});

test('G3: the timesheet is read for the CURRENT cycle, and an unreadable one BLOCKS', async () => {
  // `null` is the only correct argument: it means "the `is_current` Hubstaff
  // upload". A hard-coded file would answer the wrong week forever.
  const master = masterListFixture([
    masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned' }),
  ]);
  harness(tables(master), { error: 'Could not list hubstaff_uploads' });
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  assert.deepEqual(testCycleHoursCalls(), [null]);
  assert.equal(res.facts, null, 'an unreadable timesheet still produced a facts sheet');
  assert.equal(res.blocked?.code, 'evidence_read_failed');
});

test('G3: a status-map read that FAILS blocks instead of reading as "not active"', async () => {
  // `map.get(norm)?.active === true` on an ERRORED map is `false`, i.e. "not
  // active" — the absolute refusal resting on a read that did not happen. The
  // map's read is the UNFILTERED pass over global_master_list, so failing that
  // one alone is the whole fixture.
  const stamped = masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned' });
  const master: FakeTableFixture = (op) => {
    if (chainArgs(op, 'ilike')) return [stamped];
    return { data: null, error: { message: 'canceling statement due to statement timeout' } };
  };
  harness(tables(master));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  assert.equal(res.facts, null, 'a failed active-roster check still produced a facts sheet');
  assert.equal(res.blocked?.code, 'evidence_read_failed');
  assert.match(res.blocked?.message ?? '', /roster/i);
});

// ── A failed read is never "nothing found" ──────────────────────────────────

/** Nobody stamped, nobody live: an unstamped row on a SUPERSEDED upload, absent
 *  from the status map. Real shape — the sheet dropped the person and no stamp
 *  was ever written — and the only one that reaches arm 4, since a live
 *  unstamped row is refused as `still_active` by arm 3. */
function strandedRowFixture(): FakeTableFixture {
  const row = masterRow({ last_seen_upload_id: '99' });
  return (op) => (chainArgs(op, 'ilike') ? [row] : []);
}

test('a departure-evidence read that FAILS blocks generation instead of reading as "never left"', async () => {
  // `loadOffboardEvidenceByEmail` has no error channel — every source read is
  // `.catch(() => {})` — so a smaller map is indistinguishable from "nobody
  // left". `readsDegraded`, assembled from the reads in THIS module, is the only
  // thing that separates the two.
  const failing: FakeTableFixture = () => ({
    data: null,
    error: { message: 'canceling statement due to statement timeout' },
  });
  harness(tables(strandedRowFixture(), { offboarded_sheet: failing }));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  assert.equal(res.facts, null);
  assert.equal(
    res.blocked?.code,
    'evidence_read_failed',
    'a broken read was reported as "there is no departure to document"',
  );
});

test('the same fixture with every read HEALTHY says no_departure_evidence', async () => {
  // The negative control for the test above: without it, "blocks on a failed
  // read" could be satisfied by blocking on everything.
  harness(tables(strandedRowFixture()));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  assert.equal(res.facts, null);
  assert.equal(res.blocked?.code, 'no_departure_evidence');
});

test('T1: an identity read that FAILS blocks — and never becomes "no master row"', async () => {
  // `selectAllPaged` hands back whatever pages arrived before the failure, so an
  // empty array and a one-row array are equally untrustworthy. Reporting
  // `no_master` off either would tell the rep this person is not in the roster.
  const failing: FakeTableFixture = () => ({
    data: null,
    error: { message: 'canceling statement due to statement timeout' },
  });
  harness(tables(failing));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  assert.equal(res.facts, null, 'a failed master read produced printable facts');
  assert.equal(res.blocked?.code, 'evidence_read_failed');
  assert.match(res.blocked?.message ?? '', /master-list read/);
});

// ── Refusals cost nothing; rates are read last ──────────────────────────────

test('G2/G6: a refusal reads NO rate carrier — no rate query is issued at all', async () => {
  // Contract §5 G2 layer 2: the refusal is returned BEFORE any rate read and any
  // render. Cheap to say, invisible without this: the rate carriers are five
  // more round trips and one of them (payment_dispatches) pages a 4,000-row
  // table.
  const master = masterListFixture([
    masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'Temporary Pause' }),
  ]);
  const fake = harness(tables(master));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);
  assert.equal(res.blocked?.code, 'temporary_pause');

  const rateTables = ['hr_pending_employees', 'employee_rate_history', 'payment_dispatches', 'disbursement_records'];
  assert.deepEqual(
    fake.ops.filter((op) => rateTables.includes(op.table)).map((op) => op.table),
    [],
    'a blocked resolution still read the rate carriers',
  );

  // The positive control: an ISSUABLE record does reach them, so the assertion
  // above cannot pass because the rate reads were never wired up.
  const ok = harness(
    tables(masterListFixture([masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned' })])),
  );
  const res2 = await resolveTerminationFacts(LEAVER);
  assert.equal(res2.blocked, null, res2.blocked?.message ?? '');
  assert.ok(
    ok.ops.some((op) => rateTables.includes(op.table)),
    'the rate carriers were never read even for an issuable record',
  );
});

// ── The 1000-row cap ────────────────────────────────────────────────────────

test('the identity read PAGES — a full 1000-row page is followed by another', async () => {
  // PostgREST truncates at db.max-rows (1000) EVEN WITH `.range()`, silently.
  // `jan@simple.biz` alone carries 95 master rows, and the promotion rule reads
  // EVERY row for this email — a truncated read can drop the very row that
  // proves the winner, and there is no error to notice.
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 1001; i += 1) {
    rows.push(
      masterRow({
        id: `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`,
        off_boarded_at: '2026-06-03',
        off_boarded_reason: 'resigned',
        // The LAST row is the only one on the current upload, so it can only win
        // the promotion if the second page was actually fetched.
        last_seen_upload_id: i === 1000 ? CURRENT_UPLOAD : '99',
      }),
    );
  }
  const fake = harness(tables(masterListFixture(rows)));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  const identityReads = fake
    .opsFor('global_master_list')
    .filter((op) => chainArgs(op, 'ilike')?.[0] === '"Work Email"');
  assert.equal(identityReads.length, 2, 'the read stopped after one 1000-row page');
  assert.deepEqual(
    identityReads.map((op) => [op.from, op.to]),
    [
      [0, 999],
      [1000, 1999],
    ],
  );
  assert.equal(res.blocked, null, res.blocked?.message ?? '');
  assert.equal(res.facts?.identity.candidateRowIds.length, 1001);
  assert.equal(
    res.facts?.identity.masterRowId,
    '88888888-8888-4888-8888-000000001000',
    'the row on the CURRENT upload lost, so the second page never arrived',
  );
  assert.equal(res.facts?.identity.onCurrentUpload, true);
});

// ── T4: the three timesheet states, through the real assembly ───────────────

test('G3/T4: an EMPTY-but-healthy timesheet resolves the letter AND says the signal was missing', async () => {
  // THE ROUND-2 BLOCKER, end to end. `loadCycleHoursIndex` returns empty sets
  // with `error: null` whenever the `is_current` upload holds no rows, and the
  // old caller spelled the read as `hours.error ? null : personWorkedCycle(...)`
  // — a CONFIDENT "did not work" for every person on the roster, with nothing
  // said to the rep. It must resolve (an empty timesheet is not a reason to
  // refuse an ordinary leaver) and it must SPEAK.
  const master = masterListFixture([
    masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned' }),
  ]);
  harness(tables(master), { emails: [], nameTokenKeys: [] });
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  assert.equal(res.blocked, null, res.blocked?.message ?? '');
  assert.ok(
    res.facts?.degraded.some((d) => /timesheet is EMPTY/.test(d)),
    'an absent hours signal was passed off as "this person did not work"',
  );
});

test('G3/T4: the timesheet matches an address the master row never carried', async () => {
  // A working person's Hubstaff login is routinely an address
  // `global_master_list` does not hold. Matching only the four master email
  // columns misses those hours — and a missed hit prints a termination letter
  // for someone who worked this week. A hit only ever REFUSES, so the widest
  // reasonable match is the correct one.
  const master = masterListFixture([
    masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned' }),
  ]);
  harness(tables(master), { emails: ['carlath@gmail.com'] });
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  assert.equal(res.facts, null, 'someone on the clock was handed a facts sheet');
  assert.equal(res.blocked?.code, 'still_active');
});

// ── T3: the re-engagement guard, through the real assembly ──────────────────

test('G3/T3: a master row starting after the departure refuses the letter', async () => {
  // The winning row is the stamped one on the current upload, so the G4 arm —
  // which compares only the WINNER'S start date — passes. The re-hire's own row
  // sits on an older upload and states a later start date. This is the case the
  // timesheet was there to catch, caught without one.
  const master = masterListFixture([
    masterRow({
      id: '99999999-9999-4999-8999-999999999999',
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
    masterRow({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Start Date': '2026-07-01',
      last_seen_upload_id: '9',
    }),
  ]);
  harness(tables(master), { emails: [], nameTokenKeys: [] });
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  assert.equal(res.facts, null, 'a re-engaged employee was handed a facts sheet');
  assert.equal(res.blocked?.code, 'reengaged_after_departure');
  assert.match(res.blocked?.message ?? '', /2026-07-01/);
});

// ── A7: the third-party personal inbox parked in an alternate-work cell ─────

test("G1: a THIRD PARTY's personal inbox in an alternate-work cell never reaches a rate query", async () => {
  // Round 1 stopped the SUBJECT'S OWN personal email from keying a rate. Round 2
  // found the residue: `workAliasesForRateContext` can only see the subject's
  // rows, so somebody ELSE'S gmail sitting in an "Alternate Work Email" cell
  // sailed through — and `hr_pending_employees` / `employee_rate_history` are
  // keyed by whatever address the sheet era held, so that cell prints a
  // different person's rate as this person's STARTING RATE.
  const THIRD_PARTY_INBOX = 'mariaargote88@gmail.com';
  const master = masterListFixture([
    masterRow({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'Alternate Work Email': THIRD_PARTY_INBOX,
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
    // A DIFFERENT person — the inbox's actual owner.
    masterRow({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      Name: 'Argote, Maria',
      'Work Email': 'mariaa@simple.biz',
      'Personal Email': THIRD_PARTY_INBOX,
      off_boarded_at: null,
      off_boarded_reason: null,
    }),
  ]);
  const fake = harness(tables(master));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);
  assert.equal(res.blocked, null, res.blocked?.message ?? '');

  // The screen RAN: one targeted, escaped lookup of that address against the
  // Personal Email column. (Without this the next assertion could pass because
  // no alias was ever considered.)
  const screen = fake
    .opsFor('global_master_list')
    .filter((op) => chainArgs(op, 'ilike')?.[0] === '"Personal Email"');
  assert.deepEqual(
    screen.map((op) => chainArgs(op, 'ilike')?.[1]),
    [THIRD_PARTY_INBOX],
    'the alternate-work cell was never screened against the Personal Email column',
  );

  // And the address reached NO rate carrier.
  const rateTables = [
    'hr_pending_employees',
    'employee_rate_history',
    'payment_dispatches',
    'disbursement_records',
  ];
  const offenders = fake.ops
    .filter((op) => rateTables.includes(op.table))
    .filter((op) => op.chain.some((c) => c.toLowerCase().includes(THIRD_PARTY_INBOX)))
    .map((op) => `${op.table}: ${op.chain.join('.')}`);
  assert.deepEqual(
    offenders,
    [],
    `another person's personal inbox priced this letter:\n${offenders.join('\n')}`,
  );
  assert.ok(
    res.facts?.degraded.some((d) => d.includes(THIRD_PARTY_INBOX)),
    'the dropped alias was never explained to the rep',
  );
});

test('G1: a genuine ALTERNATE WORK address still reaches the rate carriers', async () => {
  // The negative control. Without it, "no alias reaches a rate query" would be
  // satisfied by dropping every alias, and the screen would be a silent outage.
  const ALTERNATE = 'carla.thomas@simple.biz';
  const master = masterListFixture([
    masterRow({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'Alternate Work Email': ALTERNATE,
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
  ]);
  const fake = harness(tables(master));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);
  assert.equal(res.blocked, null, res.blocked?.message ?? '');
  assert.ok(
    fake
      .opsFor('hr_pending_employees')
      .some((op) => chainArgs(op, 'ilike')?.[1] === ALTERNATE),
    'a genuine alternate work address was dropped from the rate lookup',
  );
});

test('G1: an alias whose SCREEN read fails is dropped, not trusted', async () => {
  // Fail closed. The alias set is only ever a widening, so losing one address
  // costs a blank the rep fills; keeping an unverified one costs a wrong figure
  // on a signed legal document.
  const ALTERNATE = 'carla.thomas@simple.biz';
  const rows = [
    masterRow({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'Alternate Work Email': ALTERNATE,
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
  ];
  const base = masterListFixture(rows);
  const master: FakeTableFixture = (op) => {
    if (chainArgs(op, 'ilike')?.[0] === '"Personal Email"') {
      return { data: null, error: { message: 'canceling statement due to statement timeout' } };
    }
    return base(op);
  };
  const fake = harness(tables(master));
  const { resolveTerminationFacts } = await factsModule();

  const res = await resolveTerminationFacts(LEAVER);

  assert.equal(res.blocked, null, res.blocked?.message ?? '');
  assert.equal(
    fake.opsFor('hr_pending_employees').some((op) => chainArgs(op, 'ilike')?.[1] === ALTERNATE),
    false,
    'an address whose provenance could not be established still priced the letter',
  );
  assert.ok(res.facts?.degraded.some((d) => /could not be checked/.test(d)));
});
