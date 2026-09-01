/** [TERMINATION-DOCS]
 * The correctness core of Termination Docs, exercised on injected rows.
 *
 * These tests import the PURE `./termination-arbitration`, not
 * `./termination-facts` — the latter opens with `import 'server-only'`, which
 * does not resolve under `node --import tsx --test`. That split is the whole
 * reason the arbitration is a separate module (the `readiness-score.ts`
 * precedent), and it is why these guards are unit tests instead of a mocked
 * Supabase client.
 *
 * Nothing here touches a database. `.env.local` holds PRODUCTION service-role
 * credentials, so a fixture is the only acceptable shape for this file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeMasterDate } from '@/lib/roster/master-date';
import { sanitizeOffboardDay } from '@/lib/roster/offboard-date-sanity';
import { isTerminationDepartureReason } from './types';
import { reasonKey } from './reason-key';
import {
  arbitrateTerminationFacts,
  buildTerminationCandidates,
  explicitMasterDay,
  isRealCalendarDay,
  workAliasesForRateContext,
  type TerminationArbitrationInput,
  type TerminationCandidateObservation,
  type TerminationMasterRow,
} from './termination-arbitration';
import type { TerminationCycleHoursSignal } from './termination-cycle-hours';

/**
 * The four states the cycle timesheet can be in, named once.
 *
 * `HOURS_MISS` is the ONLY one that means "this person did not work": it says
 * the index was readable AND had rows in it AND this person was not among them.
 * `HOURS_UNAVAILABLE` — an index that read fine and is empty overall — is a
 * DIFFERENT fact, and the round-2 blocker was that the old code could not tell
 * the two apart.
 */
const HOURS_MISS: TerminationCycleHoursSignal = { state: 'ready', worked: false, matchedBy: null };
const HOURS_HIT: TerminationCycleHoursSignal = {
  state: 'ready',
  worked: true,
  matchedBy: 'the address jane@simple.biz',
};
const HOURS_UNREADABLE: TerminationCycleHoursSignal = {
  state: 'unreadable',
  error: 'No Hubstaff upload to build the cycle hours index from',
};
const HOURS_UNAVAILABLE: TerminationCycleHoursSignal = { state: 'unavailable' };

/** Frozen clock. Every date assertion below is stable forever because of it —
 *  `sanitizeOffboardDay` compares against `now`, so a real clock would turn
 *  "2027-04-20 is impossible" into a passing test that silently starts failing
 *  in 2027. */
const NOW = new Date('2026-09-01T00:00:00.000Z');

const CURRENT_UPLOAD = '412';

function masterRow(over: Partial<TerminationMasterRow> = {}): TerminationMasterRow {
  return {
    id: 'gml-1',
    name: 'Doe, Jane',
    workEmail: 'jane@simple.biz',
    personalEmail: null,
    alternateWorkEmail: null,
    alternateWorkEmail2: null,
    departmentRaw: 'Accounting',
    startDateRaw: '2024-03-04',
    offBoardedAtRaw: '2026-06-03',
    offBoardedReason: 'resigned',
    uploadId: CURRENT_UPLOAD,
    uploadSeq: 412,
    ...over,
  };
}

function arbInput(over: Partial<TerminationArbitrationInput> = {}): TerminationArbitrationInput {
  return {
    workEmail: 'jane@simple.biz',
    masterRows: [masterRow()],
    currentUploadId: CURRENT_UPLOAD,
    gmlActive: false,
    // The healthy shape: both "is this person working" reads SUCCEEDED and both
    // said no. Every refusal that depends on them is exercised by overriding
    // these two, never by leaving them out — an omitted read is a BLOCK.
    gmlStatusError: null,
    masterReadError: null,
    evidenceReadError: null,
    cycleHours: HOURS_MISS,
    evidence: { offDate: '2026-06-03', reason: 'resigned' },
    sheetRows: [],
    readsDegraded: false,
    degraded: [],
    now: NOW,
    ...over,
  };
}

function observation(
  over: Partial<TerminationCandidateObservation> = {},
): TerminationCandidateObservation {
  return {
    source: 'master',
    matchedColumn: 'Personal Email',
    workEmail: 'jane@simple.biz',
    personalEmail: null,
    name: 'Doe, Jane',
    departmentRaw: 'Accounting',
    rawOffDate: '2026-06-03',
    rawReason: 'resigned',
    onCurrentUpload: true,
    uploadSeq: 412,
    ...over,
  };
}

// ─── The shared-personal-email cross-wire ────────────────────────────────────
// The single most important test in the feature. `carla@simple.biz` (Active) and
// `carlath@simple.biz` (resigned 2026-06-03) share `carlathomas0112@gmail.com`
// (src/lib/roster/offboard-evidence.ts:41-48). Keyed on the personal email this
// feature would issue a termination letter for a working employee.

const SHARED_GMAIL = 'carlathomas0112@gmail.com';

const CARLA_ACTIVE = masterRow({
  id: 'gml-carla',
  name: 'Thomas, Carla',
  workEmail: 'carla@simple.biz',
  personalEmail: SHARED_GMAIL,
  departmentRaw: 'USEE',
  startDateRaw: '2025-01-06',
  offBoardedAtRaw: null,
  offBoardedReason: null,
});

const CARLATH_RESIGNED = masterRow({
  id: 'gml-carlath',
  name: 'Thomas, Carla',
  workEmail: 'carlath@simple.biz',
  personalEmail: SHARED_GMAIL,
  departmentRaw: 'Accounting',
  startDateRaw: '2023-05-02',
  offBoardedAtRaw: '2026-06-03',
  offBoardedReason: 'resigned',
});

test('cross-wire: searching one shared personal inbox returns BOTH identities, not one', () => {
  const candidates = buildTerminationCandidates({
    observations: [
      observation({
        matchedColumn: 'Personal Email',
        workEmail: CARLA_ACTIVE.workEmail,
        personalEmail: SHARED_GMAIL,
        name: CARLA_ACTIVE.name,
        departmentRaw: CARLA_ACTIVE.departmentRaw,
        rawOffDate: null,
        rawReason: null,
      }),
      observation({
        matchedColumn: 'Personal Email',
        workEmail: CARLATH_RESIGNED.workEmail,
        personalEmail: SHARED_GMAIL,
        name: CARLATH_RESIGNED.name,
        departmentRaw: CARLATH_RESIGNED.departmentRaw,
        rawOffDate: '2026-06-03',
        rawReason: 'resigned',
      }),
    ],
    // fetchGmlStatusMap's polarity: the UNSTAMPED carla@ row marks both carla@
    // and the shared gmail ACTIVE; carlath@ is the only stamped identity.
    gmlStatus: new Map([
      ['carla@simple.biz', { active: true }],
      [SHARED_GMAIL, { active: true }],
      ['carlath@simple.biz', { active: false }],
    ]),
    gmlStatusError: null,
    now: NOW,
  });

  assert.equal(candidates.length, 2, 'a personal email is a SET of identities, never one');

  const carla = candidates.find((c) => c.workEmail === 'carla@simple.biz');
  const carlath = candidates.find((c) => c.workEmail === 'carlath@simple.biz');
  assert.ok(carla);
  assert.ok(carlath);

  assert.equal(carla.active, true);
  assert.equal(carla.blockedCode, 'still_active');
  assert.equal(carla.offDate, null, 'the active identity must not inherit a departure date');

  assert.equal(carlath.active, false);
  assert.equal(carlath.blockedCode, null);
  assert.equal(carlath.offDate, '2026-06-03');
  assert.equal(carlath.reasonLabel, 'Resigned');
});

test('cross-wire: resolving the ACTIVE half is blocked even when handed the other half\'s evidence', () => {
  // This is the failure being prevented: under `loadOffboardEvidenceByEmail('all')`
  // carla@ picks up carlath@'s resigned stamp through the shared gmail. The
  // still_active arm sits BEFORE evidence resolution precisely so that a
  // cross-wired stamp can never become a letter.
  const result = arbitrateTerminationFacts(
    arbInput({
      workEmail: 'carla@simple.biz',
      masterRows: [CARLA_ACTIVE],
      gmlActive: true,
      evidence: { offDate: '2026-06-03', reason: 'resigned' },
    }),
  );

  assert.equal(result.facts, null);
  assert.equal(result.blocked?.code, 'still_active');
});

test('cross-wire: resolving the STAMPED half produces facts', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      workEmail: 'carlath@simple.biz',
      masterRows: [CARLATH_RESIGNED],
      gmlActive: false,
      evidence: { offDate: '2026-06-03', reason: 'resigned' },
    }),
  );

  assert.equal(result.blocked, null);
  assert.ok(result.facts);
  assert.equal(result.facts.identity.workEmail, 'carlath@simple.biz');
  assert.equal(result.facts.identity.personalEmail, SHARED_GMAIL);
  assert.equal(result.facts.identity.masterRowId, 'gml-carlath');
  assert.equal(result.facts.workerName, 'Carla Thomas', 'nickname dropped, no comma survives');
  assert.equal(result.facts.terminationDate, '2026-06-03');
  assert.equal(result.facts.terminationDateLabel, 'June 3, 2026');
  assert.equal(result.facts.reasonKey, 'resigned');
  assert.equal(result.facts.endingDepartmentLabel, 'Accounting');
  assert.equal(result.facts.startDate, '2023-05-02');
  // The rates are resolved outside the pure core, so both are blank here — and
  // both must therefore be listed as blanks.
  assert.deepEqual(result.facts.blanks, ['starting_rate', 'ending_rate']);
});

// ─── G2: temporary_pause, every spelling ─────────────────────────────────────

const PAUSE_SPELLINGS = [
  'temporary_pause',
  'Temporary Pause',
  'TEMPORARY_PAUSE',
  ' temporary-pause ',
  'Temporary  Pause',
];

for (const spelling of PAUSE_SPELLINGS) {
  test(`G2: "${spelling}" normalizes to temporary_pause and is not a departure reason`, () => {
    assert.equal(reasonKey(spelling), 'temporary_pause');
    assert.equal(isTerminationDepartureReason(reasonKey(spelling)), false);
  });

  test(`G2: "${spelling}" is BLOCKED before any rate read or render`, () => {
    const result = arbitrateTerminationFacts(
      arbInput({
        masterRows: [masterRow({ offBoardedReason: spelling })],
        evidence: { offDate: '2026-06-03', reason: spelling },
      }),
    );
    assert.equal(result.facts, null, 'a paused employee must never reach a facts sheet');
    assert.equal(result.rateContext, null, 'and must never reach a rate read');
    assert.equal(result.blocked?.code, 'temporary_pause');
  });
}

test('G2 negative control: "resigned" produces facts, so the pause tests cannot pass by blocking everything', () => {
  const result = arbitrateTerminationFacts(arbInput());
  assert.equal(result.blocked, null);
  assert.equal(result.facts?.reasonKey, 'resigned');
  assert.equal(result.facts?.reasonLabel, 'Resigned');
  assert.ok(result.rateContext, 'a real departure DOES reach the rate read');
});

test('a reason outside the seven-value allowlist is not_a_departure, not a blank', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [masterRow({ offBoardedReason: 'duplicate_cleanup' })],
      evidence: { offDate: '2026-06-03', reason: 'duplicate_cleanup' },
    }),
  );
  assert.equal(result.blocked?.code, 'not_a_departure');
  assert.equal(
    result.blocked?.code === 'not_a_departure' ? result.blocked.rawReason : null,
    'duplicate_cleanup',
  );
});

// ─── G3: who counts as still working ─────────────────────────────────────────

/** jan@simple.biz: a stamped duplicate row carrying an ALLOWLISTED departure
 *  reason — the shape that clears T2 outright — beside a live unstamped row,
 *  while she is working normally. The reason is allowlisted ON PURPOSE: with a
 *  `duplicate_cleanup` stamp T2 would refuse as `not_a_departure` and the
 *  timesheet would never be reached, so the test would no longer be about
 *  hours. */
const JAN_STAMPED = masterRow({
  id: 'gml-jan-dupe',
  name: 'Reyes, Jan',
  workEmail: 'jan@simple.biz',
  offBoardedAtRaw: '2026-05-01',
  offBoardedReason: 'resigned',
});
const JAN_LIVE = masterRow({
  id: 'gml-jan-live',
  name: 'Reyes, Jan',
  workEmail: 'jan@simple.biz',
  offBoardedAtRaw: null,
  offBoardedReason: null,
});

test('G3: one stamped duplicate row + one unstamped row = STILL ACTIVE', () => {
  // jan@ is at work: the cycle timesheet has her, which is the one signal a
  // stale stamp cannot forge (the shipped precedent's guard 4,
  // catalog-roster-visibility.ts:111-116). A `rows.find(r => r.off_boarded_at)`
  // first-match check would declare this person terminated.
  const result = arbitrateTerminationFacts(
    arbInput({
      workEmail: 'jan@simple.biz',
      masterRows: [JAN_STAMPED, JAN_LIVE],
      gmlActive: true,
      cycleHours: HOURS_HIT,
      evidence: { offDate: '2026-05-01', reason: 'resigned' },
    }),
  );

  assert.equal(result.facts, null);
  assert.equal(result.blocked?.code, 'still_active');
  assert.match(String(result.blocked?.message), /timesheet/);
});

test('G3: hours in the current cycle refuse even a PERFECT departure record', () => {
  // A re-hire whose master Start Date never moved (Sherwin Santos, Kevin Cosico
  // — memory `readiness-bank-offboard-aging`; 18 such people logged hours in the
  // Aug 9-15 file while carrying evidence that clears every date guard). The
  // stamps say resigned, the timesheet says otherwise, and the timesheet wins.
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [masterRow({ offBoardedAtRaw: '2026-06-03', offBoardedReason: 'resigned' })],
      cycleHours: HOURS_HIT,
    }),
  );
  assert.equal(result.facts, null);
  assert.equal(result.rateContext, null, 'and it never reaches a rate read');
  assert.equal(result.blocked?.code, 'still_active');
});

test('G3: an unstamped duplicate row does NOT refuse a person whose departure IS stamped', () => {
  // THE COMMON SHAPE, and the reason the naive polarity is dangerous: HR keeps a
  // leaver on the master sheet through final pay and the off-board stamp lands
  // on a DUPLICATE row. Measured 2026-08-21 (offboard-evidence.ts:8-11): 1,287
  // active rows, ZERO carrying off_boarded_at, while 294 of those people ARE
  // offboarded. `fetchGmlStatusMap` therefore reports ACTIVE for a fully
  // processed leaver, and refusing on that alone makes the refusal the common
  // path — which is exactly what trains a rep to distrust it, and what pushes
  // them to have a live roster row hand-stamped to satisfy a document.
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({
          id: 'gml-leaver-stamped',
          offBoardedAtRaw: '2026-06-03',
          offBoardedReason: 'resigned',
          uploadId: '9',
          uploadSeq: 9,
        }),
        masterRow({ id: 'gml-leaver-live', offBoardedAtRaw: null, offBoardedReason: null }),
      ],
      // The status map's own verdict for this person, unstamped row and all.
      gmlActive: true,
      cycleHours: HOURS_MISS,
    }),
  );

  assert.equal(result.blocked, null, 'a processed leaver must not be refused as ACTIVE');
  assert.equal(result.facts?.terminationDate, '2026-06-03');
  assert.equal(result.facts?.reasonKey, 'resigned');
});

test('G3: the same shape WITH cycle hours is still refused', () => {
  // The negative control for the test above: the only thing that changed is the
  // timesheet, so the permissive arm cannot be passing by accident.
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({
          id: 'gml-leaver-stamped',
          offBoardedAtRaw: '2026-06-03',
          offBoardedReason: 'resigned',
          uploadId: '9',
          uploadSeq: 9,
        }),
        masterRow({ id: 'gml-leaver-live', offBoardedAtRaw: null, offBoardedReason: null }),
      ],
      gmlActive: true,
      cycleHours: HOURS_HIT,
    }),
  );
  assert.equal(result.blocked?.code, 'still_active');
});

test('G3: a live current-upload row with NOTHING recording a departure is refused, and names the row', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [masterRow({ id: 'gml-live-1', offBoardedAtRaw: null, offBoardedReason: null })],
      gmlActive: true,
      evidence: null,
    }),
  );
  assert.equal(result.facts, null);
  assert.equal(result.blocked?.code, 'still_active');
  // Minor-1's fix: "somebody is unstamped somewhere" is not something a rep can
  // hand to HR. The refusal names the row and its upload.
  assert.match(String(result.blocked?.message), /gml-live-1/);
  assert.match(String(result.blocked?.message), /upload 412/);
});

test('G3 FAILS CLOSED: a failed status-map read BLOCKS, it never reads as "not active"', () => {
  // The blocker this test exists for. `fetchGmlStatusMap()` pages
  // `global_master_list` with `.range()` and no `.order()`, and returns
  // `{map: new Map(), error}` on any PostgREST error — a statement timeout on a
  // multi-thousand-row scan is the realistic one. The old code turned that into
  // `gmlActive: false` and carried on: an actively-employed person carrying one
  // unstamped row plus a stamped duplicate whose reason is allowlisted (a
  // pre-rehire `resigned`, or a leaver's stamp on the wrong duplicate —
  // memory `rehire-invisible-offboard-reuse`) walked the whole ladder and got a
  // signed letter, with the rep's only signal an amber degraded note.
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({
          id: 'gml-dupe-stamped',
          offBoardedAtRaw: '2026-06-03',
          offBoardedReason: 'resigned',
          uploadId: '9',
          uploadSeq: 9,
        }),
        masterRow({ id: 'gml-live', offBoardedAtRaw: null, offBoardedReason: null }),
      ],
      gmlActive: false,
      gmlStatusError: 'canceling statement due to statement timeout',
      readsDegraded: true,
      degraded: ['global_master_list status map: canceling statement due to statement timeout'],
    }),
  );

  assert.equal(result.facts, null, 'a facts sheet is not an acceptable answer to "we do not know"');
  assert.equal(result.rateContext, null);
  assert.equal(result.blocked?.code, 'evidence_read_failed');
  assert.match(String(result.blocked?.message), /active-roster check/);
});

test('G3 FAILS CLOSED: an unreadable cycle timesheet BLOCKS', () => {
  // The hours read is the unforgeable half of the test, so losing it is losing
  // the guard — not a licence to assume nobody worked.
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [masterRow({ offBoardedAtRaw: '2026-06-03', offBoardedReason: 'resigned' })],
      cycleHours: HOURS_UNREADABLE,
      readsDegraded: true,
      degraded: ['cycle timesheet: No Hubstaff upload to build the cycle hours index from'],
    }),
  );
  assert.equal(result.facts, null);
  assert.equal(result.blocked?.code, 'evidence_read_failed');
  assert.match(String(result.blocked?.message), /timesheet could not be read/);
});

test('G3: a failed status-map read greys EVERY search candidate instead of offering it', () => {
  const candidates = buildTerminationCandidates({
    observations: [observation()],
    gmlStatus: new Map(),
    gmlStatusError: 'canceling statement due to statement timeout',
    now: NOW,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].blockedCode, 'evidence_read_failed');
});

test('G3: a search candidate with a stamped departure is offered even when the map says ACTIVE', () => {
  // Mirror of the arbitration fix: the list must not grey out the 294 people who
  // are offboarded while still holding an unstamped master row. The
  // authoritative call is `resolveTerminationFacts`, which reads the timesheet.
  const candidates = buildTerminationCandidates({
    observations: [observation({ rawOffDate: '2026-06-03', rawReason: 'resigned' })],
    gmlStatus: new Map([['jane@simple.biz', { active: true }]]),
    gmlStatusError: null,
    now: NOW,
  });
  assert.equal(candidates[0].active, true, 'the roster flag is still reported honestly');
  assert.equal(candidates[0].blockedCode, null);
});

test('G3: a search candidate with NO departure record and an ACTIVE flag stays greyed', () => {
  const candidates = buildTerminationCandidates({
    observations: [observation({ rawOffDate: null, rawReason: null })],
    gmlStatus: new Map([['jane@simple.biz', { active: true }]]),
    gmlStatusError: null,
    now: NOW,
  });
  assert.equal(candidates[0].blockedCode, 'still_active');
});

test('G3 control: the same two rows with NO active row fall through to the reason check', () => {
  // Proves the previous test is driven by the active flag and not by the
  // duplicate reason — with gmlActive false the ladder reaches not_a_departure.
  const result = arbitrateTerminationFacts(
    arbInput({
      workEmail: 'jan@simple.biz',
      masterRows: [
        masterRow({
          id: 'gml-jan-dupe',
          name: 'Reyes, Jan',
          workEmail: 'jan@simple.biz',
          offBoardedAtRaw: '2026-05-01',
          offBoardedReason: 'duplicate_cleanup',
        }),
      ],
      gmlActive: false,
      evidence: { offDate: '2026-05-01', reason: 'duplicate_cleanup' },
    }),
  );
  assert.equal(result.blocked?.code, 'not_a_departure');
});

// ─── G4: the re-hire guard ───────────────────────────────────────────────────

test('G4: an offboard stamp on or before the start date is a RE-HIRE, not a departure', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [masterRow({ startDateRaw: '2026-07-01', offBoardedAtRaw: '2026-06-15' })],
      evidence: { offDate: '2026-06-15', reason: 'resigned' },
    }),
  );

  assert.equal(result.facts, null);
  assert.equal(result.blocked?.code, 'rehire_after_offboard');
  if (result.blocked?.code === 'rehire_after_offboard') {
    assert.equal(result.blocked.offDate, '2026-06-15');
    assert.equal(result.blocked.startDate, '2026-07-01');
  }
});

test('G4 negative control: an offboard stamp AFTER the start date produces facts', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [masterRow({ startDateRaw: '2026-07-01', offBoardedAtRaw: '2026-08-01' })],
      evidence: { offDate: '2026-08-01', reason: 'resigned' },
    }),
  );

  assert.equal(result.blocked, null);
  assert.equal(result.facts?.terminationDate, '2026-08-01');
  assert.equal(result.facts?.startDate, '2026-07-01');
});

test('G4: an offboard stamp EQUAL to the start date is refused (the boundary is <=)', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [masterRow({ startDateRaw: '2026-07-01', offBoardedAtRaw: '2026-07-01' })],
      evidence: { offDate: '2026-07-01', reason: 'resigned' },
    }),
  );
  assert.equal(result.blocked?.code, 'rehire_after_offboard');
});

// ─── G5: no impossible date on a signed page ─────────────────────────────────

/** The mandated pipeline, in the mandated order. */
const resolveDay = (raw: string | null) => sanitizeOffboardDay(normalizeMasterDate(raw), NOW);

test('G5: sanitize AFTER normalize — and the reverse order silently loses the date', () => {
  assert.equal(resolveDay('5/4/2026'), '2026-05-04', 'M/D/YYYY parsed BY PARTS, not by new Date');
  assert.equal(
    sanitizeOffboardDay('5/4/2026', NOW),
    null,
    'sanitize only accepts an ISO-prefixed string, so the order is load-bearing',
  );
});

test('G5: a future date is nulled, never printed', () => {
  // franm@simple.biz's real offboarded_sheet row: a hand-typed year typo that
  // kept her on every offboarded surface for months.
  assert.equal(resolveDay('2027-04-20'), null);
});

for (const junk of ['13/45/25', 'n/a', 'TBD', '', '   ']) {
  test(`G5: ${JSON.stringify(junk)} resolves to null, not a guess`, () => {
    assert.equal(resolveDay(junk), null);
  });
}

test('G5: a stamped-but-impossible date becomes a BLANK with date_failed_sanity', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [masterRow({ offBoardedAtRaw: '2027-04-20' })],
      // loadOffboardEvidenceByEmail normalizes but does NOT sanitize
      // (offboard-evidence.ts:81) — this is exactly how the typo rides through.
      evidence: { offDate: '2027-04-20', reason: 'resigned' },
    }),
  );

  assert.equal(result.blocked, null, 'an impossible date is a blank to fill, not a refusal');
  assert.equal(result.facts?.terminationDate, null);
  assert.equal(result.facts?.terminationDateLabel, null);
  assert.ok(result.facts?.blanks.includes('termination_date'));
  assert.equal(result.blankReasons?.termination_date, 'date_failed_sanity');
});

test('G5: an unparseable start date is a blank, and cannot fire a bogus re-hire refusal', () => {
  const result = arbitrateTerminationFacts(
    arbInput({ masterRows: [masterRow({ startDateRaw: 'TBD' })] }),
  );

  assert.equal(result.blocked, null);
  assert.equal(result.facts?.startDate, null);
  assert.ok(result.facts?.blanks.includes('start_date'));
  assert.equal(result.blankReasons?.start_date, 'date_failed_sanity');
});

// ─── The remaining refusal arms ──────────────────────────────────────────────

test('no_master: zero master rows refuses before anything else is consulted', () => {
  const result = arbitrateTerminationFacts(
    arbInput({ masterRows: [], gmlActive: true, evidence: null }),
  );
  assert.equal(result.blocked?.code, 'no_master');
});

test('no_departure_evidence: nothing stamps this person as having left', () => {
  // OFF the current upload and not flagged active, so the still_active arm above
  // has nothing to say: this is the person the roster has dropped and no source
  // ever stamped. (A person in this shape who IS on the live upload is
  // `still_active` instead — see the G3 section.)
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({ offBoardedAtRaw: null, offBoardedReason: null, uploadId: '9', uploadSeq: 9 }),
      ],
      gmlActive: false,
      evidence: null,
    }),
  );
  assert.equal(result.blocked?.code, 'no_departure_evidence');
});

test('evidence_read_failed: a broken read is NOT "never left"', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({ offBoardedAtRaw: null, offBoardedReason: null, uploadId: '9', uploadSeq: 9 }),
      ],
      gmlActive: false,
      evidence: null,
      readsDegraded: true,
      degraded: ['offboarded_sheet: boom'],
    }),
  );
  assert.equal(result.blocked?.code, 'evidence_read_failed');
});

test('bad_name: an @-address parked in the Name column is refused, not printed', () => {
  // parseNameParts returns an '@'-address whole in `first` (name-parts.ts:163)
  // and it passes the COE's comma/quote guard. This clause is the addition.
  const result = arbitrateTerminationFacts(
    arbInput({ masterRows: [masterRow({ name: 'jasminec@simple.biz' })] }),
  );
  assert.equal(result.facts, null);
  assert.equal(result.blocked?.code, 'bad_name');
});

test('bad_name: a blank Name column is refused', () => {
  const result = arbitrateTerminationFacts(arbInput({ masterRows: [masterRow({ name: null })] }));
  assert.equal(result.blocked?.code, 'bad_name');
});

test('ambiguous_identity: two equally current rows naming different people is never auto-picked', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({ id: 'gml-a', name: 'Doe, Jane' }),
        masterRow({ id: 'gml-b', name: 'Cruz, Maria' }),
      ],
    }),
  );
  assert.equal(result.facts, null);
  assert.equal(result.blocked?.code, 'ambiguous_identity');
  if (result.blocked?.code === 'ambiguous_identity') {
    const rows = [...result.blocked.candidates].sort((a, z) => a.rowId.localeCompare(z.rowId));
    assert.deepEqual(
      rows.map((r) => r.rowId),
      ['gml-a', 'gml-b'],
      'every row in the winning tier is offered — none is dropped or auto-picked',
    );
    // Risk 7's ruling is that the REP adjudicates "from a candidate list showing
    // dept / off-date / reason / active-flag", so every row must CARRY those.
    // A list of bare uuids is not adjudicable: it is not searchable, and every
    // row here shares the one work email, so there is no second address to try.
    assert.deepEqual(
      rows.map((r) => r.name),
      ['Doe, Jane', 'Cruz, Maria'],
    );
    for (const r of rows) {
      assert.equal(r.workEmail, 'jane@simple.biz', 'the identity is the shared WORK email');
      assert.equal(r.departmentLabel, 'Accounting');
      assert.equal(r.offDate, '2026-06-03');
      assert.equal(r.reasonLabel, 'Resigned');
      assert.equal(r.active, false, 'both rows carry an off-board stamp');
    }
  }
});

test('ambiguous_identity: the candidate list flags WHICH row is unstamped', () => {
  // Ambiguity (step 2) is refused before still_active (step 3), so an unstamped
  // row inside the winning tier still lands here — and it is the row the rep has
  // to explain to HR, so the list has to point at it.
  const result = arbitrateTerminationFacts(
    arbInput({
      gmlActive: true,
      masterRows: [
        masterRow({ id: 'gml-a', name: 'Doe, Jane' }),
        masterRow({
          id: 'gml-b',
          name: 'Cruz, Maria',
          departmentRaw: 'hsl:intake_specialist',
          offBoardedAtRaw: null,
          offBoardedReason: null,
        }),
      ],
    }),
  );
  assert.equal(result.blocked?.code, 'ambiguous_identity');
  if (result.blocked?.code === 'ambiguous_identity') {
    const byId = new Map(result.blocked.candidates.map((c) => [c.rowId, c] as const));
    assert.equal(byId.get('gml-a')?.active, false);
    assert.equal(byId.get('gml-b')?.active, true, 'the unstamped row is the ACTIVE-looking one');
    assert.equal(byId.get('gml-b')?.offDate, null);
    assert.equal(byId.get('gml-b')?.reasonLabel, null);
    // G6 holds inside a refusal too: the raw `hsl:` key never reaches a human.
    assert.equal(byId.get('gml-b')?.departmentLabel?.startsWith('hsl:'), false);
    assert.ok(byId.get('gml-b')?.departmentLabel?.startsWith('HSL'));
  }
});

test('the ambiguous-identity refusal never prints a raw master-row uuid in the UI', () => {
  // The panel used to list `global_master_list` uuids and tell the rep to
  // "search one of these work emails directly" — an instruction that cannot be
  // followed: a uuid matches no email column, and every row in the tier shares
  // ONE work email. The row ids stay on the server payload for the audit trail;
  // the panel renders the readable columns instead.
  const panel = fs.readFileSync(
    path.join(
      process.cwd(),
      'src',
      'components',
      'accounting',
      'termination-docs',
      'TerminationDocsPanel.tsx',
    ),
    'utf8',
  );
  assert.equal(
    panel.includes('rowId'),
    false,
    'TerminationDocsPanel must not reference candidate.rowId — a raw uuid is not something a rep can read, search or act on',
  );
});

test('ordinary duplicate drift is NOT ambiguous — the promotion order picks', () => {
  // Same person, two rows, different departments. The row on the current upload
  // describes who the person is; refusing here would refuse the commonest shape
  // in the table.
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({ id: 'gml-old', departmentRaw: 'Sales', uploadId: '9', uploadSeq: 9 }),
        masterRow({ id: 'gml-new', departmentRaw: 'Lead Gen' }),
      ],
    }),
  );
  assert.equal(result.blocked, null);
  assert.equal(result.facts?.identity.masterRowId, 'gml-new');
  assert.equal(result.facts?.identity.onCurrentUpload, true);
  assert.equal(result.facts?.endingDepartmentLabel, 'Lead Gen');
  assert.deepEqual(result.facts?.identity.candidateRowIds, ['gml-new', 'gml-old']);
});

// ─── G6: no raw hsl:* slug ever reaches a human-readable field ───────────────

test('G6: the raw hsl:* cell is kept for audit and only the LABEL is printable', () => {
  const result = arbitrateTerminationFacts(
    arbInput({ masterRows: [masterRow({ departmentRaw: 'hsl:intake_specialist' })] }),
  );
  assert.equal(result.facts?.endingDepartmentRaw, 'hsl:intake_specialist');
  assert.ok(result.facts?.endingDepartmentLabel);
  assert.equal(result.facts?.endingDepartmentLabel?.startsWith('hsl:'), false);
  assert.ok(result.facts?.endingDepartmentLabel?.startsWith('HSL'));
});

// ─── G1, at the source level ─────────────────────────────────────────────────

test('G1/T1: the departure-evidence read is this feature\'s OWN, and WORK-keyed', () => {
  // TWO rules in one gate, and the first REPLACED the second.
  //
  // 1. `loadOffboardEvidenceByEmail` may not be called here AT ALL. Every one of
  //    its three source reads ends in `.catch(() => {})` and it returns a bare
  //    Map with no error field (offboard-evidence.ts:123,:136,:155), so a source
  //    that timed out is indistinguishable from a source that had nothing. T1
  //    requires a departure-evidence read that FAILS CLOSED, and that read
  //    cannot be built on a helper which is structurally unable to report
  //    failure. Should a call site ever come back, it must still pass 'work'.
  // 2. This feature's own read is keyed on the WORK email only. The other three
  //    identity columns on those tables hold PERSONAL addresses, and one inbox
  //    backs several master identities.
  const dir = path.join(process.cwd(), 'src', 'lib', 'documents', 'termination');
  // Implementation files only — a test file and a comment both quote the call
  // in prose, and neither is a call site.
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  let calls = 0;
  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const line of src.split('\n')) {
      const at = line.indexOf('loadOffboardEvidenceByEmail(');
      if (at < 0) continue;
      const head = line.trimStart();
      // The import statement names it without calling it; comments discuss it.
      if (head.startsWith('import') || head.startsWith('//') || head.startsWith('*')) continue;
      calls += 1;
      assert.match(
        line.slice(at),
        /loadOffboardEvidenceByEmail\('work'\)/,
        `${file}: the keys argument defaults to 'all', which indexes PERSONAL emails and cross-wires shared inboxes — it must be passed explicitly as 'work'`,
      );
    }
  }
  assert.equal(
    calls,
    0,
    'a module here calls loadOffboardEvidenceByEmail, which has NO error channel — T1 needs a departure-evidence read that can report failure',
  );

  const own = fs.readFileSync(path.join(dir, 'termination-evidence.ts'), 'utf8');
  const code = own.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /\.ilike\('work_email', pat\)/, 'the offboarded_sheet read is not work-keyed');
  assert.match(
    code,
    /\.ilike\('employee_work_email', pat\)/,
    'the offboarding_queue read is not work-keyed',
  );
  for (const forbidden of ['personal_email', 'employee_email']) {
    assert.equal(
      code.includes(forbidden),
      false,
      `termination-evidence.ts touches ${forbidden} — a personal address SEARCHES, it never sources a departure`,
    );
  }
  assert.match(code, /error: errors\.length \? errors\.join/, 'the read lost its error channel');
});

// ─── G1: a printed money fact never comes from a personal address ────────────

test('G1: the rate context carries WORK addresses only — never the personal inbox', () => {
  // The breach this closes: `rateContext.aliases` used to include the master
  // row's personal email, and `resolveTerminationRates` queried the hire record
  // on every alias. `carlathomas0112@gmail.com` backs BOTH carla@ (active) and
  // carlath@ (resigned), so carlath@'s letter could print carla@'s hire rate as
  // the STARTING RATE — on the signed page, and permanently on the log row.
  const result = arbitrateTerminationFacts(
    arbInput({
      workEmail: 'carlath@simple.biz',
      masterRows: [
        masterRow({
          id: 'gml-carlath',
          name: 'Thomas, Carla',
          workEmail: 'carlath@simple.biz',
          personalEmail: SHARED_GMAIL,
          alternateWorkEmail: 'carla.thomas@simple.biz',
          // A personal address parked in an alternate-WORK cell is a data-entry
          // shape that occurs; it is still not a rate key.
          alternateWorkEmail2: SHARED_GMAIL,
          startDateRaw: '2023-05-02',
          offBoardedAtRaw: '2026-06-03',
          offBoardedReason: 'resigned',
        }),
      ],
    }),
  );

  assert.equal(result.blocked, null);
  assert.deepEqual(result.rateContext?.workAliases, [
    'carlath@simple.biz',
    'carla.thomas@simple.biz',
  ]);
  // The personal address survives for the log row and for SEARCH, where nothing
  // prints it — that is the whole of G1: personal email SEARCHES, work email
  // IDENTIFIES.
  assert.equal(result.facts?.identity.personalEmail, SHARED_GMAIL);
});

test('G1: workAliasesForRateContext drops an address any master row calls personal', () => {
  const rows = [
    masterRow({
      id: 'gml-new',
      workEmail: 'carlath@simple.biz',
      personalEmail: null,
      alternateWorkEmail: SHARED_GMAIL,
      alternateWorkEmail2: null,
    }),
    // The OTHER row is the one that knows this address is a personal inbox.
    masterRow({
      id: 'gml-old',
      workEmail: 'carlath@simple.biz',
      personalEmail: SHARED_GMAIL,
      uploadId: '9',
      uploadSeq: 9,
    }),
  ];
  assert.deepEqual(workAliasesForRateContext('carlath@simple.biz', rows), ['carlath@simple.biz']);
});

test('G1: the work email itself is never dropped, even if a row files it as personal', () => {
  // A mis-filed cell must not leave the rate resolver with an EMPTY identity.
  const rows = [masterRow({ workEmail: 'jane@simple.biz', personalEmail: 'jane@simple.biz' })];
  assert.deepEqual(workAliasesForRateContext('jane@simple.biz', rows), ['jane@simple.biz']);
});

test('G1: termination-rates.ts names no personal-address column at all', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'documents', 'termination', 'termination-rates.ts'),
    'utf8',
  );
  assert.equal(
    src.includes('personal_email'),
    false,
    'a rate is a printed money fact; no carrier may be matched on a personal address (G1)',
  );
  assert.equal(
    src.includes('args.aliases'),
    false,
    'the rate args field is `workAliases` — a name that cannot quietly acquire a personal address',
  );
});

// ─── G5: a fabricated calendar day is a BLANK, never a printed fact ──────────

/** Cells `normalizeMasterDate` resolves ONLY by inventing a part the cell never
 *  stated. Each one used to print as a precise day on a signed letter, and the
 *  rep could not correct it because a non-null fact is not a blank. */
const FABRICATED_DATES: Array<[string, string]> = [
  ['Aug-24', 'no year stated — the parser invents 2001'],
  ['Aug 18', 'no year stated'],
  ['August 2026', 'no day-of-month stated — the parser invents the 1st'],
  ['August 2024', 'no day-of-month stated'],
  ['2024 August', 'no day-of-month stated'],
  ['March2024', 'no day-of-month stated'],
  ['Jan 2020', 'no day-of-month stated'],
  ['2024?', 'neither a month nor a day stated'],
  ['2026', 'a bare year'],
  ['0', 'not a date at all — the parser invents 2000-01-01'],
];

for (const [raw, why] of FABRICATED_DATES) {
  test(`G5: ${JSON.stringify(raw)} is a BLANK, not a fabricated day (${why})`, () => {
    assert.equal(explicitMasterDay(raw, NOW), null);
    // And prove the fabrication is real, so this test cannot pass because the
    // underlying parser merely refused.
    assert.notEqual(
      normalizeMasterDate(raw),
      null,
      'normalizeMasterDate DOES resolve this cell — that is the hazard being closed',
    );
  });
}

/** Days that do not exist. `new Date` ROLLS them forward instead of refusing, so
 *  `formatCoeStartDate('2026-02-31')` prints "March 2, 2026" and a `date` column
 *  answers with an opaque out-of-range error after the PDF was uploaded. */
const IMPOSSIBLE_DAYS = [
  'Feb 30 2026',
  '2/29/2025',
  '2/30/2026',
  '4/31/2026',
  '2026-02-31',
  '2026-04-31',
  '2026-13-05',
];

for (const raw of IMPOSSIBLE_DAYS) {
  test(`G5: ${JSON.stringify(raw)} names no real calendar day, so it is refused not rolled`, () => {
    assert.equal(explicitMasterDay(raw, NOW), null);
  });
}

test('G5: isRealCalendarDay accepts real days and refuses rolled ones', () => {
  assert.equal(isRealCalendarDay('2024-02-29'), true, 'a leap day is a real day');
  assert.equal(isRealCalendarDay('2026-08-31'), true);
  assert.equal(isRealCalendarDay('2025-02-29'), false);
  assert.equal(isRealCalendarDay('2026-02-31'), false);
  assert.equal(isRealCalendarDay('2026-13-05'), false);
  assert.equal(isRealCalendarDay('2026-00-10'), false);
  assert.equal(isRealCalendarDay('2026-06-00'), false);
  assert.equal(isRealCalendarDay(null), false);
  assert.equal(isRealCalendarDay('2026-06-03T00:00:00Z'), false, 'shape is exact, not a prefix');
});

test('G5: the shapes a sheet really holds still resolve', () => {
  // The gate is a positive check, not a narrowing of the accepted formats: every
  // shape master-date.ts documents still lands, so this cannot pass by blanking
  // everything.
  assert.equal(explicitMasterDay('2026-06-03', NOW), '2026-06-03');
  assert.equal(explicitMasterDay('2026-06-03T12:00:00Z', NOW), '2026-06-03');
  assert.equal(explicitMasterDay('5/4/2026', NOW), '2026-05-04');
  assert.equal(explicitMasterDay('12/31/24', NOW), '2024-12-31');
  assert.equal(explicitMasterDay('July 20, 2026', NOW), '2026-07-20');
  assert.equal(explicitMasterDay('20 July 2026', NOW), '2026-07-20');
  assert.equal(explicitMasterDay('Sept 5 2025', NOW), '2025-09-05');
  assert.equal(explicitMasterDay('Feb 29 2024', NOW), '2024-02-29');
  assert.equal(explicitMasterDay('2027-04-20', NOW), null, 'the future is still nulled');
});

test('G5: a partial OFFBOARD date becomes a blank instead of printing a precise day', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [masterRow({ offBoardedAtRaw: 'August 2026', offBoardedReason: 'resigned' })],
      evidence: { offDate: 'August 2026', reason: 'resigned' },
    }),
  );
  assert.equal(result.blocked, null, 'a partial date is a question for the rep, not a refusal');
  assert.equal(result.facts?.terminationDate, null);
  assert.equal(result.facts?.terminationDateLabel, null);
  assert.ok(result.facts?.blanks.includes('termination_date'));
  assert.equal(result.blankReasons?.termination_date, 'date_failed_sanity');
});

test('G5: an impossible OFFBOARD date becomes a blank instead of rolling into next month', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [masterRow({ offBoardedAtRaw: 'Feb 30 2026', offBoardedReason: 'resigned' })],
      evidence: { offDate: 'Feb 30 2026', reason: 'resigned' },
    }),
  );
  assert.equal(result.facts?.terminationDate, null, 'never "2026-03-02"');
  assert.equal(result.facts?.terminationDateLabel, null, 'never "March 2, 2026"');
  assert.equal(result.blankReasons?.termination_date, 'date_failed_sanity');
});

test('G5: a partial START date becomes a blank instead of a 25-year-wrong contract date', () => {
  // "Aug-24" is a plausible spelling of August 2024 and resolved to 2001-08-24,
  // which printed as `Contract start date .......... August 24, 2001`.
  const result = arbitrateTerminationFacts(
    arbInput({ masterRows: [masterRow({ startDateRaw: 'Aug-24' })] }),
  );
  assert.equal(result.blocked, null);
  assert.equal(result.facts?.startDate, null);
  assert.equal(result.facts?.startDateLabel, null);
  assert.ok(result.facts?.blanks.includes('start_date'));
  assert.equal(result.blankReasons?.start_date, 'date_failed_sanity');
});

test('G5: the search candidate list applies the same date gate as the facts sheet', () => {
  const candidates = buildTerminationCandidates({
    observations: [observation({ rawOffDate: 'August 2026', rawReason: 'resigned' })],
    gmlStatus: new Map([['jane@simple.biz', { active: false }]]),
    gmlStatusError: null,
    now: NOW,
  });
  assert.equal(candidates[0].offDate, null, 'a list must never show a day the letter would refuse');
});

test('G5: termination-log pairs every date shape check with a calendar-validity check', () => {
  // The log is the last gate before the INSERT, and the shape regex alone lets
  // 2026-02-31 through to a `date` column that answers with an opaque
  // out-of-range error only AFTER the storage object was uploaded.
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'documents', 'termination', 'termination-log.ts'),
    'utf8',
  );
  assert.match(src, /isRealCalendarDay\(facts\.terminationDate\)/);
  assert.match(src, /isRealCalendarDay\(facts\.startDate\)/);
});

// ─── G4: the same-day boundary is a decision, stated in both places ──────────

test('G4: the code refusal and the DDL CHECK state the same rule', () => {
  // `offDate <= startDate` refuses a same-day engagement-and-departure (a day-one
  // NCNS) as a re-hire. That is a KNOWN, ACCEPTED refusal, per the frozen
  // contract — and it is only safe while the database says exactly the same
  // thing. Narrowing one side alone lets the app produce a row the CHECK then
  // rejects, or lets a row land the app would never issue.
  const dir = path.join(process.cwd(), 'src', 'lib', 'documents', 'termination');
  const arb = fs.readFileSync(path.join(dir, 'termination-arbitration.ts'), 'utf8');
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'references', 'sql', 'migrate', '2026-08-31_termination_docs.sql'),
    'utf8',
  );
  assert.match(arb, /terminationDate <= startDate/);
  assert.match(sql, /termination_date\s*>\s*start_date/);
  assert.match(arb, /KNOWN, ACCEPTED REFUSAL/, 'and the acceptance is written down, not inferred');
});

// ─── The settled G3 rule: T1 reads · T2 record · T3 re-hire · T4 hours ───────
// The four tests are INDEPENDENT — reaching a facts sheet means passing all
// four — and the section below exercises each one on its own, plus the argument
// that makes an absent hours signal survivable.

test('G3/T1: a failed MASTER read blocks — it can never become "no master row"', () => {
  // `no_master` is a statement about the table. A read that errored has not made
  // one, and the row set it hands back is not the row set: `selectAllPaged`
  // returns whatever pages arrived BEFORE the failure, so an empty array and a
  // one-row array are equally untrustworthy here.
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [],
      masterReadError: 'canceling statement due to statement timeout',
      readsDegraded: true,
    }),
  );
  assert.equal(result.facts, null);
  assert.equal(result.blocked?.code, 'evidence_read_failed');
  assert.match(String(result.blocked?.message), /master-list read/);
  assert.notEqual(result.blocked?.code, 'no_master');
});

test('G3/T1: a failed DEPARTURE-EVIDENCE read blocks, with its own error channel', () => {
  // The shared `loadOffboardEvidenceByEmail` cannot report this at all — all
  // three of its source reads end in `.catch(() => {})` — which is why the
  // feature does its own read. A source that timed out must not read as "this
  // person never left", and must not silently reduce the evidence a letter is
  // built on either.
  const result = arbitrateTerminationFacts(
    arbInput({
      evidenceReadError: 'offboarded_sheet: canceling statement due to statement timeout',
      readsDegraded: true,
    }),
  );
  assert.equal(result.facts, null);
  assert.equal(result.rateContext, null, 'a failed evidence read still reached a rate read');
  assert.equal(result.blocked?.code, 'evidence_read_failed');
  assert.match(String(result.blocked?.message), /departure-evidence read/);
});

test('G3/T3: a master row starting AFTER the departure is a RE-ENGAGEMENT, not a leaver', () => {
  // THE GUARD THAT REPLACES THE ROSTER-SIGNAL ARGUMENT. The winning row is the
  // stamped one (it is on the current upload), so the G4 arm — which compares
  // only the WINNER'S start date — sees 2024-03-04 against a 2026-06-03 stamp
  // and passes. The re-hire's own row, on an older upload, states a start date
  // AFTER the departure. That is the case cycle hours existed to catch, caught
  // without a timesheet.
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({ id: 'gml-stamped', offBoardedAtRaw: '2026-06-03', offBoardedReason: 'resigned' }),
        masterRow({
          id: 'gml-rehire',
          startDateRaw: '2026-07-01',
          offBoardedAtRaw: null,
          offBoardedReason: null,
          uploadId: '9',
          uploadSeq: 9,
        }),
      ],
      // The timesheet cannot help: it read fine and is empty. T3 is the whole
      // guard here, which is exactly the claim being tested.
      cycleHours: HOURS_UNAVAILABLE,
    }),
  );
  assert.equal(result.facts, null, 'a re-engaged employee was handed a facts sheet');
  assert.equal(result.blocked?.code, 'reengaged_after_departure');
  const blocked = result.blocked;
  assert.equal(blocked?.code === 'reengaged_after_departure' ? blocked.offDate : null, '2026-06-03');
  assert.equal(
    blocked?.code === 'reengaged_after_departure' ? blocked.startDate : null,
    '2026-07-01',
  );
  assert.equal(blocked?.code === 'reengaged_after_departure' ? blocked.rowId : null, 'gml-rehire');
  // Both dates and the row are NAMED — "somebody was re-hired" is not something
  // a rep can hand to HR.
  assert.match(String(blocked?.message), /gml-rehire/);
  assert.match(String(blocked?.message), /2026-07-01/);
  assert.match(String(blocked?.message), /2026-06-03/);
});

test('G3/T3: the LATEST re-engagement start date is the one reported', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({ id: 'gml-stamped', offBoardedAtRaw: '2026-06-03', offBoardedReason: 'resigned' }),
        masterRow({ id: 'gml-r1', startDateRaw: '2026-07-01', uploadId: '9', uploadSeq: 9 }),
        masterRow({ id: 'gml-r2', startDateRaw: '2026-08-04', uploadId: '8', uploadSeq: 8 }),
      ],
    }),
  );
  const blocked = result.blocked;
  assert.equal(blocked?.code, 'reengaged_after_departure');
  assert.equal(blocked?.code === 'reengaged_after_departure' ? blocked.rowId : null, 'gml-r2');
});

test('G3/T3: a start date BEFORE the departure is an ordinary leaver, not a re-hire', () => {
  // The negative control. Without it, T3 could be satisfied by refusing every
  // person who carries more than one master row — which is most of the table.
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({ id: 'gml-stamped', offBoardedAtRaw: '2026-06-03', offBoardedReason: 'resigned' }),
        masterRow({ id: 'gml-old', startDateRaw: '2023-02-01', uploadId: '9', uploadSeq: 9 }),
      ],
    }),
  );
  assert.equal(result.blocked, null, result.blocked ? String(result.blocked.message) : '');
  assert.equal(result.facts?.terminationDate, '2026-06-03');
});

test('G3/T3: a row whose start date FAILED SANITY cannot fire a re-hire refusal', () => {
  // `explicitMasterDay` is applied to every row's Start Date before the
  // comparison, so `"August 2026"` — which the parser would invent 2026-08-01
  // for — is a BLANK, not a fabricated re-engagement that strands a real leaver.
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({ id: 'gml-stamped', offBoardedAtRaw: '2026-06-03', offBoardedReason: 'resigned' }),
        masterRow({ id: 'gml-partial', startDateRaw: 'August 2026', uploadId: '9', uploadSeq: 9 }),
      ],
    }),
  );
  assert.equal(result.blocked, null, result.blocked ? String(result.blocked.message) : '');
});

test('G3/T4: an EMPTY timesheet is recorded as UNAVAILABLE, never as "did not work"', () => {
  // The round-2 blocker, at the ladder. An index that read fine and holds no
  // rows cannot answer the question — so the rep is TOLD, on the facts sheet,
  // and the letter rests on T2 + T3. Silence here is what turned an absent
  // signal into a confident negative for the whole roster.
  const result = arbitrateTerminationFacts(arbInput({ cycleHours: HOURS_UNAVAILABLE }));
  assert.equal(result.blocked, null, 'an empty timesheet must not BLOCK an ordinary leaver');
  assert.ok(
    result.facts?.degraded.some((d) => /timesheet is EMPTY/.test(d)),
    'the rep was never told the hours signal was missing',
  );
});

test('G3/T4: a READY timesheet that simply misses this person adds no such note', () => {
  // The negative control for the note: a degraded note on every facts sheet is a
  // note nobody reads.
  const result = arbitrateTerminationFacts(arbInput({ cycleHours: HOURS_MISS }));
  assert.equal(result.blocked, null);
  assert.deepEqual(
    result.facts?.degraded.filter((d) => /timesheet is EMPTY/.test(d)),
    [],
  );
});

test('G3/T4: a hit REFUSES and names what it matched on', () => {
  const result = arbitrateTerminationFacts(
    arbInput({
      cycleHours: { state: 'ready', worked: true, matchedBy: 'the timesheet address jane@other.com' },
    }),
  );
  assert.equal(result.facts, null);
  assert.equal(result.blocked?.code, 'still_active');
  assert.match(String(result.blocked?.message), /jane@other\.com/);
});

test('G3/T4: an UNAVAILABLE timesheet is not a fail-open — T3 still refuses the re-hire', () => {
  // THE ARGUMENT THAT MAKES THE WHOLE DESIGN SAFE, as an executable claim. Cycle
  // hours are only ever used to REFUSE, so an absent signal may never PERMIT a
  // document on its own — and it does not, because the case hours was there to
  // catch (a re-hire) is caught by T3 from the master rows alone.
  const rehireShape = {
    masterRows: [
      masterRow({ id: 'gml-stamped', offBoardedAtRaw: '2026-06-03', offBoardedReason: 'resigned' }),
      masterRow({ id: 'gml-rehire', startDateRaw: '2026-07-01', uploadId: '9', uploadSeq: 9 }),
    ],
  };
  for (const [label, cycleHours] of [
    ['unavailable', HOURS_UNAVAILABLE],
    ['a healthy miss', HOURS_MISS],
  ] as const) {
    const result = arbitrateTerminationFacts(arbInput({ ...rehireShape, cycleHours }));
    assert.equal(
      result.blocked?.code,
      'reengaged_after_departure',
      `with ${label} hours, the re-hire was documented as a departure`,
    );
  }
});

test('G3/T2: an unstamped duplicate row is NOT a refusal once a departure IS recorded', () => {
  // Restated at the settled ladder, because it is the rule most likely to be
  // "fixed" back: 1,287 active rows carry ZERO off_boarded_at while 294 of those
  // people ARE offboarded (offboard-evidence.ts:8-11). Refusing on the unstamped
  // row alone greys out most of this tab's real subjects and pushes the rep to
  // have a live roster row hand-stamped to satisfy a document.
  const result = arbitrateTerminationFacts(
    arbInput({
      masterRows: [
        masterRow({
          id: 'gml-stamped',
          offBoardedAtRaw: '2026-06-03',
          offBoardedReason: 'resigned',
          uploadId: '9',
          uploadSeq: 9,
        }),
        masterRow({ id: 'gml-live', offBoardedAtRaw: null, offBoardedReason: null }),
      ],
      gmlActive: true,
      cycleHours: HOURS_UNAVAILABLE,
    }),
  );
  assert.equal(result.blocked, null, result.blocked ? String(result.blocked.message) : '');
  assert.equal(result.facts?.terminationDate, '2026-06-03');
});
