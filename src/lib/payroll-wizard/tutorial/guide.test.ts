import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TUTORIAL_STEPS,
  deriveStepStatus,
  parseTutorialState,
  serializeTutorialState,
  tutorialStorageKey,
  type TutorialSignals,
} from './guide';

// [WIZARD-TUTORIAL] The guide is ADVISORY by contract: no derivation may gate
// anything — these tests pin the shape (statuses + notes), and pin that every
// wizard step 1–9 has exactly one guide entry in shipped step order.

const BASE: TutorialSignals = {
  todayIso: '2026-08-17',
  sourceFile: 'Aug 10 - Aug 16.csv',
  periodStart: '2026-08-10',
  periodEnd: '2026-08-16',
  fxRate: 57.2,
  orphanageReadyCount: 0,
  pabRangeLabel: 'August 2026',
  isTechBonusWeek: false,
  pendingContractorCount: 0,
  validationRedFlagCount: 0,
  excludedCount: 0,
  payableCount: 120,
  dispatched: false,
  visitedSteps: [],
};

test('guide covers wizard steps 1–9 exactly once, in shipped order', () => {
  assert.deepEqual(
    TUTORIAL_STEPS.map((s) => s.stepId),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test('step 1: missing report is pending, fresh report is done, old report is attention', () => {
  assert.equal(deriveStepStatus(1, { ...BASE, sourceFile: null }).status, 'pending');
  assert.equal(deriveStepStatus(1, BASE).status, 'done');
  const stale = deriveStepStatus(1, {
    ...BASE,
    periodEnd: '2026-08-01', // 16 days before todayIso
  });
  assert.equal(stale.status, 'attention');
  assert.match(stale.note ?? '', /stale/i);
});

test('step 2: zero/absent FX is attention regardless of visits', () => {
  assert.equal(deriveStepStatus(2, { ...BASE, fxRate: 0, visitedSteps: [2] }).status, 'attention');
  assert.equal(deriveStepStatus(2, { ...BASE, fxRate: null }).status, 'attention');
  assert.equal(deriveStepStatus(2, { ...BASE, visitedSteps: [2] }).status, 'done');
});

test('step 3: pasted rows mark done without requiring a visit', () => {
  assert.equal(deriveStepStatus(3, { ...BASE, orphanageReadyCount: 4 }).status, 'done');
  assert.equal(deriveStepStatus(3, BASE).status, 'pending');
  assert.equal(deriveStepStatus(3, { ...BASE, visitedSteps: [3] }).status, 'done');
});

test('step 5: note always names the PAB range and tech-bonus verdict', () => {
  const s = deriveStepStatus(5, BASE);
  assert.match(s.note ?? '', /PAB range: August 2026/);
  assert.match(s.note ?? '', /Not a Technology Bonus payout week/);
  const techWeek = deriveStepStatus(5, { ...BASE, isTechBonusWeek: true });
  assert.match(techWeek.note ?? '', /IS a Technology Bonus payout week/);
});

test('step 6: pending invoices demand attention, none is done', () => {
  assert.equal(deriveStepStatus(6, { ...BASE, pendingContractorCount: 3 }).status, 'attention');
  assert.equal(deriveStepStatus(6, BASE).status, 'done');
});

test('step 7: red flags demand attention and count appears in the note', () => {
  const flagged = deriveStepStatus(7, { ...BASE, validationRedFlagCount: 2 });
  assert.equal(flagged.status, 'attention');
  assert.match(flagged.note ?? '', /2 validation flag/);
  assert.equal(deriveStepStatus(7, { ...BASE, visitedSteps: [7] }).status, 'done');
});

test('step 8: never attention — advisory pending until dispatched', () => {
  const before = deriveStepStatus(8, { ...BASE, validationRedFlagCount: 5 });
  assert.equal(before.status, 'pending');
  assert.equal(deriveStepStatus(8, { ...BASE, dispatched: true }).status, 'done');
});

test('persisted state round-trips and survives garbage', () => {
  const key = tutorialStorageKey(' Kaner@Simple.biz ', 'Aug 10 - Aug 16.csv');
  assert.equal(key, 'wizard-tutorial:kaner@simple.biz:Aug 10 - Aug 16.csv');

  const state = { dismissed: true, collapsed: false, visitedSteps: [3, 1, 3, 99] };
  const parsed = parseTutorialState(serializeTutorialState(state));
  assert.deepEqual(parsed, { dismissed: true, collapsed: false, visitedSteps: [1, 3] });

  assert.deepEqual(parseTutorialState(null), {
    dismissed: false,
    collapsed: false,
    visitedSteps: [],
  });
  assert.deepEqual(parseTutorialState('{not json'), {
    dismissed: false,
    collapsed: false,
    visitedSteps: [],
  });
});
