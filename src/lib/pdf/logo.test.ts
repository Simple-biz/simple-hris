import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { embedSimpleLogo, simpleLogoWidthForHeight, SIMPLE_LOGO_SIZE } from './logo';

// The letterhead falls back to type when the embed fails, which means a broken
// generated asset would ship silently as "no logo". These assert it actually works.

test('the wordmark embeds and reports its intrinsic size', async () => {
  const doc = await PDFDocument.create();
  const logo = await embedSimpleLogo(doc);
  assert.ok(logo, 'the generated base64 PNG must embed — regenerate with scripts/build-pdf-logo.mjs');
  assert.equal(logo.width, SIMPLE_LOGO_SIZE.width);
  assert.equal(logo.height, SIMPLE_LOGO_SIZE.height);
});

test('the committed asset still matches public/simple-logo.png', async () => {
  // The TS module is a derivative; if someone swaps the logo without re-running
  // the generator, the documents keep the old artwork. Catch that here.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const source = path.join(process.cwd(), 'public', 'simple-logo.png');
  if (!fs.existsSync(source)) return; // nothing to compare against
  const png = fs.readFileSync(source);
  const { SIMPLE_LOGO_PNG_BASE64 } = await import('./assets/simple-logo');
  assert.equal(
    SIMPLE_LOGO_PNG_BASE64,
    png.toString('base64'),
    'public/simple-logo.png changed — re-run `node scripts/build-pdf-logo.mjs`',
  );
  assert.equal(png.readUInt32BE(16), SIMPLE_LOGO_SIZE.width);
  assert.equal(png.readUInt32BE(20), SIMPLE_LOGO_SIZE.height);
});

test('width scales from height on the real aspect ratio', () => {
  const w = simpleLogoWidthForHeight(29);
  assert.ok(Math.abs(w - (SIMPLE_LOGO_SIZE.width / SIMPLE_LOGO_SIZE.height) * 29) < 1e-9);
  // 900x324 is a wide wordmark; a 29pt-tall box is ~80pt across.
  assert.ok(w > 70 && w < 90, `expected ~80pt, got ${w.toFixed(1)}`);
});

test('embedding the logo actually adds it to the PDF payload', async () => {
  const withLogo = await PDFDocument.create();
  await embedSimpleLogo(withLogo);
  withLogo.addPage([612, 792]);
  const bare = await PDFDocument.create();
  bare.addPage([612, 792]);
  const grew = (await withLogo.save()).byteLength - (await bare.save()).byteLength;
  // The source PNG is ~37 KB; pdf-lib stores the image stream, so the document
  // must grow by roughly that much rather than silently dropping it.
  assert.ok(grew > 20_000, `expected the image stream in the output, only grew ${grew} bytes`);
});
