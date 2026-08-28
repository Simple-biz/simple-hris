import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNATURE_FACES,
  coversText,
  faceById,
  fontStack,
  uncoveredCharacters,
} from './signature-fonts';

test('the picker offers at least five distinct faces', () => {
  assert.ok(SIGNATURE_FACES.length >= 5, `only ${SIGNATURE_FACES.length} faces`);
  const ids = new Set(SIGNATURE_FACES.map((f) => f.id));
  const families = new Set(SIGNATURE_FACES.map((f) => f.family));
  assert.equal(ids.size, SIGNATURE_FACES.length, 'face ids must be unique');
  assert.equal(families.size, SIGNATURE_FACES.length, 'families must be unique');
});

test('every face declares at least one unicode range and a usable stack', () => {
  for (const face of SIGNATURE_FACES) {
    assert.ok(face.ranges.length >= 1, `${face.id} ships no ranges`);
    assert.match(fontStack(face), /^'.+', cursive$/);
    assert.ok(face.sizeHint > 0 && face.sizeHint <= 2, `${face.id} sizeHint out of range`);
  }
});

test('every face can draw plain ASCII names', () => {
  for (const face of SIGNATURE_FACES) {
    assert.ok(coversText(face, 'Carla Mendoza'), `${face.id} cannot draw a plain name`);
    assert.deepEqual(uncoveredCharacters(face, 'Carla Mendoza'), []);
  }
});

test('every face can draw the accented letters Filipino and Colombian names actually use', () => {
  // Latin-1 lives in the base `latin` subset, which every face ships.
  for (const face of SIGNATURE_FACES) {
    assert.ok(coversText(face, 'José Muñoz-Peña'), `${face.id} cannot draw José Muñoz-Peña`);
  }
});

test('coverage is PER FACE — Homemade Apple ships no latin-ext and must say so', () => {
  const apple = faceById('homemade-apple');
  const vibes = faceById('great-vibes');
  assert.ok(apple && vibes);

  // U+0141 (Ł) is latin-ext only.
  assert.equal(coversText(vibes, 'Łukasz'), true);
  assert.equal(coversText(apple, 'Łukasz'), false);
  assert.deepEqual(uncoveredCharacters(apple, 'Łukasz'), ['Ł']);
});

test('uncovered characters are de-duplicated in first-appearance order', () => {
  const apple = faceById('homemade-apple');
  assert.ok(apple);
  // Only Ł and ź are latin-ext; ó is Latin-1 and every face ships it.
  assert.deepEqual(uncoveredCharacters(apple, 'Łódź Łucja'), ['Ł', 'ź']);
});

test('a script no face ships is refused rather than drawn as blank boxes', () => {
  // The whole point of the predicate: a .notdef box on a document going to a
  // bank is worse than being told to draw the signature instead.
  for (const face of SIGNATURE_FACES) {
    assert.equal(coversText(face, '陳大文'), false, `${face.id} claims to cover Han`);
    assert.equal(coversText(face, 'Дмитрий'), false, `${face.id} claims to cover Cyrillic`);
  }
});

test('whitespace never counts as uncovered', () => {
  for (const face of SIGNATURE_FACES) {
    assert.deepEqual(uncoveredCharacters(face, '   \t\n  '), []);
  }
});

test('faceById is total over the shipped ids and null otherwise', () => {
  for (const face of SIGNATURE_FACES) {
    assert.equal(faceById(face.id)?.family, face.family);
  }
  assert.equal(faceById('comic-sans'), null);
});
