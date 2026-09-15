/**
 * Kane, 2026-09-15: "any one with Acct>Issues>Edit can adjust. (Exclude Jake/April/Lenny)".
 * The grant is the route's job; this pins the exclusion and that both the server write
 * paths and the Issues UI apply it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  EXCLUDED_DECIDER_ERROR,
  isExcludedTimeAdjustmentDecider,
  TIME_ADJUSTMENT_DECIDER_EXCLUSIONS,
} from './time-adjustment-deciders';

test('the three named accounts are excluded', () => {
  assert.equal(isExcludedTimeAdjustmentDecider('jakec@simple.biz'), true);
  assert.equal(isExcludedTimeAdjustmentDecider('april@simple.biz'), true);
  assert.equal(isExcludedTimeAdjustmentDecider('lenny@simple.biz'), true);
  assert.equal(TIME_ADJUSTMENT_DECIDER_EXCLUSIONS.length, 3);
});

test('case and whitespace do not smuggle an excluded account through', () => {
  assert.equal(isExcludedTimeAdjustmentDecider('  Lenny@Simple.biz '), true);
});

test('everyone else passes — including the other Jakes and Aprils on the roster', () => {
  assert.equal(isExcludedTimeAdjustmentDecider('claire@simple.biz'), false);
  assert.equal(isExcludedTimeAdjustmentDecider('carla@simple.biz'), false);
  assert.equal(isExcludedTimeAdjustmentDecider('jakes@simple.biz'), false);
  assert.equal(isExcludedTimeAdjustmentDecider('aprilp@simple.biz'), false);
});

test('a blank is not excluded (it is refused elsewhere, as "not signed in")', () => {
  assert.equal(isExcludedTimeAdjustmentDecider(''), false);
  assert.equal(isExcludedTimeAdjustmentDecider(null), false);
});

test('the refusal reads as Not authorized so the route answers 403', () => {
  assert.ok(EXCLUDED_DECIDER_ERROR.startsWith('Not authorized'));
});

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

test('the server applies the exclusion on BOTH Accounting write paths, and the Issues UI mirrors it', () => {
  const lib = read('src', 'lib', 'supabase', 'time-adjustments.ts');
  const body = (name: string): string => {
    const start = lib.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, `${name} not found`);
    const next = lib.indexOf('\nexport ', start + 1);
    return lib.slice(start, next < 0 ? undefined : next);
  };
  for (const fn of ['decideTimeAdjustment', 'deleteTimeAdjustment']) {
    assert.ok(body(fn).includes('isExcludedTimeAdjustmentDecider('), `${fn} does not apply the exclusion`);
  }
  const queue = read('src', 'components', 'payroll', 'PabDisputeQueue.tsx');
  assert.ok(queue.includes('isExcludedTimeAdjustmentDecider('), 'the Issues UI does not mirror the exclusion');
});

test('the Accounting-stage route gate is Issues edit, not Payroll Wizard edit', () => {
  const route = read('app', 'api', 'time-adjustments', '[id]', 'route.ts');
  assert.ok(!route.includes("requireFeatureEdit('accounting', 'payroll_wizard')"), 'stage 2 still gates on payroll_wizard');
  assert.ok(route.includes("requireFeatureEdit('accounting', 'disputes')"), 'stage 2 does not gate on Issues edit');
});
