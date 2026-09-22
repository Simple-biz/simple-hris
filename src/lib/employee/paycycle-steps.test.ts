import test from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePaycycleSteps,
  type PaycycleStepKey,
  type PaycycleTrackInput,
} from './paycycle-steps';

/** Nothing has happened yet — the state a week is in on Sunday morning. */
const NOTHING: PaycycleTrackInput = {
  hubstaffLoaded: false,
  hasHoursRow: false,
  fxSet: false,
  orphanageWeekKnown: false,
  hasOrphanageHours: false,
  kpiCredited: false,
  hasAdjustment: false,
  adjustmentsSettled: false,
  wizardLocked: false,
  stagedForDispatch: false,
  paid: false,
};

/** Everything has happened — a fully paid week. */
const EVERYTHING: PaycycleTrackInput = {
  hubstaffLoaded: true,
  hasHoursRow: true,
  fxSet: true,
  orphanageWeekKnown: true,
  hasOrphanageHours: true,
  kpiCredited: true,
  hasAdjustment: true,
  adjustmentsSettled: true,
  wizardLocked: true,
  stagedForDispatch: true,
  paid: true,
};

const by = (input: PaycycleTrackInput, key: PaycycleStepKey) => {
  const step = derivePaycycleSteps(input).steps.find((s) => s.key === key);
  assert.ok(step, `no step ${key}`);
  return step;
};

test('there are eight steps, numbered 1-8 in order, with no duplicate keys', () => {
  const { steps } = derivePaycycleSteps(NOTHING);
  assert.equal(steps.length, 8);
  assert.deepEqual(
    steps.map((s) => s.stepNo),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(new Set(steps.map((s) => s.key)).size, 8);
});

test('a fresh week is all pending, nothing green', () => {
  const { steps, doneCount, totalCount } = derivePaycycleSteps(NOTHING);
  assert.ok(steps.every((s) => s.status === 'pending'));
  assert.equal(doneCount, 0);
  assert.equal(totalCount, 8);
});

test('a paid week is all done', () => {
  const { steps, doneCount, totalCount } = derivePaycycleSteps(EVERYTHING);
  assert.ok(steps.every((s) => s.status === 'done'), JSON.stringify(steps, null, 1));
  assert.equal(doneCount, 8);
  assert.equal(totalCount, 8);
});

// ── the invariant this module exists for ────────────────────────────────────

test('A DEGRADED READ IS NEVER DONE — even when the underlying fact is true', () => {
  // The whole point of the module. If the read threw we do not know the fact,
  // so the fact must not be consulted. Asserted for EVERY key, against an input
  // where every fact is true, so a future `if (fact) return 'done'` added above
  // the degraded check fails here.
  const keys: PaycycleStepKey[] = [
    'hubstaff', 'fx', 'orphanage', 'kpi', 'adjustments', 'locked', 'dispatch', 'payout',
  ];
  for (const key of keys) {
    const step = by({ ...EVERYTHING, degradedKeys: new Set([key]) }, key);
    assert.equal(step.status, 'pending', `${key} read done despite a degraded read`);
    assert.match(step.detail, /Couldn.t read/i, `${key} lost its degraded detail`);
  }
});

test('a degraded read degrades ONLY its own step', () => {
  const { steps } = derivePaycycleSteps({ ...EVERYTHING, degradedKeys: new Set(['fx' as const]) });
  assert.equal(steps.find((s) => s.key === 'fx')?.status, 'pending');
  assert.ok(steps.filter((s) => s.key !== 'fx').every((s) => s.status === 'done'));
});

test('a degraded orphanage read is pending, NOT not_applicable', () => {
  // The dangerous confusion: "we could not read it" must never be presented to
  // someone as "it does not apply to you".
  const step = by(
    { ...NOTHING, orphanageWeekKnown: true, degradedKeys: new Set(['orphanage' as const]) },
    'orphanage',
  );
  assert.equal(step.status, 'pending');
});

// ── step 1: the upload landed vs you are in it ──────────────────────────────

test('the upload landing is not enough — you must be IN it', () => {
  const step = by({ ...NOTHING, hubstaffLoaded: true, hasHoursRow: false }, 'hubstaff');
  assert.equal(step.status, 'pending');
  assert.match(step.detail, /no tracked hours for you/i);
});

test('no upload at all says so, rather than blaming the employee', () => {
  const step = by({ ...NOTHING, hubstaffLoaded: false, hasHoursRow: false }, 'hubstaff');
  assert.match(step.detail, /haven.t been uploaded/i);
});

// ── step 3: Kane's Q7 ruling ────────────────────────────────────────────────

test('orphanage is NOT APPLICABLE only once the week\'s data is known to have landed', () => {
  // Kane, Q7: "If the Orphanage was already added but that person has no hours".
  const known = by({ ...NOTHING, orphanageWeekKnown: true, hasOrphanageHours: false }, 'orphanage');
  assert.equal(known.status, 'not_applicable');
  assert.match(known.detail, /no orphanage hours for you/i);
});

test('orphanage stays PENDING while the week is unknown — a later paste can still add you', () => {
  // lock-in accumulates: "no row for me yet" is not "no row for me".
  const unknown = by({ ...NOTHING, orphanageWeekKnown: false, hasOrphanageHours: false }, 'orphanage');
  assert.equal(unknown.status, 'pending');
  assert.match(unknown.detail, /haven.t been logged/i);
});

test('having hours outranks the week marker — evidence beats an assertion', () => {
  // Mirrors the wizard checklist's rule that real rows outrank a confirm-none
  // marker. If someone HAS hours, a "none this week" marker cannot erase them.
  const step = by({ ...NOTHING, orphanageWeekKnown: false, hasOrphanageHours: true }, 'orphanage');
  assert.equal(step.status, 'done');
});

test('not_applicable is excluded from BOTH sides of the count, so N/M can reach its ceiling', () => {
  const track = derivePaycycleSteps({ ...EVERYTHING, hasOrphanageHours: false });
  assert.equal(track.totalCount, 7);
  assert.equal(track.doneCount, 7);
  assert.ok(track.steps.some((s) => s.status === 'not_applicable'));
});

// ── step 5: the vacuously-green trap ────────────────────────────────────────

test('no adjustment is NOT done until the week is settled', () => {
  // Most people have no adjustment in most weeks. If "none found" meant done,
  // this dot would be green from Sunday morning and carry no information.
  const early = by({ ...NOTHING, hasAdjustment: false, adjustmentsSettled: false }, 'adjustments');
  assert.equal(early.status, 'pending');
  assert.match(early.detail, /still working through/i);
});

test('no adjustment IS done once the week is settled', () => {
  const settled = by({ ...NOTHING, hasAdjustment: false, adjustmentsSettled: true }, 'adjustments');
  assert.equal(settled.status, 'done');
  assert.match(settled.detail, /no adjustments/i);
});

test('having an adjustment is done immediately, settled or not', () => {
  const step = by({ ...NOTHING, hasAdjustment: true, adjustmentsSettled: false }, 'adjustments');
  assert.equal(step.status, 'done');
});

// ── steps 7 and 8: Kane's Q3 ruling ─────────────────────────────────────────

test('SENT TO DISPATCH and AWAITING PAYOUT do not light together', () => {
  // In the wizard they are one button. Here step 7 is measured per-person (your
  // staged row) and step 8 is the money actually leaving, so a staged-unpaid
  // week shows 7 green and 8 pending — which is the "awaiting" state itself.
  const staged = { ...EVERYTHING, stagedForDispatch: true, paid: false };
  assert.equal(by(staged, 'dispatch').status, 'done');
  assert.equal(by(staged, 'payout').status, 'pending');
  assert.match(by(staged, 'payout').detail, /awaiting payout/i);
});

test('the last step renames itself once paid', () => {
  assert.equal(by({ ...EVERYTHING, paid: false }, 'payout').label, 'Awaiting payout');
  assert.equal(by(EVERYTHING, 'payout').label, 'Paid');
});

test('a locked week that never staged THIS person stops at 6', () => {
  // The held/excluded case. The fleet's lock is set, but nothing was queued for
  // them — so they must not march to "awaiting payout" behind someone else's
  // lock. This is the per-person half of why 7 is separate from 6.
  const held = { ...EVERYTHING, stagedForDispatch: false, paid: false };
  assert.equal(by(held, 'locked').status, 'done');
  assert.equal(by(held, 'dispatch').status, 'pending');
  assert.equal(by(held, 'payout').status, 'pending');
  assert.match(by(held, 'payout').detail, /not sent for payout/i);
});

// ── disclosure ──────────────────────────────────────────────────────────────

test('no detail leaks a fleet-wide count or another person', () => {
  // The accountant's checklist details say things like "3 people locked in" and
  // "2/5 departments ready". Those are company-scoped and must never appear on
  // an employee's screen.
  for (const input of [NOTHING, EVERYTHING]) {
    for (const step of derivePaycycleSteps(input).steps) {
      assert.ok(!/\bpeople\b/i.test(step.detail), step.detail);
      assert.ok(!/\bdepartments?\b/i.test(step.detail), step.detail);
      assert.ok(!/\d+\s*\/\s*\d+/.test(step.detail), step.detail);
      assert.ok(!/@/.test(step.detail), step.detail);
    }
  }
});

test('every step has a non-empty label and detail in every state', () => {
  const inputs: PaycycleTrackInput[] = [
    NOTHING,
    EVERYTHING,
    { ...EVERYTHING, hasOrphanageHours: false },
    { ...EVERYTHING, paid: false },
    { ...NOTHING, degradedKeys: new Set(['hubstaff', 'fx', 'orphanage', 'kpi']) },
  ];
  for (const input of inputs) {
    for (const step of derivePaycycleSteps(input).steps) {
      assert.ok(step.label.trim().length > 0);
      assert.ok(step.detail.trim().length > 0);
    }
  }
});
