/**
 * Round-trip + edge coverage for the People -> Profile name-parts editor.
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

test('parseNameParts cleans DOUBLED quotes from a bad CSV/Sheet round-trip', () => {
  // The exact corrupted shape seen in the People editor: `"Aeriele"` had been
  // CSV-escaped to `""Aeriele""`. Parse must recover the clean parts, NOT leak
  // the doubled quotes into the middle name / nickname.
  assert.deepEqual(parseNameParts('Lacerna, Aeriele Joan Marg ""Aeriele""'), {
    first: 'Aeriele', middle: 'Joan Marg', last: 'Lacerna', extension: '', nickname: 'Aeriele',
  });
  // Same corruption, with a generational suffix on the surname.
  assert.deepEqual(parseNameParts('Cruz Jr, Juan Dela ""Dela""'), {
    first: 'Juan', middle: 'Dela', last: 'Cruz', extension: 'Jr', nickname: 'Dela',
  });
});

test('the parse -> compose round-trip cleans corruption and is then idempotent', () => {
  const corrupt = 'Lacerna, Aeriele Joan Marg ""Aeriele""';
  const cleaned = composeMasterListName(parseNameParts(corrupt));
  // First pass repairs it to the canonical single-quoted form...
  assert.equal(cleaned, 'Lacerna, Aeriele Joan Marg "Aeriele"');
  // ...and every further pass is a fixed point - quotes never accumulate again.
  assert.equal(composeMasterListName(parseNameParts(cleaned)), cleaned);
  assert.equal(
    composeMasterListName(parseNameParts(composeMasterListName(parseNameParts(cleaned)))),
    cleaned,
  );
});

test('composeMasterListName never emits doubled quotes even from mangled parts', () => {
  // Stray quotes on the parts themselves (e.g. a half-repaired record) must be
  // scrubbed, yielding exactly one clean quoted go-by.
  assert.equal(
    composeMasterListName({ first: 'Aeriele', middle: 'Joan Marg', last: 'Lacerna', extension: '', nickname: 'Aeriele""' }),
    'Lacerna, Aeriele Joan Marg "Aeriele"',
  );
  assert.equal(
    composeMasterListName({ first: 'Jan"', middle: '', last: 'Reroma', extension: '', nickname: '"Kane"' }),
    'Reroma, Jan "Kane"',
  );
});

test('apostrophes and hyphens survive scrubbing (only quotes are removed)', () => {
  assert.deepEqual(parseNameParts("O'Brien, Sean Anne-Marie"), {
    first: 'Sean', middle: 'Anne-Marie', last: "O'Brien", extension: '', nickname: 'Anne-Marie',
  });
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
