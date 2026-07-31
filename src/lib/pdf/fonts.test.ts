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

// REGRESSION: "Certificate of Engagement" shipped rendering as "Certifi cate".
//
// pdf-lib draws custom fonts through fontkit's layout(), which applies the
// `liga` GSUB feature — the letters "f" + "i" are SUBSTITUTED with the single ﬁ
// glyph. The first subset was built from code points only, so U+FB01 was pruned
// while `liga` stayed in GSUB: the substitution resolved to a blank outline that
// still carried the ligature's full advance width, leaving a hole mid-word.
//
// Nothing about the input text is wrong, so no sanitiser test can catch this.
// The only reliable check is to lay the real strings out and assert every
// resulting glyph has an actual outline.
test('no string the PDFs draw lays out to a blank glyph', async () => {
  const fontkit = (await import('@pdf-lib/fontkit')).default as unknown as {
    create(b: Uint8Array): {
      layout(s: string): {
        glyphs: { id: number; codePoints: number[]; path: { commands: unknown[] } }[];
        positions: { xAdvance: number }[];
      };
    };
  };
  const { NOTO_SANS_REGULAR_BASE64 } = await import('./fonts/noto-sans-regular');
  const { NOTO_SANS_BOLD_BASE64 } = await import('./fonts/noto-sans-bold');
  const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

  const SAMPLES = [
    'Certificate of Engagement',
    'In accordance with company privacy and security policies, personal identification numbers',
    'This is to certify that Juan Dela Cruz has been contracted with Simple since March 4, 2024',
    // Ligature-forming pairs the `liga` feature acts on: ff fi fl ffi ffl.
    'office official affix fluffy difficult classification staffing fifty effective baffle',
    'Perfect Attendance Bonus: ₱5,000 · Technology Bonus: ₱1,850 · $COP 320.000',
    'José María Peña-Cruz · Employee ID SP-1042 · payroll@simple.biz',
    'UNSIGNED DRAFT',
    'Payroll Coordinator',
  ];

  for (const [label, b64] of [
    ['regular', NOTO_SANS_REGULAR_BASE64],
    ['bold', NOTO_SANS_BOLD_BASE64],
  ] as const) {
    const font = fontkit.create(bytes(b64));
    for (const sample of SAMPLES) {
      const run = font.layout(sample);
      run.glyphs.forEach((g, i) => {
        const chars = (g.codePoints ?? []).map((c) => String.fromCodePoint(c)).join('');
        if (chars.trim() === '') return; // whitespace legitimately has no outline
        assert.ok(
          g.path && g.path.commands.length > 0,
          `${label}: glyph ${g.id} for "${chars}" (advance ${run.positions[i].xAdvance}) has no outline — ` +
            `it would render as a blank gap inside "${sample.slice(0, 40)}"`,
        );
      });
    }
  }
});

test('the ﬁ ligature substitution resolves to a real glyph', async () => {
  const fontkit = (await import('@pdf-lib/fontkit')).default as unknown as {
    create(b: Uint8Array): {
      layout(s: string): { glyphs: { id: number; path: { commands: unknown[] } }[] };
    };
  };
  const { NOTO_SANS_BOLD_BASE64 } = await import('./fonts/noto-sans-bold');
  const font = fontkit.create(new Uint8Array(Buffer.from(NOTO_SANS_BOLD_BASE64, 'base64')));
  const run = font.layout('Certificate');
  // 11 letters collapse to 10 glyphs because f+i become one.
  assert.equal(run.glyphs.length, 10, 'the liga feature is expected to fire');
  assert.ok(run.glyphs[5].path.commands.length > 0, 'the ﬁ glyph must carry an outline');
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
