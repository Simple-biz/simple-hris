/**
 * "Neither reviewer may be the employee who filed the request."
 *
 * The doc has said so since 2026-08-19; the code enforced it for the second
 * approver only. On 2026-09-10 carla@ approved her own request AS ITS MANAGER and
 * nothing refused it (found 2026-09-15 by `scripts/probe-time-adjustment-signatures.mts`).
 * These tests pin the pure rule and, by source scan (no React/Supabase in tests),
 * that every reviewing write path actually calls it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { OWN_REQUEST_REVIEW_ERROR, reviewerIsFiler } from './time-adjustments';

test('the filer reviewing their own request is refused', () => {
  assert.equal(reviewerIsFiler('carla@simple.biz', 'carla@simple.biz'), true);
});

test('the comparison is case- and whitespace-insensitive — a capital letter is not a second person', () => {
  assert.equal(reviewerIsFiler('  Carla@Simple.biz ', 'carla@simple.biz'), true);
});

test('two different people pass', () => {
  assert.equal(reviewerIsFiler('claire@simple.biz', 'carla@simple.biz'), false);
});

test('a blank on either side is NOT a match — never refuse on missing data by accident, never pass it either', () => {
  assert.equal(reviewerIsFiler('', 'carla@simple.biz'), false);
  assert.equal(reviewerIsFiler('carla@simple.biz', null), false);
  assert.equal(reviewerIsFiler(undefined, undefined), false);
});

test('the refusal reads as Not authorized so the route answers 403, not 400 or 500', () => {
  assert.ok(OWN_REQUEST_REVIEW_ERROR.startsWith('Not authorized'));
});

test('every reviewing write path runs the guard: naming, manager decision, Accounting decision', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'supabase', 'time-adjustments.ts'),
    'utf8',
  );
  const body = (name: string): string => {
    const start = src.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, `${name} not found`);
    const next = src.indexOf('\nexport ', start + 1);
    return src.slice(start, next < 0 ? undefined : next);
  };
  for (const fn of ['assignSecondApprover', 'managerDecideTimeAdjustment', 'decideTimeAdjustment']) {
    assert.ok(body(fn).includes('reviewerIsFiler('), `${fn} does not check reviewer ≠ filer`);
  }
});
