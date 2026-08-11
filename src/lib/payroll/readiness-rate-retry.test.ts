import assert from 'node:assert/strict';
import test from 'node:test';

import { rowsStillMissingAfterRetry } from './readiness-rate-retry';

interface Row {
  name: string;
  department: string | null;
}

const row = (name: string, department: string | null): Row => ({ name, department });

/** Stand-in for the real chain: "hogan_smith_law" / "HSL" has a department base
 *  rate; everyone else resolves only on an individual email we know about. */
const RATED_DEPTS = new Set(['hsl', 'hogan_smith_law']);
const RATED_EMAILS = new Set(['individual@simple.biz']);
const resolves = (emails: string[], department: string): boolean =>
  emails.some((e) => RATED_EMAILS.has(e)) || RATED_DEPTS.has(department.trim().toLowerCase());

test('the live case: enriched HSL department resolves a dept base rate → row drops', () => {
  const shaina = row('Shaina Blanche Narosa', 'HSL');
  const out = rowsStillMissingAfterRetry([shaina], () => ['shainan@simple.biz'], resolves);
  assert.deepEqual(out, []);
});

test('a department that genuinely has no rate keeps the row', () => {
  const r = row('No Rate Anywhere', 'Some Unfunded Team');
  const out = rowsStillMissingAfterRetry([r], () => ['nobody@simple.biz'], resolves);
  assert.deepEqual(out, [r]);
});

test('enrichment found no department → nothing to retry with, row stays', () => {
  const r = row('Unknown Dept', null);
  const out = rowsStillMissingAfterRetry([r], () => ['nobody@simple.biz'], resolves);
  assert.deepEqual(out, [r]);
});

test('an empty department string is not a department', () => {
  const r = row('Blank Dept', '');
  const out = rowsStillMissingAfterRetry([r], () => ['individual@simple.biz'], resolves);
  assert.deepEqual(out, [r], 'a falsy department must never reach the resolver');
});

test('no identity to resolve on → row stays even with a rated department', () => {
  const r = row('No Emails', 'HSL');
  const out = rowsStillMissingAfterRetry([r], () => [], resolves);
  assert.deepEqual(out, [r]);
});

test('a master-row alias the ACTIVE roster never had resolves the rate', () => {
  // The alehzandra@ vs alehzandraz@ class: the Hubstaff address never matched
  // the master row, so the first pass had only the unrated address.
  const r = row('Alias Only On Master', 'Some Unfunded Team');
  const out = rowsStillMissingAfterRetry(
    [r],
    () => ['hubstaff-only@simple.biz', 'individual@simple.biz'],
    resolves,
  );
  assert.deepEqual(out, []);
});

test('a failed enrichment read changes nothing — every row survives', () => {
  // No department and no aliases is exactly what a failed read leaves behind.
  // Over-flagging is this dimension's direction of safety.
  const rows = [row('A', null), row('B', null), row('C', null)];
  const out = rowsStillMissingAfterRetry(rows, () => [], resolves);
  assert.deepEqual(out, rows);
});

test('order is preserved for the rows that remain', () => {
  const rows = [row('A', 'HSL'), row('B', 'Some Unfunded Team'), row('C', 'HSL'), row('D', null)];
  const out = rowsStillMissingAfterRetry(rows, () => ['nobody@simple.biz'], resolves);
  assert.deepEqual(
    out.map((r) => r.name),
    ['B', 'D'],
  );
});

test('the resolver is never consulted for a row it cannot help', () => {
  const seen: string[] = [];
  const spy = (_emails: string[], department: string): boolean => {
    seen.push(department);
    return false;
  };
  rowsStillMissingAfterRetry(
    [row('has dept', 'HSL'), row('no dept', null), row('no emails', 'HSL')],
    (r) => (r.name === 'no emails' ? [] : ['x@simple.biz']),
    spy,
  );
  assert.deepEqual(seen, ['HSL'], 'only the row with both a department and an identity is retried');
});
