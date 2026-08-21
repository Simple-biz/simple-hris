import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMasterDate } from './master-date';

test('ISO dates and timestamps keep their calendar-date prefix', () => {
  assert.equal(normalizeMasterDate('2026-08-09'), '2026-08-09');
  assert.equal(normalizeMasterDate('2026-08-09T22:15:03.412Z'), '2026-08-09');
  assert.equal(normalizeMasterDate('  2026-08-09  '), '2026-08-09');
});

test('US short dates parse by PART, never through the locale-dependent Date ctor', () => {
  // The whole reason this is hand-parsed: `new Date('5/4/2026')` can read as
  // April 5 on a non-US locale, which would move a person a month.
  assert.equal(normalizeMasterDate('5/4/2026'), '2026-05-04');
  assert.equal(normalizeMasterDate('05/26/26'), '2026-05-26');
  assert.equal(normalizeMasterDate('7/28/25'), '2025-07-28');
  assert.equal(normalizeMasterDate('12/1/2025'), '2025-12-01');
});

test('spelled-out months parse to the same calendar day', () => {
  assert.equal(normalizeMasterDate('July 20, 2026'), '2026-07-20');
});

test('out-of-range parts are rejected rather than rolled over', () => {
  assert.equal(normalizeMasterDate('13/45/25'), null);
  assert.equal(normalizeMasterDate('0/10/26'), null);
  assert.equal(normalizeMasterDate('7/0/26'), null);
});

test('blank and unrecognised cells return null — never a guess', () => {
  assert.equal(normalizeMasterDate(''), null);
  assert.equal(normalizeMasterDate('   '), null);
  assert.equal(normalizeMasterDate(null), null);
  assert.equal(normalizeMasterDate(undefined), null);
  assert.equal(normalizeMasterDate('n/a'), null);
  assert.equal(normalizeMasterDate('TBD'), null);
});
