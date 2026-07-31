import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { embedPdfFonts, __sanitizers } from './fonts';

const { sanitizeUnicodeSubset, sanitizeWinAnsi } = __sanitizers;

test('the Unicode subset keeps the peso sign and smart punctuation', () => {
  assert.equal(sanitizeUnicodeSubset('₱225.00'), '₱225.00');
  assert.equal(sanitizeUnicodeSubset('“quoted” — it’s fine…'), '“quoted” — it’s fine…');
  assert.equal(sanitizeUnicodeSubset('José Peña'), 'José Peña');
  assert.equal(sanitizeUnicodeSubset('bullet • middot ·'), 'bullet • middot ·');
});

test('glyphs outside the subset are folded, never passed through to throw', () => {
  // pdf-lib throws on an unencodable glyph, so anything uncovered must be mapped
  // here or a single stray character would fail an entire export.
  assert.equal(sanitizeUnicodeSubset('a → b'), 'a -> b');
  assert.equal(sanitizeUnicodeSubset('x ≥ y ≤ z'), 'x >= y <= z');
  assert.equal(sanitizeUnicodeSubset('3 × 4'), '3 x 4');
  assert.equal(sanitizeUnicodeSubset('张伟'), '??');
  // Iteration is by code point, so an astral char folds to a single '?' rather
  // than one per UTF-16 surrogate.
  assert.equal(sanitizeUnicodeSubset('emoji 🎉'), 'emoji ?');
});

test('the WinAnsi fallback still substitutes "PHP " for the peso sign', () => {
  // This is the pre-existing behaviour, kept for the path where the font fails
  // to embed — a broken font must degrade, not break the download.
  assert.equal(sanitizeWinAnsi('₱225.00'), 'PHP 225.00');
  assert.equal(sanitizeWinAnsi('—dash'), '-dash');
  assert.equal(sanitizeWinAnsi('it’s'), "it's");
  assert.equal(sanitizeWinAnsi('张伟'), '??');
});

test('embedPdfFonts returns a working Unicode set and both weights differ', async () => {
  const doc = await PDFDocument.create();
  const fonts = await embedPdfFonts(doc);
  assert.equal(fonts.unicode, true);
  const w = fonts.regular.widthOfTextAtSize('₱1,234.56', 10);
  const wBold = fonts.bold.widthOfTextAtSize('₱1,234.56', 10);
  assert.ok(w > 0 && wBold > 0);
  assert.notEqual(w, wBold, 'regular and bold are distinct faces');
});

test('drawing every covered code point does not throw', async () => {
  const doc = await PDFDocument.create();
  const fonts = await embedPdfFonts(doc);
  const page = doc.addPage([612, 792]);
  let covered = '';
  for (let c = 0x20; c <= 0x7e; c += 1) covered += String.fromCodePoint(c);
  for (let c = 0xa0; c <= 0xff; c += 1) covered += String.fromCodePoint(c);
  covered += '₱–—‘’“”…•·';
  // Chunked so no single line runs off the page; the point is encodability.
  for (let i = 0; i < covered.length; i += 60) {
    page.drawText(fonts.sanitize(covered.slice(i, i + 60)), {
      x: 20,
      y: 760 - (i / 60) * 12,
      size: 8,
      font: fonts.regular,
    });
  }
  assert.ok((await doc.save()).byteLength > 1000);
});
