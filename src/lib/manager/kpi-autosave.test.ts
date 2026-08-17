import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kpiAutosaveGate,
  shouldRearmAutosave,
  subTeamInputsBlank,
  KPI_AUTOSAVE_DEBOUNCE_MS,
  type KpiAutosaveInput,
} from './kpi-autosave';

/** A dept that is loaded, on a resolved week, editable, and freshly edited by a
 *  human — i.e. the only shape that may write. Each test flips one field. */
function ready(over: Partial<KpiAutosaveInput> = {}): KpiAutosaveInput {
  return {
    loaded: true,
    weekResolved: true,
    editable: true,
    payrollLocked: false,
    saving: false,
    dirty: true,
    seededOnly: false,
    failedUnchanged: false,
    ...over,
  };
}

// ── the one shape that writes ────────────────────────────────────────────────

test('a loaded, resolved, editable dept with a manager edit autosaves', () => {
  assert.deepEqual(kpiAutosaveGate(ready()), { save: true });
});

test('nothing to save is not an error, just clean', () => {
  assert.deepEqual(kpiAutosaveGate(ready({ dirty: false })), {
    save: false,
    reason: 'clean',
  });
});

// ── every guard the manual Save carried ──────────────────────────────────────

test('never writes before the dept has loaded', () => {
  assert.deepEqual(kpiAutosaveGate(ready({ loaded: false })), {
    save: false,
    reason: 'not-loaded',
  });
});

test('never writes before the Hubstaff payroll week resolves', () => {
  // (department, period_start) is the row's only address; the seed week is a
  // local-clock guess, so writing early strands rows nobody reads back.
  assert.deepEqual(kpiAutosaveGate(ready({ weekResolved: false })), {
    save: false,
    reason: 'week-unresolved',
  });
});

test('never writes into a ready/locked week — draft-only editing holds', () => {
  assert.deepEqual(kpiAutosaveGate(ready({ editable: false })), {
    save: false,
    reason: 'not-draft',
  });
});

test('never writes while payroll is processing (the server answers 423)', () => {
  assert.deepEqual(kpiAutosaveGate(ready({ payrollLocked: true })), {
    save: false,
    reason: 'payroll-locked',
  });
});

test('the processing lock outranks everything below it', () => {
  // A dirty, editable dept mid-run must report the lock, not "in-flight" or a
  // stale-failure reason — that is the message the manager needs.
  const g = kpiAutosaveGate(
    ready({ payrollLocked: true, saving: true, failedUnchanged: true }),
  );
  assert.deepEqual(g, { save: false, reason: 'payroll-locked' });
});

test('never double-writes while a save is in flight', () => {
  assert.deepEqual(kpiAutosaveGate(ready({ saving: true })), {
    save: false,
    reason: 'in-flight',
  });
});

// ── load-seeded state is not "a field entered" ───────────────────────────────

test('load-seeded defaults never autosave — opening the tab must not write rows', () => {
  // A fresh draft week arrives with common bonuses pre-ticked and QC values
  // seeded, flagged dirty on load. Persisting that would attribute applied rows
  // to whoever merely opened the calculator.
  assert.deepEqual(kpiAutosaveGate(ready({ seededOnly: true })), {
    save: false,
    reason: 'seeded-only',
  });
});

test('once the manager enters something, the seeded rows go with it', () => {
  // seededOnly drops the moment a human touches the dept, and the whole dept
  // (seeded defaults included) is then persisted as one set — same as the old
  // Save button did.
  assert.deepEqual(kpiAutosaveGate(ready({ seededOnly: false })), { save: true });
});

// ── no retry storm ───────────────────────────────────────────────────────────

test('a failed write is not retried until the manager changes something', () => {
  // A failure leaves the dept dirty. Without this, the debounce would re-fire
  // forever and hammer the route.
  assert.deepEqual(kpiAutosaveGate(ready({ failedUnchanged: true })), {
    save: false,
    reason: 'failed-unchanged',
  });
});

test('a further edit clears the failure hold and retries', () => {
  assert.deepEqual(kpiAutosaveGate(ready({ failedUnchanged: false })), { save: true });
});

// ── debounce ─────────────────────────────────────────────────────────────────

test('the debounce is long enough to coalesce typing, short enough not to lose a tab switch', () => {
  assert.ok(KPI_AUTOSAVE_DEBOUNCE_MS >= 500, 'too short — every keystroke would POST');
  assert.ok(KPI_AUTOSAVE_DEBOUNCE_MS <= 2000, 'too long — an unmount flush carries too much');
});

// ── per-dept debounce (stops one dept starving another's write) ──────────────

test('a dept with no pending timer always arms one', () => {
  const s = { dept: 'a' };
  assert.equal(shouldRearmAutosave(undefined, s, false), true);
  assert.equal(shouldRearmAutosave(s, s, false), true, 'a fired timer must re-arm');
});

test('a countdown already running for THIS state is left alone', () => {
  // The whole point: editing another department re-runs the effect for this one.
  // Resetting the countdown here is what starves it.
  const s = { dept: 'a' };
  assert.equal(shouldRearmAutosave(s, s, true), false);
});

test('a countdown is reset when THIS dept changed', () => {
  const before = { dept: 'a', n: 1 };
  const after = { dept: 'a', n: 2 };
  assert.equal(shouldRearmAutosave(before, after, true), true);
});

test('equal-looking but distinct state objects count as a change', () => {
  // Identity, not deep equality — every mutator replaces the object, so this is
  // exactly the signal "the manager typed something".
  assert.equal(shouldRearmAutosave({ n: 1 }, { n: 1 }, true), true);
});

// ── SSD sub-team blankness (stops an automatic ₱0 overwrite) ─────────────────

test('an untouched sub-team is blank', () => {
  assert.equal(subTeamInputsBlank({ pct: '', records: '', rfc: '' }), true);
  assert.equal(subTeamInputsBlank({ pct: '  ', records: '\t', rfc: ' ' }), true);
});

test('a typed zero is an input, NOT blank — a real zero score must still save', () => {
  assert.equal(subTeamInputsBlank({ pct: '0', records: '', rfc: '' }), false);
  assert.equal(subTeamInputsBlank({ pct: '', records: '0', rfc: '' }), false);
  assert.equal(subTeamInputsBlank({ pct: '', records: '', rfc: '0' }), false);
});

test('any one field present makes the sub-team non-blank', () => {
  assert.equal(subTeamInputsBlank({ pct: '95', records: '', rfc: '' }), false);
  assert.equal(subTeamInputsBlank({ pct: '', records: '13', rfc: '' }), false);
  assert.equal(subTeamInputsBlank({ pct: '', records: '', rfc: '13' }), false);
});
