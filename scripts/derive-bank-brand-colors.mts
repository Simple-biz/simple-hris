/**
 * READ-ONLY. Measures the dominant brand colour of every shipped bank logo and
 * prints the declared table that `src/lib/payment-catalog/bank-card-palette.ts`
 * carries, so the People profile's bank card is tinted from the ARTWORK rather
 * than from anyone's memory of what colour a bank is.
 *
 * Run it after adding or refreshing a logo (`scripts/fetch-bank-logos.mts`), paste
 * the block it prints into BANK_BRAND_HEX, and let `bank-card-palette.test.ts`
 * re-derive it — a table that drifts from the files fails there rather than
 * shipping a bank's card in another bank's colour.
 *
 *   node --import tsx scripts/derive-bank-brand-colors.mts
 *
 * Writes nothing. It only reads files already in the repo.
 */
import fs from 'node:fs';
import path from 'node:path';

const { decodePng, dominantInkColor } = await import('../src/lib/images/decode-png');
const { BANK_LOGO_SRC, OFFICIAL_BANKS } = await import('../src/lib/payment-catalog/banks');

const nameByKey = new Map(OFFICIAL_BANKS.map((b) => [b.key, b.name]));
const hex = (n: number) => n.toString(16).padStart(2, '0');
const rows: string[] = [];

for (const [key, src] of Object.entries(BANK_LOGO_SRC).sort()) {
  const file = path.join(process.cwd(), 'public', src.replace(/^\//, ''));
  if (!fs.existsSync(file)) { console.log(`MISSING  ${key}  ${src}`); continue; }
  const ink = dominantInkColor(decodePng(fs.readFileSync(file), key));
  const label = nameByKey.get(key) ?? key;
  if (!ink) {
    console.log(`no hue   ${key.padEnd(18)} ${label} — monochrome lockup, neutral card`);
    continue;
  }
  const value = `#${hex(ink.r)}${hex(ink.g)}${hex(ink.b)}`;
  console.log(
    `${value}  ${key.padEnd(18)} sat ${ink.saturationPct.toFixed(0).padStart(3)}%  ` +
    `share ${ink.sharePct.toFixed(0).padStart(3)}%  ${label}`,
  );
  rows.push(`  ${key}: '${value}',`);
}

console.log('\n--- BANK_BRAND_HEX ---');
console.log(rows.join('\n'));
