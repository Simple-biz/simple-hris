import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TUTORIAL_STEPS,
  activeHslColumnLabel,
  deriveStepStatus,
  parseTutorialState,
  resolveStepTargets,
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
  fxPhp: 57.2,
  fxCop: 4150,
  previousCycleFx: null,
  orphanageReadyCount: 0,
  pabRangeLabel: 'August 2026',
  isTechBonusWeek: false,
  hslPabColumnShown: true,
  hslTechColumnShown: true,
  additionsHslTabActive: false,
  systemBonusModalOpen: false,
  pabSetForActiveMonth: false,
  pabActiveMonthLabel: 'August 2026',
  pendingContractorCount: 0,
  pabIneligibleCount: 0,
  pabReviewCount: 0,
  validationRedFlagCount: 0,
  excludedCount: 0,
  payableCount: 120,
  dispatched: false,
  visitedSteps: [],
};

test('guide covers wizard steps 1–9 exactly once, in shipped order', () => {
  // Nine since the PAB review landed (2026-08-28; moved before Additions
  // 2026-09-01: PAB 4 · Additions 5 · Contractors 6). The ids must
  // stay contiguous — the wizard's progress bar divides by steps.length, so a gap
  // reads past 100% and marks Reports complete while standing on Dispatch.
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

test('step 2: either zero/absent FX leg is attention regardless of visits', () => {
  assert.equal(deriveStepStatus(2, { ...BASE, fxPhp: 0, visitedSteps: [2] }).status, 'attention');
  assert.equal(deriveStepStatus(2, { ...BASE, fxCop: 0, visitedSteps: [2] }).status, 'attention');
  assert.equal(deriveStepStatus(2, { ...BASE, fxPhp: null }).status, 'attention');
  assert.equal(deriveStepStatus(2, { ...BASE, visitedSteps: [2] }).status, 'done');
});

test('step 2 rings only the UNSET legs, each with its own CTA', () => {
  // Both unset → both boxes and both CTAs.
  assert.deepEqual(resolveStepTargets(2, { ...BASE, fxPhp: 0, fxCop: 0 }), [
    'step2-fx-php',
    'step2-fx-php-cta',
    'step2-fx-cop',
    'step2-fx-cop-cta',
  ]);
  // PHP entered → stop nagging about PHP, keep ringing COP.
  assert.deepEqual(resolveStepTargets(2, { ...BASE, fxCop: 0 }), [
    'step2-fx-cop',
    'step2-fx-cop-cta',
  ]);
  assert.deepEqual(resolveStepTargets(2, { ...BASE, fxPhp: 0 }), [
    'step2-fx-php',
    'step2-fx-php-cta',
  ]);
  // Both set → nothing to fix, fall back to reviewing the calc.
  assert.deepEqual(resolveStepTargets(2, BASE), ['step2-review']);
});

test('step 2 names WHEN the rates were last set, and refuses to carry them over', () => {
  const savedAt = '2026-08-10T02:14:00Z';
  // The readout is in the OPERATOR's local timezone (same convention as the
  // narrative lib), so derive the expected label rather than pinning a UTC day.
  const expectedDay = new Date(savedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  const note = deriveStepStatus(2, {
    ...BASE,
    fxPhp: 0,
    fxCop: 0,
    previousCycleFx: {
      sourceFile: 'Aug 03 - Aug 09.csv',
      php: 57.1,
      cop: 4100,
      at: savedAt,
      by: 'carla@simple.biz',
    },
  }).note ?? '';
  assert.match(note, /Neither conversion rate is set for this cycle/);
  assert.ok(
    note.includes(`Last set ${expectedDay}`),
    `expected the note to name ${expectedDay}; got: ${note}`,
  );
  assert.match(note, /by carla/, 'names the operator without the domain');
  assert.match(note, /Aug 03 - Aug 09\.csv/);
  assert.match(note, /₱57\.1/);
  assert.match(note, /never carried over/i, 'the old rate is shown, never offered as a value to keep');
});

test('step 2 falls back to the zero-placeholder explanation with no prior cycle', () => {
  const note = deriveStepStatus(2, { ...BASE, fxPhp: 0, fxCop: 0 }).note ?? '';
  assert.match(note, /starts at zero/);
  assert.doesNotMatch(note, /Last set/);
});

test('step 3: pasted rows mark done without requiring a visit', () => {
  assert.equal(deriveStepStatus(3, { ...BASE, orphanageReadyCount: 4 }).status, 'done');
  assert.equal(deriveStepStatus(3, BASE).status, 'pending');
  assert.equal(deriveStepStatus(3, { ...BASE, visitedSteps: [3] }).status, 'done');
});

const HSL_TAB: TutorialSignals = { ...BASE, additionsHslTabActive: true };

test("step 5's HSL tab rings the HSL table and takes turns across its money columns", () => {
  const order = [0, 1, 2, 3, 4].map((tick) => resolveStepTargets(5, HSL_TAB, tick));
  // The table stays ringed the whole time; the second target rotates.
  assert.ok(order.every((t) => t[0] === 'step5-hsl-table'));
  assert.deepEqual(
    order.map((t) => t[1]),
    [
      'step5-col-pab',
      'step5-col-tech',
      'step5-col-mesa',
      'step5-col-adjustment',
      'step5-col-orphanage',
    ],
  );
  // And it wraps rather than running off the end.
  assert.deepEqual(resolveStepTargets(5, HSL_TAB, 5)[1], 'step5-col-pab');
  assert.deepEqual(activeHslColumnLabel(HSL_TAB, 1), 'Tech Bonus');
});

test('step 5 rotation skips columns the cycle does not render', () => {
  const noBonusCols = { ...HSL_TAB, hslPabColumnShown: false, hslTechColumnShown: false };
  const seen = [0, 1, 2].map((t) => resolveStepTargets(5, noBonusCols, t)[1]);
  assert.deepEqual(seen, ['step5-col-mesa', 'step5-col-adjustment', 'step5-col-orphanage']);
  assert.equal(activeHslColumnLabel(noBonusCols, 0), 'MESA');
});

test('step 4 (PAB) flags an ineligible cohort but never gates', () => {
  // Advisory by contract: the worst this may do is turn a badge amber.
  assert.equal(deriveStepStatus(4, BASE).status, 'pending');
  const some = deriveStepStatus(4, { ...BASE, pabIneligibleCount: 4, pabReviewCount: 2 });
  assert.equal(some.status, 'attention');
  assert.match(some.note ?? '', /4 person\(s\) ineligible/);
  assert.match(some.note ?? '', /2 missed only 1–2 days/);
  // Visited with nobody ineligible reads done, not attention.
  assert.equal(deriveStepStatus(4, { ...BASE, visitedSteps: [4] }).status, 'done');
});

test('step 5 follows the operator into the System Bonus modal', () => {
  // Closed → ring the trigger.
  assert.deepEqual(resolveStepTargets(5, BASE), ['step5-system-bonus']);
  // Open, month unset → ring the month pill AND the tech-week picker.
  assert.deepEqual(resolveStepTargets(5, { ...BASE, systemBonusModalOpen: true }), [
    'step5-pab-month',
    'step5-tech-week',
  ]);
});

test('step 5 leaves an already-set PAB month alone', () => {
  const s = { ...BASE, systemBonusModalOpen: true, pabSetForActiveMonth: true };
  // "if PAB is set already for that period this shouldnt bother at all" — the
  // month pill loses its ring entirely; only the tech week keeps one.
  assert.deepEqual(resolveStepTargets(5, s), ['step5-tech-week']);
  const st = deriveStepStatus(5, s);
  assert.equal(st.status, 'done');
  assert.match(st.note ?? '', /already set/);

  const unset = deriveStepStatus(5, { ...BASE, systemBonusModalOpen: true });
  assert.equal(unset.status, 'attention');
  assert.match(unset.note ?? '', /August 2026 has no PAB period saved/);
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

test('step 5 only rings what is mounted: HSL columns need the HSL tab', () => {
  // The merged step's two surfaces never coexist in the DOM, so a ring resolved
  // for the wrong one would silently disappear.
  const onHslTab = resolveStepTargets(5, { ...HSL_TAB, systemBonusModalOpen: true }, 0);
  assert.deepEqual(onHslTab, ['step5-hsl-table', 'step5-col-pab']);
  const onDeptTab = resolveStepTargets(5, BASE, 0);
  assert.ok(onDeptTab.every((t) => !t.startsWith('step5-col-') && t !== 'step5-hsl-table'));
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
