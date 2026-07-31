// Regenerates the embedded PDF font modules in src/lib/pdf/fonts/.
//
// WHY THIS EXISTS
// pdf-lib's built-in Helvetica is WinAnsi-encoded and has no PESO SIGN (U+20B1),
// so every PDF the HRIS issued used to print "PHP 225.00" where the business
// writes "₱225.00". Embedding a Unicode font fixes that, but a full Noto Sans is
// ~614 KB per weight — unacceptable in the client bundle, since the pay-stub
// export runs in the browser. So we subset the font to the 200 code points our
// PDFs can actually draw (~35 KB/weight) and commit the result as base64 TS
// modules: no fetch, no fs, no next.config output-tracing rules, and identical
// behaviour on the server and in the browser.
//
// Noto Sans was chosen over DejaVu Sans on metrics. DejaVu runs 9–15% wider
// than Helvetica, which overflows the existing fixed-column pay-stub layouts;
// Noto is within −3%..+7%. Noto lacks → ≥ ≤, which sanitizeForPdf() maps to
// ASCII anyway. Licence: SIL Open Font License 1.1 (see fonts/LICENSE.md).
//
// USAGE
//   npm i --no-save subset-font @expo-google-fonts/noto-sans
//   node scripts/build-pdf-font.mjs
//   npm i            # drop the throwaway deps again
//
// Pass --modules=<dir> to resolve those two packages from somewhere other than
// this project's node_modules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src', 'lib', 'pdf', 'fonts');

const modulesArg = process.argv.find((a) => a.startsWith('--modules='));
const MODULES = modulesArg
  ? path.resolve(modulesArg.slice('--modules='.length))
  : path.join(ROOT, 'node_modules');

/** The exact code points sanitizeForPdf() lets through to the font. Keep in
 *  sync with src/lib/pdf/fonts.ts — a glyph missing here throws at draw time. */
function buildCharset() {
  const chars = new Set();
  for (let c = 0x20; c <= 0x7e; c++) chars.add(String.fromCodePoint(c)); // ASCII
  for (let c = 0xa0; c <= 0xff; c++) chars.add(String.fromCodePoint(c)); // Latin-1 (accented names)
  for (const ch of '₱–—‘’“”…•·') chars.add(ch); // peso + smart punctuation
  // F-LIGATURES — REQUIRED, and not because any caller passes them.
  //
  // pdf-lib draws custom fonts via fontkit's layout(), which applies the `liga`
  // GSUB feature: the plain letters "f" + "i" are SUBSTITUTED with the single ﬁ
  // glyph. Subsetting by code point alone pruned that glyph while leaving `liga`
  // in GSUB, so the substitution resolved to a blank outline with the ligature's
  // full 602-unit advance — "Certificate" rendered as "Certifi cate", and
  // "identification" as "identifi cation", on a legal document.
  //
  // Keeping these makes the substitution land on a real glyph (and is better
  // typography than suppressing it). See the layout regression test in
  // src/lib/pdf/fonts.test.ts.
  for (const ch of 'ﬀﬁﬂﬃﬄ') chars.add(ch);
  return [...chars].join('');
}

const WEIGHTS = [
  {
    key: 'regular',
    constName: 'NOTO_SANS_REGULAR_BASE64',
    src: '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
  },
  {
    key: 'bold',
    constName: 'NOTO_SANS_BOLD_BASE64',
    src: '@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf',
  },
];

async function main() {
  const subsetFontPath = path.join(MODULES, 'subset-font', 'index.js');
  if (!fs.existsSync(path.join(MODULES, 'subset-font'))) {
    console.error(
      `subset-font not found under ${MODULES}\n` +
        'Run: npm i --no-save subset-font @expo-google-fonts/noto-sans',
    );
    process.exit(1);
  }
  const { default: subsetFont } = await import(pathToFileURL(subsetFontPath).href);

  const charset = buildCharset();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const { key, constName, src } of WEIGHTS) {
    const ttf = path.join(MODULES, src);
    if (!fs.existsSync(ttf)) {
      console.error(`Source font missing: ${ttf}`);
      process.exit(1);
    }
    const subset = await subsetFont(fs.readFileSync(ttf), charset, { targetFormat: 'truetype' });
    const base64 = Buffer.from(subset).toString('base64');
    const out = path.join(OUT_DIR, `noto-sans-${key}.ts`);
    fs.writeFileSync(
      out,
      `/* eslint-disable */\n` +
        `// GENERATED FILE — do not edit by hand.\n` +
        `// Noto Sans ${key === 'bold' ? 'Bold' : 'Regular'}, subset to ${charset.length} code points\n` +
        `// (${(subset.length / 1024).toFixed(1)} KB TrueType) by scripts/build-pdf-font.mjs.\n` +
        `// Licensed under the SIL Open Font License 1.1 — see ./LICENSE.md.\n` +
        `export const ${constName} =\n  '${base64}';\n`,
      'utf8',
    );
    console.log(
      `${path.relative(ROOT, out)} — subset ${(subset.length / 1024).toFixed(1)} KB, ` +
        `base64 ${(base64.length / 1024).toFixed(1)} KB`,
    );
  }
  console.log(`\nCharset: ${charset.length} code points (peso ${charset.includes('₱') ? 'included' : 'MISSING'})`);
}

await main();
