/**
 * Round-trip + edge coverage for the People → Profile name-parts editor.
 *
 * Run:  npx tsx --test src/lib/name/name-parts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNameParts, composeMasterListName, type NameParts } from './name-parts';

test('parseNameParts splits the surname-first master form', () => {
  assert.deepEqual(parseNameParts('Reroma, Jan Kane "Kane"'), {
    first: 'Jan', middle: 'Kane', last: 'Reroma', extension: '', nickname: 'Kane',
  });
  assert.deepEqual(parseNameParts('Cruz Jr, Juan Dela "Dela"'), {
    first: 'Juan', middle: 'Dela', last: 'Cruz', extension: 'Jr', nickname: 'Dela',
  });
  assert.deepEqual(parseNameParts('Engalan, Kyle S. "Kyle"'), {
    first: 'Kyle', middle: 'S.', last: 'Engalan', extension: '', nickname: 'Kyle',
  });
  // Compound surname fully before the comma.
  assert.deepEqual(parseNameParts('Dela Cruz, Juan'), {
    first: 'Juan', middle: '', last: 'Dela Cruz', extension: '', nickname: 'Juan',
  });
});

test('parseNameParts splits a plain legal name and implies the go-by', () => {
  assert.deepEqual(parseNameParts('Jan Kane Reroma'), {
    first: 'Jan', middle: 'Kane', last: 'Reroma', extension: '', nickname: 'Kane',
  });
  assert.deepEqual(parseNameParts('Juan Cruz III'), {
    first: 'Juan', middle: '', last: 'Cruz', extension: 'III', nickname: 'Juan',
  });
  assert.deepEqual(parseNameParts('Madonna'), {
    first: 'Madonna', middle: '', last: '', extension: '', nickname: '',
  });
});

test('parseNameParts is defensive about blanks, addresses, and inline nicknames', () => {
  const empty: NameParts = { first: '', middle: '', last: '', extension: '', nickname: '' };
  assert.deepEqual(parseNameParts(''), empty);
  assert.deepEqual(parseNameParts(null), empty);
  assert.deepEqual(parseNameParts('jan@simple.biz'), { ...empty, first: 'jan@simple.biz' });
  assert.deepEqual(parseNameParts('Juan (JJ) Cruz'), {
    first: 'Juan', middle: '', last: 'Cruz', extension: '', nickname: 'JJ',
  });
});

test('composeMasterListName is the inverse of parseNameParts for canonical names', () => {
  for (const name of [
    'Reroma, Jan Kane "Kane"',
    'Cruz Jr, Juan Dela "Dela"',
    'Engalan, Kyle S. "Kyle"',
    'Madonna',
  ]) {
    assert.equal(composeMasterListName(parseNameParts(name)), name, `round-trip: ${name}`);
  }
});

test('composeMasterListName honors an explicit nickname and omits empty parts', () => {
  assert.equal(
    composeMasterListName({ first: 'Jan', middle: '', last: 'Reroma', extension: '', nickname: 'JK' }),
    'Reroma, Jan "JK"',
  );
  assert.equal(
    composeMasterListName({ first: 'Maria', middle: '', last: 'Reyes', extension: '', nickname: '' }),
    'Reyes, Maria',
  );
  assert.equal(
    composeMasterListName({ first: 'Madonna', middle: '', last: '', extension: '', nickname: '' }),
    'Madonna',
  );
});
