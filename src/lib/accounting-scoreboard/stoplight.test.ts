/** Run: node --import tsx --test src/lib/accounting-scoreboard/stoplight.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalLight, weekPace } from './stoplight';
import { sectionDef } from './sections';

const collections = sectionDef('collections').goal!; // ≥ 85 points, weekly total
const buckets = sectionDef('buckets').goal!; // ≥ 8 score, an average
const problems = sectionDef('payroll_problems').goal!; // < 20, weekly total

test('an at-least goal over a full week: met green, within 80% amber, below red', () => {
  assert.equal(goalLight(collections, 85), 'green');
  assert.equal(goalLight(collections, 68), 'amber'); // exactly 80%
  assert.equal(goalLight(collections, 67.9), 'red');
});

test('scores are never paced', () => {
  assert.equal(goalLight(buckets, 8, 0.2), 'green');
  assert.equal(goalLight(buckets, 6.4, 0.2), 'amber');
  assert.equal(goalLight(buckets, 6, 0.2), 'red');
});

test("this week's running totals are judged on pace", () => {
  // Thursday morning: Mon–Wed are over, 3/5 of the week → the pace target is 51 points.
  assert.equal(goalLight(collections, 51, 0.6), 'green');
  assert.equal(goalLight(collections, 41, 0.6), 'amber');
  assert.equal(goalLight(collections, 40, 0.6), 'red');
  assert.equal(goalLight(collections, 90, 0), 'green', 'already past the full goal is green on day one');
  assert.equal(goalLight(collections, 10, 0), 'none', 'Monday: too early to call');
});

test('a below goal: under is green, a little over amber, 20% over red; going over the FULL goal is final', () => {
  assert.equal(goalLight(problems, 19), 'green');
  assert.equal(goalLight(problems, 20), 'amber');
  assert.equal(goalLight(problems, 24), 'red');
  // Wednesday morning (2/5): an allowance of 8 so far.
  assert.equal(goalLight(problems, 7, 0.4), 'green');
  assert.equal(goalLight(problems, 9, 0.4), 'amber');
  assert.equal(goalLight(problems, 10, 0.4), 'red');
  assert.equal(goalLight(problems, 25, 0), 'red', 'over the full goal is red whatever the pace');
  assert.equal(goalLight(problems, 3, 0), 'none');
});

test('absence is not a colour', () => {
  assert.equal(goalLight(collections, null), 'none');
  assert.equal(goalLight(undefined, 5), 'none');
});

test('weekPace counts the days that are over', () => {
  const d = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
  assert.equal(weekPace(d, '2026-10-01'), 0.6);
  assert.equal(weekPace(d, '2026-09-28'), 0);
  assert.equal(weekPace(d, '2026-10-05'), 1);
});

test('averages and ratios are never paced (PM Buckets < 30, Outcomes ≥ 50%; Carla, 2026-10-07)', () => {
  const pm = sectionDef('pm_buckets').goal!;
  const wins = sectionDef('chargeback_outcomes').goal!;
  assert.equal(goalLight(pm, 25, 0.2), 'green');
  assert.equal(goalLight(pm, 32, 0.2), 'amber');
  assert.equal(goalLight(pm, 36, 0.2), 'red');
  assert.equal(goalLight(wins, 50, 0.2), 'green');
  assert.equal(goalLight(wins, 40, 0.2), 'amber');
  assert.equal(goalLight(wins, 39.9, 0.2), 'red');
});
