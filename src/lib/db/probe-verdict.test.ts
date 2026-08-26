import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { classifyColumnProbe, classifyTableProbe, readCount } from './probe-verdict';

test('a plain probe with no error means the object is there', () => {
  assert.equal(classifyTableProbe(null), 'PRESENT');
  assert.equal(classifyTableProbe(undefined), 'PRESENT');
  assert.equal(classifyColumnProbe(null), 'PRESENT');
});

test('a missing table is MISSING by code, both dialects', () => {
  assert.equal(classifyTableProbe({ code: '42P01', message: 'relation "x" does not exist' }), 'MISSING');
  assert.equal(
    classifyTableProbe({ code: 'PGRST205', message: "Could not find the table 'public.x' in the schema cache" }),
    'MISSING',
  );
});

test('a missing table is MISSING by message even when the code is absent', () => {
  assert.equal(classifyTableProbe({ code: null, message: 'relation "x" does not exist' }), 'MISSING');
});

test('a missing column is MISSING, and so is its missing parent table', () => {
  assert.equal(classifyColumnProbe({ code: '42703', message: 'column x does not exist' }), 'MISSING');
  assert.equal(classifyColumnProbe({ code: 'PGRST204', message: "Could not find the 'x' column" }), 'MISSING');
  assert.equal(classifyColumnProbe({ code: '42P01', message: 'relation "t" does not exist' }), 'MISSING');
});

/**
 * The regression this module exists for. A missing column probed with `head: true` errors with
 * `code: undefined` and an EMPTY message; the old script fell through to its catch-all and reported
 * INCONCLUSIVE, so a migration that had not run read as "cannot tell" instead of "not applied".
 */
test('an error carrying neither code nor message is absence, not inconclusive', () => {
  assert.equal(classifyColumnProbe({ code: undefined, message: '' }), 'MISSING');
  assert.equal(classifyColumnProbe({}), 'MISSING');
  assert.equal(classifyColumnProbe({ code: '   ', message: '   ' }), 'MISSING');
  assert.equal(classifyTableProbe({ code: undefined, message: '' }), 'MISSING');
});

test('a real failure stays UNKNOWN and is never reported as either verdict', () => {
  assert.equal(classifyTableProbe({ code: '42501', message: 'permission denied for table x' }), 'UNKNOWN');
  assert.equal(classifyTableProbe({ code: 'PGRST301', message: 'JWT expired' }), 'UNKNOWN');
  assert.equal(classifyColumnProbe({ code: '42501', message: 'permission denied for table x' }), 'UNKNOWN');
  assert.equal(classifyColumnProbe({ code: 'PGRST301', message: 'JWT expired' }), 'UNKNOWN');
});

test('a null count is never a zero', () => {
  // `head: true` against a table that does not exist: no error, count null.
  assert.equal(readCount(null, null), null);
  assert.equal(readCount(null, undefined), null);
  // A genuine zero is a number and survives as one.
  assert.equal(readCount(null, 0), 0);
  assert.equal(readCount(null, 181799), 181799);
  // A count that arrived alongside an error is not a count.
  assert.equal(readCount({ code: '42P01', message: 'nope' }, 7), null);
});
