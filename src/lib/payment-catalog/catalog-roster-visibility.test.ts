import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOffboardedForPaymentCatalog,
  type CatalogVisibilityInput,
} from './catalog-roster-visibility';

/** The cycle in view for every case below: the Aug 9–15 pay week. */
const CYCLE = '2026-08-09';

const input = (over: Partial<CatalogVisibilityInput> = {}): CatalogVisibilityInput => ({
  evidence: { offDate: '2026-07-26', reason: 'resigned' },
  startDate: '2026-07-13',
  cycleWeekStart: CYCLE,
  hasCycleHours: false,
  ...over,
});

test('a real leaver from a past cycle is hidden', () => {
  assert.equal(isOffboardedForPaymentCatalog(input()), true);
});

test('no evidence at all — always shown', () => {
  assert.equal(isOffboardedForPaymentCatalog(input({ evidence: null })), false);
});

test('a zero-hours ACTIVE member is still shown (absence from a money surface is not evidence)', () => {
  // jvincec@'s case: no hours in the current file, no off-board record anywhere.
  assert.equal(
    isOffboardedForPaymentCatalog(input({ evidence: null, hasCycleHours: false })),
    false,
  );
});

// ── Guard 1: the reason must be a canonical DEPARTURE ───────────────────────

test('every canonical departure reason hides', () => {
  for (const reason of ['ncns', 'resigned', 'end_of_contract', 'performance', 'attendance', 'time_manipulation', 'other']) {
    assert.equal(
      isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-07-26', reason } })),
      true,
      `${reason} should hide`,
    );
  }
});

test('reason matching is casing/spacing insensitive — the column is free text', () => {
  // Both shapes are live in the data: `Performance` 107 rows, `performance` 167.
  for (const reason of ['Performance', 'PERFORMANCE', ' performance ', 'NCNS']) {
    assert.equal(
      isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-07-26', reason } })),
      true,
      `${JSON.stringify(reason)} should hide`,
    );
  }
});

test('temporary_pause is kept even when every other condition says hide', () => {
  assert.equal(
    isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-07-26', reason: 'temporary_pause' } })),
    false,
  );
});

test('the sheet label "Temporary Pause" is the same reason and is also kept', () => {
  assert.equal(
    isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-07-26', reason: 'Temporary Pause' } })),
    false,
  );
});

test('duplicate_cleanup is a migration marker, not a departure — kept', () => {
  // jan@simple.biz: 95 master rows, one retired by migration #65 with this
  // reason and a note that says "Reversible". He is working normally.
  assert.equal(
    isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-06-08', reason: 'duplicate_cleanup' } })),
    false,
  );
});

test('sheet_sync is an artifact, not a departure — kept', () => {
  assert.equal(
    isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-06-08', reason: 'sheet_sync' } })),
    false,
  );
});

test('unrecognised sheet-authored labels fail SAFE (allowlist, not denylist)', () => {
  // All live values. None is a departure of someone who is on the active roster,
  // and a denylist would have had to guess at each one.
  for (const reason of [
    'Declined Offer',
    'Reschedule For Next Week',
    'Need to Reschedule',
    'No Show During Orientation',
    'Policy Violation',
    'Withdrawn',
    'Tech Issue',
    'Active',
    'Unable to start due to Emergency',
    '11/25/25 - Last seen 5 months ago',
  ]) {
    assert.equal(
      isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-07-26', reason } })),
      false,
      `${JSON.stringify(reason)} must not hide anyone`,
    );
  }
});

test('an ABSENT reason fails safe — kept', () => {
  assert.equal(isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-07-26', reason: null } })), false);
  assert.equal(isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-07-26', reason: '' } })), false);
  assert.equal(isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-07-26', reason: '   ' } })), false);
});

// ── Guard 2: the re-hire start-date guard ───────────────────────────────────

test('a record PREDATING the start date is a previous stint — kept', () => {
  // menorg@: off 2025-12-15, re-hired with Start Date 2026-08-03.
  assert.equal(
    isOffboardedForPaymentCatalog(
      input({ evidence: { offDate: '2025-12-15', reason: 'resigned' }, startDate: '2026-08-03' }),
    ),
    false,
  );
});

test('a record on the SAME day as the start date is kept (not strictly after)', () => {
  assert.equal(
    isOffboardedForPaymentCatalog(
      input({ evidence: { offDate: '2026-07-21', reason: 'resigned' }, startDate: '2026-07-21' }),
    ),
    false,
  );
});

test('an unparseable start date fails SAFE — the person stays visible', () => {
  assert.equal(isOffboardedForPaymentCatalog(input({ startDate: null })), false);
});

// ── Guard 3: the final-pay grace on the current cycle ───────────────────────

test('someone who left DURING the cycle being paid is kept for their final pay', () => {
  assert.equal(
    isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-08-11', reason: 'resigned' } })),
    false,
  );
});

test('an off-date exactly ON the cycle week start is kept', () => {
  assert.equal(
    isOffboardedForPaymentCatalog(input({ evidence: { offDate: CYCLE, reason: 'resigned' } })),
    false,
  );
});

test('an off-date the day BEFORE the cycle week start is hidden', () => {
  assert.equal(
    isOffboardedForPaymentCatalog(input({ evidence: { offDate: '2026-08-08', reason: 'resigned' } })),
    true,
  );
});

test('a missing cycle anchor fails SAFE — nobody is hidden', () => {
  assert.equal(isOffboardedForPaymentCatalog(input({ cycleWeekStart: '' })), false);
});

// ── Guard 4: hours in the current timesheet outrank the stamp ───────────────

test('hours in the current timesheet keep a person visible whatever the stamp says', () => {
  // sherwins@: stamped 2026-01-26, Start Date 2023-04-17, still logging hours.
  assert.equal(
    isOffboardedForPaymentCatalog(
      input({
        evidence: { offDate: '2026-01-26', reason: 'resigned' },
        startDate: '2023-04-17',
        hasCycleHours: true,
      }),
    ),
    false,
  );
});

test('the SAME person with no hours this cycle is hidden — hours are the only difference', () => {
  assert.equal(
    isOffboardedForPaymentCatalog(
      input({
        evidence: { offDate: '2026-01-26', reason: 'resigned' },
        startDate: '2023-04-17',
        hasCycleHours: false,
      }),
    ),
    true,
  );
});

test('an ancient stamp on someone with hours is still kept (kevinc@, off 2025-01)', () => {
  assert.equal(
    isOffboardedForPaymentCatalog(
      input({
        evidence: { offDate: '2025-01-14', reason: 'resigned' },
        startDate: '2024-06-17',
        hasCycleHours: true,
      }),
    ),
    false,
  );
});

// ── Every guard is independently sufficient to keep someone ─────────────────

test('each guard alone keeps a person the other three would hide', () => {
  const hideable = input({
    evidence: { offDate: '2026-07-26', reason: 'resigned' },
    startDate: '2026-07-13',
    hasCycleHours: false,
  });
  assert.equal(isOffboardedForPaymentCatalog(hideable), true, 'baseline must be hidden');

  const keepers: Array<[string, CatalogVisibilityInput]> = [
    ['no evidence', { ...hideable, evidence: null }],
    ['temporary_pause', { ...hideable, evidence: { offDate: '2026-07-26', reason: 'temporary_pause' } }],
    ['duplicate_cleanup', { ...hideable, evidence: { offDate: '2026-07-26', reason: 'duplicate_cleanup' } }],
    ['unrecognised reason', { ...hideable, evidence: { offDate: '2026-07-26', reason: 'Declined Offer' } }],
    ['no reason', { ...hideable, evidence: { offDate: '2026-07-26', reason: null } }],
    ['start-date guard', { ...hideable, startDate: '2026-07-27' }],
    ['unparseable start', { ...hideable, startDate: null }],
    ['final-pay grace', { ...hideable, evidence: { offDate: '2026-08-12', reason: 'resigned' } }],
    ['cycle hours', { ...hideable, hasCycleHours: true }],
  ];
  for (const [label, candidate] of keepers) {
    assert.equal(isOffboardedForPaymentCatalog(candidate), false, `${label} must keep the person`);
  }
});
