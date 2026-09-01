/** [TERMINATION-DOCS]
 * `searchTerminationCandidates` — the front door, exercised as queries.
 *
 * The union and the refusal stamping are pure (`buildTerminationCandidates`, and
 * `termination-facts.test.ts` covers them). What had NO test at all is the part
 * a rep actually meets: which columns are searched, whether the pattern is a
 * LIKE-escaped `%fragment%`, whether a 1000-row page is followed by another,
 * whether a failed read comes back as "nobody matched", and whether a
 * two-character query quietly drains the master list.
 *
 * Every read runs against the recording double in `./test-support/` — no
 * database, and the PRODUCTION credentials in `.env.local` are unreachable
 * because the client factory itself is replaced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTerminationServerStubs } from './test-support/stub-server-modules';
import { setTestSupabaseClient } from './test-support/supabase-server-stub';
import {
  chainArgs,
  chainArgsAll,
  createFakeSupabase,
  type FakeSupabase,
  type FakeTableFixture,
} from './test-support/fake-supabase';
import { ilikeTableFixture, masterListFixture } from './test-support/ilike-fixture';
import { TERMINATION_SEARCH_CANDIDATE_CAP, TERMINATION_SEARCH_MIN_QUERY } from './types';

installTerminationServerStubs();

type SearchModule = typeof import('./termination-search');
let loaded: SearchModule | null = null;
/** Imported lazily so the resolution hook above is installed first. */
async function searchModule(): Promise<SearchModule> {
  if (!loaded) loaded = await import('./termination-search');
  return loaded;
}

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

function tables(master: FakeTableFixture, over: Record<string, FakeTableFixture> = {}) {
  return {
    global_master_list: master,
    master_list_uploads: [{ id: CURRENT_UPLOAD }] as Record<string, unknown>[],
    offboarded_sheet: ilikeTableFixture([]),
    offboarding_queue: ilikeTableFixture([]),
    ...over,
  };
}

function harness(spec: Record<string, FakeTableFixture>): FakeSupabase {
  const fake = createFakeSupabase({ tables: spec });
  setTestSupabaseClient(fake.client);
  return fake;
}

/** Every `.ilike` the search issued, as `table."column" = pattern`. */
function ilikes(fake: FakeSupabase): string[] {
  return fake.ops.flatMap((op) => {
    const like = chainArgs(op, 'ilike');
    return like ? [`${op.table}.${like[0]} = ${like.slice(1).join(',')}`] : [];
  });
}

// ── G1: a personal email SEARCHES; a work email IDENTIFIES ──────────────────

test('G1: one shared gmail returns BOTH identities as candidates — never one', async () => {
  // The documented cross-wire: `carlathomas0112@gmail.com` backs the ACTIVE
  // `carla@simple.biz` and the resigned `carlath@simple.biz`
  // (offboard-evidence.ts:41-48). Collapsing that to one person is how the
  // active half of a cross-wire gets a letter, so the contract requires a SET
  // the rep disambiguates, each row stamped with the refusal it will meet.
  const master = masterListFixture([
    masterRow({
      id: '22222222-2222-4222-8222-222222222222',
      'Work Email': LEAVER,
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
    masterRow({
      id: '33333333-3333-4333-8333-333333333333',
      Name: 'Carla Ruiz',
      'Work Email': ACTIVE,
      off_boarded_at: null,
      off_boarded_reason: null,
    }),
  ]);
  harness(tables(master));
  const { searchTerminationCandidates } = await searchModule();

  const res = await searchTerminationCandidates(SHARED_GMAIL);

  assert.equal(res.error, null);
  assert.deepEqual(
    res.candidates.map((c) => c.workEmail).sort(),
    [ACTIVE, LEAVER],
    'the search collapsed a shared inbox to a single identity',
  );
  const active = res.candidates.find((c) => c.workEmail === ACTIVE);
  const leaver = res.candidates.find((c) => c.workEmail === LEAVER);
  assert.equal(active?.active, true, 'the working identity was not stamped ACTIVE');
  assert.equal(active?.blockedCode, 'still_active', 'the working identity rendered as issuable');
  assert.equal(leaver?.active, false);
  assert.equal(leaver?.blockedCode, null, 'the genuine leaver was greyed out');
});

test('G1: every email pattern is a LIKE-ESCAPED %fragment% — the _ wildcard cannot leak', async () => {
  // `_` is an ILIKE single-character wildcard and legal in an email local-part,
  // so `a_b@simple.biz` unescaped also matches `axb@simple.biz` — a DIFFERENT
  // PERSON, offered to the rep as the same one. The double implements real ILIKE
  // semantics, so the decoy below appears the moment the escape is dropped.
  const master = masterListFixture([
    masterRow({
      id: '44444444-4444-4444-8444-444444444444',
      Name: 'Ana Bee',
      'Work Email': 'a_b@simple.biz',
      'Personal Email': 'ana.bee@gmail.com',
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
    masterRow({
      id: '55555555-5555-4555-8555-555555555555',
      Name: 'Alex Xavier Bond',
      'Work Email': 'axb@simple.biz',
      'Personal Email': 'axb@gmail.com',
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
  ]);
  const fake = harness(tables(master));
  const { searchTerminationCandidates } = await searchModule();

  const res = await searchTerminationCandidates('a_b@simple.biz');

  assert.deepEqual(
    res.candidates.map((c) => c.workEmail),
    ['a_b@simple.biz'],
    'the underscore matched a second person',
  );
  // The four master email columns each get their OWN escaped pass — one `.or()`
  // carrying an email would mis-split on the dots.
  for (const col of [
    '"Work Email"',
    '"Personal Email"',
    '"Alternate Work Email"',
    '"Alternate Work Email 2"',
  ]) {
    assert.ok(
      ilikes(fake).includes(`global_master_list.${col} = %a\\_b@simple.biz%`),
      `no escaped pass on global_master_list.${col}`,
    );
  }
});

test('G1: nothing in the search builds an .or() filter', async () => {
  const fake = harness(tables(masterListFixture([masterRow({})])));
  const { searchTerminationCandidates } = await searchModule();

  await searchTerminationCandidates(SHARED_GMAIL);

  assert.deepEqual(
    fake.allChainEntries().filter((c) => c.startsWith('or(')),
    [],
  );
});

test('G1: a completed queue row with no WORK email yields no candidate', async () => {
  // `offboarding_queue.employee_email` and `employee_personal_email` are both
  // PERSONAL addresses on every completed row (460/460, measured 2026-08-21), so
  // they are SEARCH keys only. Without a work email there is no identity, and a
  // document keyed on a personal address is the whole failure G1 exists for.
  harness(
    tables(masterListFixture([]), {
      offboarding_queue: ilikeTableFixture([
        {
          employee_name: 'Carla Thomas',
          employee_email: SHARED_GMAIL,
          employee_work_email: null,
          employee_personal_email: SHARED_GMAIL,
          department: 'Support',
          decided_at: '2026-06-03',
          reason: 'resigned',
        },
      ]),
    }),
  );
  const { searchTerminationCandidates } = await searchModule();

  const res = await searchTerminationCandidates(SHARED_GMAIL);

  assert.deepEqual(res.candidates, [], 'a personal address became an identity');
});

// ── Limits that speak ───────────────────────────────────────────────────────

test('a query shorter than the minimum runs NO read at all', async () => {
  // `%a%` is a table dump, not a search. The refusal has to be a stated
  // `tooShort`, not a capped page the rep reads as "that is everyone".
  const fake = harness(tables(masterListFixture([masterRow({})])));
  const { searchTerminationCandidates } = await searchModule();

  const res = await searchTerminationCandidates('ab');

  assert.equal(res.tooShort, true);
  assert.deepEqual(res.candidates, []);
  assert.deepEqual(fake.ops, [], 'a two-character query still hit the database');
  assert.ok(TERMINATION_SEARCH_MIN_QUERY >= 3);
});

test('a read that FAILS is surfaced, never returned as "nobody matched"', async () => {
  // A silent empty result from a broken read is indistinguishable from "this
  // person was never offboarded" — and the rep's next move is to conclude there
  // is nothing to document.
  const failing: FakeTableFixture = () => ({
    data: null,
    error: { message: 'canceling statement due to statement timeout' },
  });
  harness(
    tables(
      masterListFixture([
        masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned' }),
      ]),
      { offboarding_queue: failing },
    ),
  );
  const { searchTerminationCandidates } = await searchModule();

  const res = await searchTerminationCandidates(SHARED_GMAIL);

  assert.notEqual(res.error, null, 'a failed read reported success');
  assert.match(res.degraded.join(' | '), /offboarding_queue/);
  // What DID read still comes back: a degraded search is not an empty one.
  assert.deepEqual(res.candidates.map((c) => c.workEmail), [LEAVER]);
});

test('the search PAGES, and says so when the candidate cap truncates', async () => {
  // PostgREST truncates at db.max-rows (1000) EVEN WITH `.range()`. A search
  // that stopped at one page would hide every identity past the first thousand
  // and look exactly like "that person does not exist".
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 1001; i += 1) {
    rows.push(
      masterRow({
        id: `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`,
        Name: `Dupe Person ${i}`,
        'Work Email': `dupe${i}@simple.biz`,
        'Personal Email': `dupe${i}@gmail.com`,
        off_boarded_at: '2026-06-03',
        off_boarded_reason: 'resigned',
      }),
    );
  }
  const fake = harness(tables(masterListFixture(rows)));
  const { searchTerminationCandidates } = await searchModule();

  const res = await searchTerminationCandidates('dupe');

  const workEmailPass = fake
    .opsFor('global_master_list')
    .filter((op) => chainArgs(op, 'ilike')?.[0] === '"Work Email"');
  assert.deepEqual(
    workEmailPass.map((op) => [op.from, op.to]),
    [
      [0, 999],
      [1000, 1999],
    ],
    'the read stopped after one 1000-row page',
  );
  assert.equal(res.matched, 1001, 'the 1001st identity was dropped');
  assert.equal(res.truncated, true);
  assert.equal(res.candidates.length, TERMINATION_SEARCH_CANDIDATE_CAP);
});

// ── NAME SEARCH — the rep's actual front door ───────────────────────────────
//
// Round 1's BLOCKER was that this module matched only exact, full email
// addresses while the panel promised name search in four places. The fix landed;
// what it did NOT get was a behavioural test — every query in this file was an
// email fragment, so the rows a NAME query returns were never proved to reach
// the candidate list. These tests run the real search and assert on the queries
// and the candidates together.

/** Every `.ilike` on a given column, across the whole run, as its pattern. */
function patternsOn(fake: FakeSupabase, table: string, column: string): string[] {
  return fake
    .opsFor(table)
    .flatMap((op) => chainArgsAll(op, 'ilike'))
    .filter((like) => like[0] === column)
    .map((like) => like.slice(1).join(','));
}

test('a NAME query issues a name pass on ALL THREE carriers', async () => {
  // A rep holding a reference request has a NAME, and the person may have left
  // in 2023 under an address nobody remembers. If the name columns are not
  // filtered, the front door is shut: `searchTerminationCandidates` would return
  // nothing and the panel's no-match pane would tell the rep to try "a surname
  // on its own" — advice that could never work.
  const fake = harness(
    tables(masterListFixture([masterRow({ off_boarded_at: '2026-06-03', off_boarded_reason: 'resigned' })])),
  );
  const { searchTerminationCandidates } = await searchModule();

  await searchTerminationCandidates('thomas');

  assert.deepEqual(patternsOn(fake, 'global_master_list', '"Name"'), ['%thomas%']);
  assert.deepEqual(patternsOn(fake, 'offboarded_sheet', 'name'), ['%thomas%']);
  assert.deepEqual(patternsOn(fake, 'offboarding_queue', 'employee_name'), ['%thomas%']);
});

test('rows found by NAME become candidates — the identity is the row\'s work email', async () => {
  // The half round 1 never proved: issuing the query is not the same as the rows
  // reaching the rep. The subject below is reachable ONLY by name — the fragment
  // appears in no email column at all.
  const master = masterListFixture([
    masterRow({
      id: '77777777-7777-4777-8777-777777777777',
      Name: 'Thomas, Carla',
      'Work Email': LEAVER,
      // Deliberately an inbox that does NOT contain the query fragment: the row
      // must be reachable by the NAME column and nothing else.
      'Personal Email': 'ct.leaver@gmail.com',
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
  ]);
  harness(tables(master));
  const { searchTerminationCandidates } = await searchModule();

  const res = await searchTerminationCandidates('thomas');

  assert.equal(res.error, null);
  assert.deepEqual(res.candidates.map((c) => c.workEmail), [LEAVER]);
  assert.equal(res.candidates[0].matchedColumn, 'Name');
  assert.equal(res.candidates[0].name, 'Thomas, Carla');
  assert.equal(res.candidates[0].offDate, '2026-06-03');
  assert.equal(res.candidates[0].blockedCode, null, 'a genuine leaver was greyed out');
});

test('a PARTIAL name matches — a rep types what they remember, not the cell', async () => {
  const master = masterListFixture([
    masterRow({
      Name: 'Thomas, Carla',
      'Work Email': LEAVER,
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
  ]);
  harness(tables(master));
  const { searchTerminationCandidates } = await searchModule();

  const res = await searchTerminationCandidates('thom');

  assert.deepEqual(res.candidates.map((c) => c.workEmail), [LEAVER]);
});

test('a MULTI-TOKEN name is ANDed, so "carla thomas" finds "Thomas, Carla"', async () => {
  // The master Name column is Last-comma-First for most of the table, so a
  // whole-string `%carla thomas%` matches nothing. Each word gets its own
  // `.ilike` on the SAME column and PostgREST ANDs them — which is also why the
  // AND has to be real: ORing them, or honouring only the first word, would hand
  // the rep every Carla in the roster.
  const master = masterListFixture([
    masterRow({
      id: '77777777-7777-4777-8777-777777777777',
      Name: 'Thomas, Carla',
      'Work Email': LEAVER,
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
    masterRow({
      id: '88888888-8888-4888-8888-888888888888',
      Name: 'Ruiz, Carla',
      'Work Email': 'carlar@simple.biz',
      'Personal Email': 'carla.ruiz@gmail.com',
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
  ]);
  const fake = harness(tables(master));
  const { searchTerminationCandidates } = await searchModule();

  const res = await searchTerminationCandidates('carla thomas');

  assert.deepEqual(patternsOn(fake, 'global_master_list', '"Name"'), ['%carla%', '%thomas%']);
  assert.deepEqual(
    res.candidates.map((c) => c.workEmail),
    [LEAVER],
    'the second word did not narrow the result — the other Carla came back too',
  );
});

test('a NAME query is LIKE-ESCAPED — the _ wildcard cannot leak through a name', async () => {
  // Pasted text carries `_` and `%` as readily as an address does, and `_` is an
  // ILIKE SINGLE-CHARACTER WILDCARD: unescaped, `Sy_lva` also matches `Sylva`
  // and `Sy8lva` — different people offered to the rep as the same one.
  const master = masterListFixture([
    masterRow({
      id: '77777777-7777-4777-8777-777777777777',
      Name: 'Sy_lva, Ana',
      'Work Email': 'anas@simple.biz',
      'Personal Email': 'ana.sy@gmail.com',
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
    masterRow({
      id: '88888888-8888-4888-8888-888888888888',
      Name: 'Sydlva, Bea',
      'Work Email': 'beas@simple.biz',
      'Personal Email': 'bea.sy@gmail.com',
      off_boarded_at: '2026-06-03',
      off_boarded_reason: 'resigned',
    }),
  ]);
  const fake = harness(tables(master));
  const { searchTerminationCandidates } = await searchModule();

  const res = await searchTerminationCandidates('sy_lva');

  assert.deepEqual(patternsOn(fake, 'global_master_list', '"Name"'), ['%sy\\_lva%']);
  assert.deepEqual(
    res.candidates.map((c) => c.workEmail),
    ['anas@simple.biz'],
    'the underscore matched a second person',
  );
});

test('a NAME query past the cap reports the cap instead of truncating silently', async () => {
  // A row the rep cannot see reads as "this person was never offboarded", and a
  // surname is precisely the query that returns hundreds. The response has to
  // say so — the panel renders `matched` and `truncated`, not just the page.
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < TERMINATION_SEARCH_CANDIDATE_CAP + 7; i += 1) {
    rows.push(
      masterRow({
        id: `99999999-9999-4999-8999-${String(i).padStart(12, '0')}`,
        Name: `Santos, Person${i}`,
        'Work Email': `santos${i}@simple.biz`,
        'Personal Email': `santos${i}@gmail.com`,
        off_boarded_at: '2026-06-03',
        off_boarded_reason: 'resigned',
      }),
    );
  }
  harness(tables(masterListFixture(rows)));
  const { searchTerminationCandidates } = await searchModule();

  const res = await searchTerminationCandidates('santos');

  assert.equal(res.matched, TERMINATION_SEARCH_CANDIDATE_CAP + 7);
  assert.equal(res.truncated, true, 'the cap truncated the list without saying so');
  assert.equal(res.candidates.length, TERMINATION_SEARCH_CANDIDATE_CAP);
});

test('a NAME pass never builds an .or() filter, however many words it carries', async () => {
  // PostgREST parses an `.or()` argument as `column.op.value`; a pasted name
  // with a comma or a dot in it mis-splits the filter and reports a bogus
  // "column does not exist".
  const fake = harness(tables(masterListFixture([masterRow({})])));
  const { searchTerminationCandidates } = await searchModule();

  await searchTerminationCandidates('thomas, carla jane');

  assert.deepEqual(
    fake.allChainEntries().filter((c) => c.startsWith('or(')),
    [],
  );
});
