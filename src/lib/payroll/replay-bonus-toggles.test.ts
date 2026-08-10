import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldFreezeReplayBonusToggles,
  resolveBonusToggle,
  kpiAmountsMatchWeek,
} from './replay-bonus-toggles';

const WEEK_A = 'hubstaff_2026-07-12_to_2026-07-18.csv';
const WEEK_B = 'hubstaff_2026-07-19_to_2026-07-25.csv';

// ── shouldFreezeReplayBonusToggles ───────────────────────────────────────────

test('the live week never freezes — re-deriving is the whole job there', () => {
  assert.equal(shouldFreezeReplayBonusToggles(false, WEEK_B, WEEK_B), false);
});

test('a replay with its own saved toggles freezes', () => {
  assert.equal(shouldFreezeReplayBonusToggles(true, WEEK_A, WEEK_A), true);
});

test('a replay that saved NO toggles falls back to live, never to zero', () => {
  // The 2026-07-17 "empty locked PAB snapshot showed ₱0 for everyone" failure.
  // An absent/empty saved map counts as ABSENT, so live computation takes over.
  assert.equal(shouldFreezeReplayBonusToggles(true, null, WEEK_A), false);
});

test('a marker from the previously-viewed week cannot freeze this one', () => {
  // The marker outlives a week switch by a render. Comparing it against the
  // selected file (not just checking non-null) is what stops week A's saved
  // toggles being treated as week B's.
  assert.equal(shouldFreezeReplayBonusToggles(true, WEEK_A, WEEK_B), false);
});

test('no file selected cannot freeze', () => {
  assert.equal(shouldFreezeReplayBonusToggles(true, WEEK_A, null), false);
  assert.equal(shouldFreezeReplayBonusToggles(true, null, null), false);
});

// ── resolveBonusToggle ───────────────────────────────────────────────────────

test('frozen: a saved verdict is never overwritten, in either direction', () => {
  // This is the bug. Live eligibility disagreeing with the saved verdict used to
  // win; now the saved verdict holds and the replay shows what was paid.
  assert.equal(resolveBonusToggle(true, true, false), null, 'saved-on was cleared by live-ineligible');
  assert.equal(resolveBonusToggle(true, false, true), null, 'saved-off was set by live-eligible');
  assert.equal(resolveBonusToggle(true, true, true), null);
  assert.equal(resolveBonusToggle(true, false, false), null);
});

test('frozen: an employee the blob never covered still gets their live verdict', () => {
  // Joined the roster/dept after the lock-in. A silent `false` would invent a
  // ₱0 bonus; mirrors effectivePabStatus's rule for employees absent from a
  // frozen PAB snapshot.
  assert.equal(resolveBonusToggle(true, undefined, true), true);
  // ...and stays a no-op when live agrees with the implicit off.
  assert.equal(resolveBonusToggle(true, undefined, false), null);
});

test('not frozen: live eligibility drives the toggle', () => {
  assert.equal(resolveBonusToggle(false, false, true), true);
  assert.equal(resolveBonusToggle(false, true, false), false);
  assert.equal(resolveBonusToggle(false, undefined, true), true);
});

test('not frozen: agreement is a no-op, so the effect cannot loop', () => {
  assert.equal(resolveBonusToggle(false, true, true), null);
  assert.equal(resolveBonusToggle(false, false, false), null);
  assert.equal(resolveBonusToggle(false, undefined, false), null);
});

// ── kpiAmountsMatchWeek ──────────────────────────────────────────────────────

test('an unloaded marker never matches — in flight or a failed read', () => {
  assert.equal(kpiAmountsMatchWeek(null, '2026-07-12'), false);
  assert.equal(kpiAmountsMatchWeek(null, null), false);
});

test('a marker for another week never matches', () => {
  // The window a week switch opens: the maps still hold week A while the rows
  // being priced are week B's. Publishing here is how one week's KPI bonuses
  // land on another week's pay.
  assert.equal(kpiAmountsMatchWeek({ week: '2026-07-12' }, '2026-07-19'), false);
});

test('a marker for this week matches', () => {
  assert.equal(kpiAmountsMatchWeek({ week: '2026-07-12' }, '2026-07-12'), true);
});

test('"loaded with no file selected" is distinct from "not loaded"', () => {
  // Why the marker is an object. A bare `string | null` would collapse these two
  // into the same value and the gate would pass on an unloaded map.
  assert.equal(kpiAmountsMatchWeek({ week: null }, null), true);
  assert.equal(kpiAmountsMatchWeek(null, null), false);
  // ...and a no-file load must not satisfy a real week, or vice versa.
  assert.equal(kpiAmountsMatchWeek({ week: null }, '2026-07-12'), false);
  assert.equal(kpiAmountsMatchWeek({ week: '2026-07-12' }, null), false);
});
