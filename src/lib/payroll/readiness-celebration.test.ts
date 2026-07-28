import { test } from 'node:test';
import assert from 'node:assert/strict';

import { celebrationStep, isFullyReady } from './readiness-celebration';

/**
 * The 100% confetti moment must be EXACTLY a live transition and nothing else.
 * These tests lock the rules that keep it trustworthy (and non-annoying):
 *   1. First payload of a mount never celebrates — even at 100/Ready. The
 *      accountant opened onto a clean week; nothing happened in front of them.
 *   2. The same week moving not-ready → 100/Ready celebrates. Once.
 *   3. Staying at 100/Ready (polls, live refreshes) never re-celebrates.
 *   4. Switching onto a different, already-clean week never celebrates.
 *   5. A dip below ready followed by clearing again is a real re-transition —
 *      it celebrates again.
 *   6. A degraded load (value 100 but grade capped off 'ready') is never
 *      fully ready — partial data can't throw a party.
 */

const READY = { value: 100, grade: 'ready' } as const;
const BLOCKED = { value: 60, grade: 'blocked' } as const;
const ALMOST = { value: 99, grade: 'almost' } as const;
/** What a degraded all-clear load looks like: the composer caps the grade to
 *  at_risk while any source failed to read, even at a summed 100. */
const DEGRADED_100 = { value: 100, grade: 'at_risk' } as const;

const WEEK = 'hubstaff_2026-07-19_to_2026-07-25.csv';
const OTHER_WEEK = 'hubstaff_2026-07-12_to_2026-07-18.csv';

test('isFullyReady = 100 AND grade ready; degraded 100 does not count', () => {
  assert.equal(isFullyReady(READY), true);
  assert.equal(isFullyReady(ALMOST), false);
  assert.equal(isFullyReady(BLOCKED), false);
  assert.equal(isFullyReady(DEGRADED_100), false);
});

test('first payload never celebrates, even when already 100/Ready', () => {
  const step = celebrationStep(null, WEEK, READY);
  assert.equal(step.celebrate, false);
  assert.deepEqual(step.next, { week: WEEK, fullyReady: true });
});

test('the live transition: same week, not-ready → 100/Ready → celebrate once', () => {
  let state = celebrationStep(null, WEEK, BLOCKED).next;
  const hit = celebrationStep(state, WEEK, READY);
  assert.equal(hit.celebrate, true);
  state = hit.next;
  // Subsequent refreshes at 100/Ready stay quiet.
  assert.equal(celebrationStep(state, WEEK, READY).celebrate, false);
});

test('switching onto a different already-clean week never celebrates', () => {
  const state = celebrationStep(null, WEEK, BLOCKED).next;
  const step = celebrationStep(state, OTHER_WEEK, READY);
  assert.equal(step.celebrate, false);
  // ...and the new week is now the one being watched.
  assert.deepEqual(step.next, { week: OTHER_WEEK, fullyReady: true });
});

test('a dip and re-clear on the same week celebrates again', () => {
  let state = celebrationStep(null, WEEK, BLOCKED).next;
  state = celebrationStep(state, WEEK, READY).next; // first celebration
  state = celebrationStep(state, WEEK, ALMOST).next; // someone new turned up missing
  const again = celebrationStep(state, WEEK, READY);
  assert.equal(again.celebrate, true);
});

test('a degraded 100 neither celebrates nor arms a later false transition', () => {
  // Watching the week at blocked, then a degraded all-clear load arrives…
  let state = celebrationStep(null, WEEK, BLOCKED).next;
  const degraded = celebrationStep(state, WEEK, DEGRADED_100);
  assert.equal(degraded.celebrate, false);
  state = degraded.next;
  // …and when the sources recover into a true 100/Ready, THAT is the moment.
  assert.equal(celebrationStep(state, WEEK, READY).celebrate, true);
});
