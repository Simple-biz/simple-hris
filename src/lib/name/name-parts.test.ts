/**
 * Round-trip + edge coverage for the People -> Profile name-parts editor.
 *
 * Run:  npx tsx --test src/lib/name/name-parts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNameParts, composeMasterListName, stripMiddleMarker, type NameParts } from './name-parts';

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

test('a MULTI-WORD first name survives the round-trip (the boundary-marker bug)', () => {
  // The reported bug: typing "Jan Kane Teves" into First (middle left empty)
  // used to reload as First="Jan", Middle="Kane Teves". The empty `()` marker
  // keeps the whole first name intact and the middle empty.
  const parts: NameParts = { first: 'Jan Kane Teves', middle: '', last: 'Reroma', extension: '', nickname: 'Kane' };
  const composed = composeMasterListName(parts);
  assert.equal(composed, 'Reroma (), Jan Kane Teves "Kane"');
  assert.deepEqual(parseNameParts(composed), parts);

  // Multi-word first WITH a middle: middle rides in the parens, first stays whole.
  const withMiddle: NameParts = { first: 'Jan Kane Teves', middle: 'Miguel', last: 'Reroma', extension: '', nickname: 'Kane' };
  const c2 = composeMasterListName(withMiddle);
  assert.equal(c2, 'Reroma (Miguel), Jan Kane Teves "Kane"');
  assert.deepEqual(parseNameParts(c2), withMiddle);

  // Compound surname stays OUTSIDE the parens; suffix + marker order is fine.
  const compound: NameParts = { first: 'Juan Paulo', middle: 'Santos', last: 'Dela Cruz', extension: 'Jr', nickname: 'JP' };
  const c3 = composeMasterListName(compound);
  assert.equal(c3, 'Dela Cruz Jr (Santos), Juan Paulo "JP"');
  assert.deepEqual(parseNameParts(c3), compound);
});

test('single-word first names NEVER get the marker (legacy form preserved byte-for-byte)', () => {
  // The naive first-token/rest split is correct for a single-word first, so no
  // marker is emitted and the stored string is identical to before this change.
  assert.equal(
    composeMasterListName({ first: 'Jan', middle: 'Kane', last: 'Reroma', extension: '', nickname: 'Kane' }),
    'Reroma, Jan Kane "Kane"',
  );
  // Single first + MULTI-word middle also re-splits correctly with no marker.
  const multiMiddle: NameParts = { first: 'Juan', middle: 'Dela Santa', last: 'Cruz', extension: '', nickname: 'Juan' };
  const composed = composeMasterListName(multiMiddle);
  assert.equal(composed, 'Cruz, Juan Dela Santa "Juan"');
  assert.deepEqual(parseNameParts(composed), multiMiddle);
});

test('a multi-word first with an implied (unquoted) go-by round-trips', () => {
  // No explicit nickname: derive over first + middle tokens, not the whole
  // multi-word first as one token.
  const parts: NameParts = { first: 'Jan Kane Teves', middle: '', last: 'Reroma', extension: '', nickname: 'Teves' };
  const composed = composeMasterListName(parts);
  assert.equal(composed, 'Reroma (), Jan Kane Teves "Teves"');
  // Parse of the marker form WITHOUT a quoted go-by derives "Teves" (last given).
  assert.deepEqual(parseNameParts('Reroma (), Jan Kane Teves'), {
    first: 'Jan Kane Teves', middle: '', last: 'Reroma', extension: '', nickname: 'Teves',
  });
});

test('stripMiddleMarker removes the parenthesized boundary marker from a surname', () => {
  assert.equal(stripMiddleMarker('Reroma (Miguel)'), 'Reroma');
  assert.equal(stripMiddleMarker('Reroma ()'), 'Reroma');
  assert.equal(stripMiddleMarker('Dela Cruz Jr (Santos)'), 'Dela Cruz Jr');
  assert.equal(stripMiddleMarker('Reroma'), 'Reroma'); // no marker → unchanged
  assert.equal(stripMiddleMarker('Reroma (Miguel), Jan Kane Teves'), 'Reroma, Jan Kane Teves');
});

test('stray parens typed into a First/Middle field can never forge the marker', () => {
  // A user typing literal parens must not be able to inject or break the marker;
  // compose scrubs () out of the parts before assembling.
  assert.equal(
    composeMasterListName({ first: 'Foo (bar) Baz', middle: '', last: 'Reyes', extension: '', nickname: 'Foo' }),
    'Reyes (), Foo bar Baz "Foo"',
  );
  assert.deepEqual(parseNameParts('Reyes (), Foo bar Baz "Foo"'), {
    first: 'Foo bar Baz', middle: '', last: 'Reyes', extension: '', nickname: 'Foo',
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
