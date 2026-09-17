import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from '@/lib/images/decode-png';
import { fileURLToPath } from 'node:url';

/**
 * Processor brand-logo assets — the invariant the docs assert and nothing enforced.
 *
 * `logoSrc` is hardcoded in THREE independent registries, none derived from the
 * processor id (docs/features/payment-dispatch.md 3.3.1). Ways that breaks, all
 * SILENT — `ProcessorLogo`'s `onError` falls back to a gradient monogram tile, so a
 * broken path renders a plausible-looking card and nothing errors, warns, or fails
 * the build:
 *
 *   1. A path points at a file that does not exist. This actually happened: the
 *      2026-08-24 Kolan rebrand pointed all three registries at `/kolan.png` and
 *      never added the file, so the highest-volume rail showed the monogram on every
 *      screen for a day. Indistinguishable from a rail that was simply never given
 *      a logo.
 *   2. A path differs from the real filename only in CASE. Windows and macOS resolve
 *      it, Linux static serving does not — so it renders locally and 404s in
 *      production, straight back to failure 1. `fs.existsSync` cannot see this on a
 *      case-insensitive filesystem, so the basename is checked against `readdirSync`.
 *   3. Artwork that does not suit the surface it is drawn on. Two surfaces exist and
 *      they want DIFFERENT artwork, which is why the old "all three registries must
 *      carry the same asset" rule was retired on 2026-08-28:
 *
 *        PLATED   PayrollDispatch's cards -> ProcessorLogo's 80x44 white plate.
 *                 A horizontal LOCKUP reads here; a squarish mark is padded down.
 *        UNPLATED employee + contractor pickers -> bare 16-20px `<img>`, no plate,
 *                 transparent to the theme. Only an opaque squarish MARK reads here;
 *                 a 4.4:1 lockup becomes a ~4px sliver, invisible in dark mode.
 *
 *      So Kolan's asset is pinned PER SURFACE below, and the cross-registry equality
 *      rule still holds for every rail that has only one asset.
 *   4. A WHITE-inked lockup on the white plate. The plate is `bg-white` in both
 *      themes by rule (docs/design/ui-standards.md 6.4) and the official kolan.xyz
 *      lockup's wordmark is white — it would render as a mark beside an invisible
 *      word. That hazard was the reason the lockup was banned outright until
 *      2026-08-28; the ban is now a measurement (`ink is dark`) rather than a
 *      prohibition, so the real property is enforced instead of assumed.
 *
 * These read the registries as TEXT on purpose. `PayrollDispatch.tsx` is a client
 * component pulling in React, framer-motion and the whole dispatch tree; importing it
 * to read four string literals would make an asset check hostage to unrelated runtime
 * breakage.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Renders `logoSrc` on ProcessorLogo's white plate. */
const PLATED_REGISTRY = 'src/components/payroll-clerk/PayrollDispatch.tsx';

/** Render `logoSrc` as a bare, un-plated `<img>` in a small square. */
const UNPLATED_REGISTRIES = [
  'src/lib/employee-payment-processors.ts',
  'src/lib/contractor/invoice-payment.ts',
] as const;

const REGISTRIES = [PLATED_REGISTRY, ...UNPLATED_REGISTRIES] as const;

/** Every `logoSrc: '/foo.ext'` literal in one registry file. */
function logoSrcsIn(relPath: string): string[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  return [...src.matchAll(/logoSrc:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** processor id -> logoSrc, for one registry, read as text. */
function logosByIdIn(relPath: string): Map<string, string> {
  const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  const found = new Map<string, string>();
  // Both registry shapes put the id and the logoSrc in the same object literal:
  //   { id: 'hurupay', ..., logoSrc: '/kolan.svg' }        (the two lib registries)
  //   hurupay: { ..., logoSrc: '/Kolan.png' }              (PROCESSOR_VISUALS)
  for (const m of src.matchAll(/(?:id:\s*'([a-z]+)'|^\s{2}([a-z]+):\s*\{)/gm)) {
    const id = m[1] ?? m[2];
    const rest = src.slice(m.index ?? 0);
    const block = rest.slice(0, rest.indexOf('\n  }') + 1 || rest.indexOf('},') + 1);
    const logo = block.match(/logoSrc:\s*'([^']+)'/);
    if (id && logo) found.set(id, logo[1]);
  }
  return found;
}

test('every processor logoSrc resolves to a real file in public/', () => {
  const missing: string[] = [];

  for (const registry of REGISTRIES) {
    for (const logoSrc of logoSrcsIn(registry)) {
      // Registry paths are public-root absolute ("/kolan.svg" -> "public/kolan.svg").
      assert.ok(
        logoSrc.startsWith('/'),
        `${registry}: logoSrc ${JSON.stringify(logoSrc)} must be public-root absolute`,
      );
      if (!fs.existsSync(path.join(REPO_ROOT, 'public', logoSrc))) {
        missing.push(`${logoSrc} (referenced by ${registry})`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `logoSrc pointing at a file that does not exist — the card silently falls back to a ` +
      `gradient monogram, so this never surfaces at runtime:\n  ${missing.join('\n  ')}`,
  );
});

test('every logoSrc matches the real filename CASE-EXACTLY', () => {
  // `fs.existsSync` is case-insensitive on Windows and macOS, so the test above
  // passes for '/kolan.PNG' on a dev machine and 404s on Linux in production.
  // Compare against the directory listing instead, which is always exact.
  const wrongCase: string[] = [];

  for (const registry of REGISTRIES) {
    for (const logoSrc of logoSrcsIn(registry)) {
      const abs = path.join(REPO_ROOT, 'public', logoSrc);
      const dir = path.dirname(abs);
      if (!fs.existsSync(dir)) continue; // covered by the previous test
      if (!fs.readdirSync(dir).includes(path.basename(abs))) {
        const near = fs
          .readdirSync(dir)
          .find((e) => e.toLowerCase() === path.basename(abs).toLowerCase());
        wrongCase.push(
          `${logoSrc} (referenced by ${registry})` +
            (near ? ` — on disk as ${JSON.stringify(near)}` : ''),
        );
      }
    }
  }

  assert.deepEqual(
    wrongCase,
    [],
    `logoSrc differs from the on-disk filename by case — resolves on Windows/macOS, ` +
      `404s on Linux in production:\n  ${wrongCase.join('\n  ')}`,
  );
});

test('the two un-plated registries agree on every shared processor logo', () => {
  // Both draw the same bare square, so they must never diverge from each other.
  const byRegistry = UNPLATED_REGISTRIES.map((r) => [r, logosByIdIn(r)] as const);
  const ids = new Set(byRegistry.flatMap(([, m]) => [...m.keys()]));

  for (const id of ids) {
    const seen = byRegistry
      .map(([r, m]) => [r, m.get(id)] as const)
      .filter(([, logo]) => logo !== undefined);
    const distinct = new Set(seen.map(([, logo]) => logo));
    assert.equal(
      distinct.size,
      1,
      `processor '${id}' has disagreeing logos across the un-plated registries — the ` +
        `same rail would show two different marks:\n  ${seen
          .map(([r, l]) => `${l}  <- ${r}`)
          .join('\n  ')}`,
    );
  }
});

test('only Kolan may differ between the plated and un-plated registries', () => {
  // Retiring cross-registry equality was a KOLAN carve-out, not a general licence.
  // Every other rail still shows one mark everywhere; a second divergence has to be
  // argued for here rather than arriving by accident.
  const plated = logosByIdIn(PLATED_REGISTRY);
  const divergent: string[] = [];

  for (const registry of UNPLATED_REGISTRIES) {
    for (const [id, logo] of logosByIdIn(registry)) {
      const platedLogo = plated.get(id);
      if (platedLogo !== undefined && platedLogo !== logo && id !== 'hurupay') {
        divergent.push(`'${id}': ${platedLogo} (plated) vs ${logo} (${registry})`);
      }
    }
  }

  assert.deepEqual(
    divergent,
    [],
    `only Kolan is pinned per-surface; these rails diverge with no documented ` +
      `reason:\n  ${divergent.join('\n  ')}`,
  );
});

test('Kolan is pinned per surface: LOCKUP on the plate, MARK on the bare chips', () => {
  // The rebrand is LABEL ONLY: the processor id stays 'hurupay'. The ASSETS are named
  // after the brand. See memory/hurupay-kolan-rebrand.md.
  assert.equal(
    logosByIdIn(PLATED_REGISTRY).get('hurupay'),
    '/Kolan.png',
    `${PLATED_REGISTRY} must point Kolan's plated card at the /Kolan.png lockup`,
  );

  for (const registry of UNPLATED_REGISTRIES) {
    assert.equal(
      logosByIdIn(registry).get('hurupay'),
      '/kolan.svg',
      `${registry} draws a bare un-plated square and must keep the /kolan.svg MARK`,
    );
  }
});

test('kolan.svg is the squarish MARK, with intrinsic dimensions', () => {
  const svg = fs.readFileSync(path.join(REPO_ROOT, 'public/kolan.svg'), 'utf8');

  // Intrinsic dimensions are load-bearing: ProcessorLogo derives "mark vs wordmark"
  // from naturalWidth/naturalHeight, and an SVG without width/height measures 0 in
  // some browsers, silently downgrading the square mark to wordmark treatment.
  const width = svg.match(/<svg[^>]*\bwidth="(\d+(?:\.\d+)?)"/)?.[1];
  const height = svg.match(/<svg[^>]*\bheight="(\d+(?:\.\d+)?)"/)?.[1];
  assert.ok(width && height, 'kolan.svg must declare explicit width and height');

  const aspect = Number(width) / Number(height);
  assert.ok(
    aspect < 1.5,
    `kolan.svg must be the squarish MARK (aspect < 1.5, got ${aspect.toFixed(2)}). ` +
      `It is drawn on the bare, un-plated chips in the employee and contractor ` +
      `pickers, where a horizontal lockup shrinks to an unreadable sliver.`,
  );
});

// ── The white-lockup hazard, measured rather than banned ─────────────────────
//
// Decoded here with node's own zlib so the check carries no dependency: `sharp` is
// only a transitive Next.js package, absent from package.json, and a test that
// cannot run its own assertion is not a test.

// The PNG decoder this file used to carry inline now lives in
// `src/lib/images/decode-png.ts`, because scripts/fetch-bank-logos.mts must apply the
// SAME measurement at download time. One decoder, two callers — a second copy would
// drift, and the whole point is that the check is trustworthy.

test('Kolan.png is a horizontal lockup whose ink is DARK, not white', () => {
  const png = decodePng(fs.readFileSync(path.join(REPO_ROOT, 'public/Kolan.png')), 'Kolan.png');

  let ink = 0;
  let dark = 0;
  let minX = png.width;
  let maxX = -1;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (png.rgba[i + 3] < 32) continue; // transparent padding is not artwork
      ink++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      const lum = 0.299 * png.rgba[i] + 0.587 * png.rgba[i + 1] + 0.114 * png.rgba[i + 2];
      if (lum < 128) dark++;
    }
  }

  assert.ok(ink > 0, 'Kolan.png is fully transparent');

  // THE hazard this replaces the old outright ban with: the plate is bg-white in
  // both themes (ui-standards.md 6.4), so white ink renders as an empty box. The
  // shipped asset measures 96.5% dark; 90% leaves room for antialiasing and a
  // light accent without admitting the white lockup.
  const darkPct = (100 * dark) / ink;
  assert.ok(
    darkPct >= 90,
    `Kolan.png ink is only ${darkPct.toFixed(1)}% dark — the plate is white in both ` +
      `themes, so a light/white lockup renders as a mark beside an invisible word. ` +
      `The official kolan.xyz lockup has a WHITE wordmark and must never be installed ` +
      `here; this file is the dark variant.`,
  );

  // Wordmark treatment on the plate is aspect-driven (ProcessorLogo: >= 1.5 fills the
  // plate height, < 1.5 is padded as a mark). Measured on the CANVAS, which is what
  // naturalWidth/naturalHeight report.
  const canvasAspect = png.width / png.height;
  assert.ok(
    canvasAspect >= 1.5,
    `Kolan.png must read as a horizontal LOCKUP (canvas aspect >= 1.5, got ` +
      `${canvasAspect.toFixed(2)}) or ProcessorLogo pads it as a squarish mark.`,
  );

  // Transparent margin is fine — wise.png carries the same profile (canvas 2.39,
  // ink 4.37) — but a lockup floating in a huge empty canvas renders as a sliver on
  // an 80x44 plate. Ink must occupy most of the canvas width it is given.
  const inkWidthPct = (100 * (maxX - minX + 1)) / png.width;
  assert.ok(
    inkWidthPct >= 80,
    `Kolan.png ink spans only ${inkWidthPct.toFixed(0)}% of its canvas width — trim ` +
      `the transparent padding or it renders far smaller than the other wordmarks.`,
  );
});

/**
 * A rail with no artwork falls back to a TEXT tile, and that text is its own
 * silent-failure class — the mirror of the ones above.
 *
 * `ProcessorCard` derives the tile's text from the card label by cutting it to
 * two initials. For a vendor that is a monogram and reads as one. For a rail
 * that is OURS it is a truncation: "Wires" rendered as "WI", which is what
 * shipped until 2026-09-17. Nothing errored — a two-letter tile is exactly what
 * a rail with no logo is supposed to look like, so the bug was indistinguishable
 * from the intended fallback, on the residual rail that catches everyone who has
 * no wallet.
 *
 * The fix is the `wordmark` field, which spells the name out instead. This pins
 * the two halves of that: a rail with neither artwork nor a wordmark is back to
 * showing initials, and a wordmark wide enough to overrun the 80px plate is
 * clipped by it. The width budget is MEASURED in Inter 700 on the real plate
 * (see `monogramTypeClass` in ProcessorLogo.tsx) — the per-character figures
 * below are that measurement, not an estimate.
 *
 * Read as text for the same reason as every test above: PayrollDispatch.tsx is
 * the whole dispatch tree.
 */

/** Widest observed uppercase advance in Inter 700, in em ("M"). */
const EM_PER_CHAR_WORST = 0.95;
/** Average uppercase advance in Inter 700, in em — what real names run at. */
const EM_PER_CHAR_TYPICAL = 0.67;
/** ProcessorLogo's plate, minus the wordmark's own 12px of horizontal padding. */
const PLATE_TEXT_BUDGET_PX = 80 - 12;

/** Font size `monogramTypeClass` gives a wordmark of this length, in px. */
function wordmarkFontPx(len: number): number {
  return len <= 5 ? 17 : 12;
}

/**
 * Rails retired from the dispatch tabs. They keep their PROCESSORS entry so old
 * records still resolve a label, but no card is ever drawn for them, so there is
 * no text tile to get wrong — and their initials are a VENDOR's, where two
 * letters read as a monogram rather than a truncation.
 */
function retiredRailIds(): Set<string> {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'src/components/payroll-clerk/mock-queue.ts'),
    'utf8',
  );
  const decl = src.match(
    /RETIRED_DISPATCH_PROCESSOR_IDS:\s*readonly ProcessorId\[\]\s*=\s*\[([^\]]*)\]/,
  );
  assert.ok(decl, 'could not read RETIRED_DISPATCH_PROCESSOR_IDS out of mock-queue.ts');
  return new Set([...decl[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
}

/** processor id -> label, from PROCESSOR_VISUALS' sibling registry. */
function railLabels(): Map<string, string> {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'src/components/payroll-clerk/mock-queue.ts'),
    'utf8',
  );
  const found = new Map<string, string>();
  for (const m of src.matchAll(/id:\s*'([a-z]+)',\s*\n\s*label:\s*'([^']+)'/g)) {
    found.set(m[1], m[2]);
  }
  return found;
}

/** processor id -> wordmark, read as text out of PROCESSOR_VISUALS. */
function wordmarksIn(relPath: string): Map<string, string> {
  const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  const found = new Map<string, string>();
  for (const m of src.matchAll(/^ {2}([a-z]+):\s*\{/gm)) {
    const rest = src.slice(m.index ?? 0);
    const block = rest.slice(0, rest.indexOf('\n  }') + 1);
    const wordmark = block.match(/wordmark:\s*'([^']+)'/);
    if (wordmark) found.set(m[1], wordmark[1]);
  }
  return found;
}

test('a rail with no logo spells its name out instead of showing two initials', () => {
  const labels = railLabels();
  assert.ok(labels.size > 0, 'could not read any rail labels out of mock-queue.ts');

  const plated = logosByIdIn(PLATED_REGISTRY);
  const wordmarks = wordmarksIn(PLATED_REGISTRY);

  // 'wires' is the case this exists for: the residual rail, no vendor, no art.
  assert.equal(
    wordmarks.get('wires'),
    'WIRES',
    `the Wires card has no brand artwork, so its tile draws text. Without a ` +
      `wordmark ProcessorCard cuts the label to "WI", which reads as a ` +
      `truncation bug rather than a monogram (Kane 2026-09-17).`,
  );

  const retired = retiredRailIds();
  const truncated: string[] = [];
  for (const [id, label] of labels) {
    if (plated.has(id)) continue; // real artwork — the text tile never shows
    if (retired.has(id)) continue; // no card is drawn at all
    if (wordmarks.has(id)) continue;
    truncated.push(`${id} ("${label}" would render as "${label.slice(0, 2).toUpperCase()}")`);
  }

  assert.deepEqual(
    truncated,
    [],
    `rail with neither artwork nor a wordmark — its card shows two initials, ` +
      `which looks like an intended monogram and so never gets reported:\n  ` +
      `${truncated.join('\n  ')}`,
  );
});

test('every wordmark fits the 80px plate at the size it is given', () => {
  const wordmarks = wordmarksIn(PLATED_REGISTRY);
  assert.ok(wordmarks.size > 0, 'no wordmarks found — did PROCESSOR_VISUALS change shape?');

  const tooWide: string[] = [];
  for (const [id, wordmark] of wordmarks) {
    assert.equal(
      wordmark,
      wordmark.toUpperCase(),
      `${id}: wordmark ${JSON.stringify(wordmark)} must be uppercase — it stands in ` +
        `for a logo beside real uppercase lockups.`,
    );
    const px = wordmarkFontPx(wordmark.length);
    const typical = wordmark.length * EM_PER_CHAR_TYPICAL * px;
    if (typical > PLATE_TEXT_BUDGET_PX) {
      tooWide.push(
        `${id} (${JSON.stringify(wordmark)}: ~${typical.toFixed(1)}px at ${px}px, ` +
          `budget ${PLATE_TEXT_BUDGET_PX}px)`,
      );
    }
  }

  assert.deepEqual(
    tooWide,
    [],
    `wordmark too wide for ProcessorLogo's plate at the size its length selects. ` +
      `The plate clips, so the name renders cut off rather than overflowing — ` +
      `visible but easy to miss. Shorten it, add artwork, or re-tier the size in ` +
      `monogramTypeClass:\n  ${tooWide.join('\n  ')}`,
  );

  // The worst-case bound is deliberately NOT asserted: designing the tiers for an
  // all-"M" name would force illegibly small type on every real one. This records
  // the headroom a real name actually has, so the next wordmark is a judgement
  // made with the number in hand rather than a guess.
  const wires = wordmarks.get('wires') ?? '';
  assert.ok(
    wires.length * EM_PER_CHAR_WORST * wordmarkFontPx(wires.length) > PLATE_TEXT_BUDGET_PX,
    `if an all-"M" string of this length now fits the plate, the tiers shrank — ` +
      `re-measure before trusting the typical-case budget above.`,
  );
});
