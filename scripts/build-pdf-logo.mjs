// Regenerates src/lib/pdf/assets/simple-logo.ts from public/simple-logo.png.
//
// WHY THIS EXISTS
// The pay-stub export loads the logo with `fetch('/simple-logo.png')`, which is
// fine because it runs in the browser. The Certificate of Engagement is rendered
// SERVER-SIDE (a request lands the PDF in storage, and signing re-renders it), so
// there is no origin to fetch from, and files under public/ are not reliably
// readable from the filesystem in a serverless function.
//
// Rather than add an output-tracing rule that fails silently in production and
// leaves a certificate with no letterhead, the PNG is committed as a base64 TS
// module — the same approach as the embedded fonts. public/simple-logo.png stays
// the single source of truth; this script produces the derivative.
//
// USAGE
//   node scripts/build-pdf-logo.mjs
//
// Run it whenever public/simple-logo.png changes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public', 'simple-logo.png');
const OUT_DIR = path.join(ROOT, 'src', 'lib', 'pdf', 'assets');
const OUT = path.join(OUT_DIR, 'simple-logo.ts');

if (!fs.existsSync(SRC)) {
  console.error(`Source logo missing: ${SRC}`);
  process.exit(1);
}

const png = fs.readFileSync(SRC);
if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
  console.error('Source is not a PNG (bad signature).');
  process.exit(1);
}
// IHDR immediately follows the 8-byte signature + 4-byte length + "IHDR".
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
const base64 = png.toString('base64');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  OUT,
  `/* eslint-disable */\n` +
    `// GENERATED FILE — do not edit by hand.\n` +
    `// public/simple-logo.png (${width}x${height}, ${(png.length / 1024).toFixed(1)} KB)\n` +
    `// encoded by scripts/build-pdf-logo.mjs so server-rendered PDFs can embed it\n` +
    `// without a fetch or a filesystem read. Re-run that script if the logo changes.\n` +
    `export const SIMPLE_LOGO_PNG_BASE64 =\n  '${base64}';\n\n` +
    `/** Intrinsic pixel size, for aspect-ratio maths without decoding. */\n` +
    `export const SIMPLE_LOGO_SIZE = { width: ${width}, height: ${height} } as const;\n`,
  'utf8',
);

console.log(
  `${path.relative(ROOT, OUT)} — ${width}x${height}, ` +
    `png ${(png.length / 1024).toFixed(1)} KB, base64 ${(base64.length / 1024).toFixed(1)} KB`,
);
