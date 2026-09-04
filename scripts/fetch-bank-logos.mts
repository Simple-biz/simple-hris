/**
 * Fetch the brand logo for each bank in `OFFICIAL_BANKS` into `public/banks/`.
 *
 * Source: Wikimedia. `https://en.wikipedia.org/wiki/Special:FilePath/<File>?width=N`
 * resolves BOTH English-Wikipedia-local files and Commons files, and renders an SVG
 * original to a PNG at the width we ask for — which is why every entry below can name
 * one file and get back one predictable format.
 *
 * **Every source is DECLARED, never searched.** A Commons search for "Security Bank
 * logo" returns Bank of America's; a search for "Maribank" returns its parent Sea
 * Group's. A wrong-bank logo is far worse than no logo — it is a confident lie on a
 * screen Accounting uses to reason about payouts — so the mapping is a hand-checked
 * table, and a bank with no trustworthy source keeps its monogram tile.
 *
 * **Every download is measured before it is written.** `ProcessorLogo` falls back to a
 * monogram on a LOAD error, but not on an INVISIBLE one, so a white-inked logo on the
 * white plate renders as an empty box that nothing reports. `isLegibleOnWhite` rejects
 * those, plus slivers and fully transparent files. A rejected download is not written.
 *
 * Usage:
 *   node --import tsx scripts/fetch-bank-logos.mts              # dry run — fetch, measure, report
 *   node --import tsx scripts/fetch-bank-logos.mts --apply      # write public/banks/*.png
 *   node --import tsx scripts/fetch-bank-logos.mts --apply gotyme bpi
 *
 * Writes nothing outside `public/banks/` and its manifest. Touches no database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { decodePng, measureInk, isLegibleOnWhite } = await import('../src/lib/images/decode-png');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, 'public', 'banks');
const MANIFEST = path.join(OUT_DIR, 'SOURCES.json');

/** Wikimedia asks for a descriptive UA and rate-limits anonymous bursts. */
const UA = 'simple-hris-logo-fetch/1.0 (internal HRIS admin tool; contact kaner@simple.biz)';

/** Rendered width. The plate draws these at ~80×44, so 480 is generous for retina. */
const RENDER_WIDTH = 480;

interface Source {
  /** `OFFICIAL_BANKS` key — also the output filename. */
  key: string;
  /** Exact Wikimedia `File:` name, without the prefix. */
  file: string;
  /** Which wiki hosts (or resolves) it. `en` resolves Commons files too. */
  wiki?: 'en' | 'commons';
  /** Why this file is the right one, when it is not obvious from the name. */
  note?: string;
}

/**
 * Hand-checked, one per bank. Ordered by how many people are paid there.
 *
 * NOT LISTED, on purpose — each keeps its monogram tile until someone uploads a file
 * in the Current Banks dialog:
 *   maribank (100 people)  Wikipedia has only its PARENT Sea Group's logo.
 *   metrobank (30)         Only a .gif on Commons; the PH page carries no logo file.
 *   securitybank (15)      Only a .jpg; this pipeline verifies PNG renders.
 *   seabank (5)            No article.
 *   bdo_network, uniondigital, column, cfsb, eastwest_rural, chinabank_savings,
 *   paymaya, wepay         No article, or only the parent brand's mark.
 */
const SOURCES: Source[] = [
  { key: 'gotyme', file: 'GoTyme Bank logo.svg', wiki: 'commons' },
  { key: 'bpi', file: 'Official BPI Logo.svg', wiki: 'commons' },
  { key: 'bdo', file: 'BDO Unibank (logo).svg', wiki: 'commons' },
  { key: 'unionbank', file: 'Unionbank 2018 logo.svg', wiki: 'commons' },
  { key: 'gcash', file: 'GCash logo.svg', wiki: 'commons' },
  { key: 'wise', file: 'Wise Logo 512x124.svg', wiki: 'commons' },
  { key: 'rcbc', file: 'RCBC logo.svg', wiki: 'commons' },
  { key: 'landbank', file: 'Landbank New.svg', note: 'current mark; Commons still has the older one' },
  { key: 'aub', file: 'Asia United Bank logo.svg', wiki: 'commons' },
  { key: 'maya', file: 'Maya logo.svg', wiki: 'commons' },
  { key: 'pnb', file: 'Philippine-National-Bank-logo.svg', wiki: 'commons' },
  { key: 'cimb', file: 'CIMB Group Logo.svg', wiki: 'commons', note: 'CIMB Bank Philippines uses the group mark' },
  { key: 'eastwest', file: 'EastWest Bank 2011 h-pos logo.svg', wiki: 'commons' },
  { key: 'chinabank', file: 'Chinabank 2024.svg', note: 'China Banking Corporation PH, 2024 refresh' },
  { key: 'psbank', file: 'PSbank logo.svg' },
  { key: 'maybank', file: 'Maybank logo.svg' },
  { key: 'bank_of_commerce', file: 'Bank of Commerce BankCom logo.png' },
  { key: 'bpi_banko', file: 'BPI BanKo logo.png' },
  { key: 'davivienda', file: 'Davivienda Logo.png', wiki: 'commons' },
  { key: 'truist', file: 'Truist Financial logo.svg', wiki: 'commons' },
  { key: 'cebuana', file: 'Cebuana Lhuillier logo.png', wiki: 'commons' },
  { key: 'south_state', file: 'South State Bank logo.svg' },
  { key: 'fairwinds', file: 'Logo of Fairwinds CU.svg' },
];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = new Set(args.filter((a) => !a.startsWith('--')));
const targets = only.size > 0 ? SOURCES.filter((s) => only.has(s.key)) : SOURCES;

if (only.size > 0) {
  const unknown = [...only].filter((k) => !SOURCES.some((s) => s.key === k));
  if (unknown.length > 0) {
    console.error(`Unknown bank key(s): ${unknown.join(', ')}`);
    process.exit(1);
  }
}

function fileUrl(s: Source): string {
  const host = s.wiki === 'commons' ? 'commons.wikimedia.org' : 'en.wikipedia.org';
  // Special:FilePath takes the file name in the PATH; encode it, keeping spaces as %20.
  return `https://${host}/wiki/Special:FilePath/${encodeURIComponent(s.file)}?width=${RENDER_WIDTH}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Result {
  key: string;
  ok: boolean;
  detail: string;
  bytes?: number;
  dims?: string;
  source?: string;
}

const results: Result[] = [];

for (const s of targets) {
  const url = fileUrl(s);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      results.push({ key: s.key, ok: false, detail: `HTTP ${res.status} — file name wrong or moved?` });
      await sleep(1200);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());

    // Everything must arrive as PNG: SVG originals are rendered, PNG originals are
    // thumbnailed. A JPEG/GIF original comes back in its own format, which this
    // pipeline cannot measure — so it is refused rather than trusted unmeasured.
    let png;
    try {
      png = decodePng(buf, s.key);
    } catch (e) {
      results.push({
        key: s.key,
        ok: false,
        detail: `not a measurable PNG (${e instanceof Error ? e.message : String(e)})`,
      });
      await sleep(1200);
      continue;
    }

    const stats = measureInk(png);
    const legible = isLegibleOnWhite(stats);
    if (!legible.ok) {
      results.push({ key: s.key, ok: false, detail: `REJECTED: ${legible.reason}` });
      await sleep(1200);
      continue;
    }

    const detail =
      `${png.width}x${png.height} · aspect ${stats.canvasAspect.toFixed(2)} · ` +
      `ink ${stats.darkPct.toFixed(0)}% dark, ${stats.nearWhitePct.toFixed(0)}% near-white, ` +
      `mean lum ${stats.meanLuminance.toFixed(0)} · spans ${stats.inkWidthPct.toFixed(0)}% width`;

    if (apply) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, `${s.key}.png`), buf);
    }
    results.push({
      key: s.key,
      ok: true,
      detail,
      bytes: buf.length,
      dims: `${png.width}x${png.height}`,
      source: url,
    });
  } catch (e) {
    results.push({ key: s.key, ok: false, detail: `ERROR ${e instanceof Error ? e.message : String(e)}` });
  }
  await sleep(1200); // be a good Wikimedia citizen
}

console.log(apply ? '── WROTE public/banks/ ──' : '── DRY RUN (pass --apply to write) ──');
for (const r of results) {
  console.log(`${r.ok ? 'OK  ' : 'SKIP'} ${r.key.padEnd(18)} ${r.detail}`);
}
const okCount = results.filter((r) => r.ok).length;
console.log(`\n${okCount}/${results.length} usable.`);

if (apply && okCount > 0) {
  // Provenance on disk: which URL each file came from, and what it measured. A logo
  // with no recorded source cannot be re-fetched or re-checked later.
  const manifest = {
    fetchedAt: new Date().toISOString(),
    renderWidth: RENDER_WIDTH,
    note: 'Bank brand logos used to identify each bank in the internal Payment Catalog. Fetched by scripts/fetch-bank-logos.mts.',
    files: results
      .filter((r) => r.ok)
      .map((r) => {
        const src = SOURCES.find((s) => s.key === r.key)!;
        return {
          file: `banks/${r.key}.png`,
          wikimediaFile: src.file,
          wiki: src.wiki ?? 'en',
          url: r.source,
          dimensions: r.dims,
          bytes: r.bytes,
          note: src.note,
        };
      }),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Manifest: public/banks/SOURCES.json`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log(
    `\n${failed.length} skipped. That is a normal outcome — those banks keep their monogram tile.\n` +
      `Fix a SKIP by correcting the declared File: name, not by loosening the checks.`,
  );
}
