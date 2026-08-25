import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Processor brand-logo assets — the invariant the docs assert and nothing enforced.
 *
 * `logoSrc` is hardcoded in THREE independent registries, none derived from the
 * processor id (docs/features/payment-dispatch.md 3.3.1). Two ways that breaks, both
 * SILENT — `ProcessorLogo`'s `onError` falls back to a gradient monogram tile, so a
 * broken path renders a plausible-looking card and nothing errors, warns, or fails
 * the build:
 *
 *   1. A path points at a file that does not exist. This actually happened: the
 *      2026-08-24 Kolan rebrand pointed all three registries at `/kolan.png` and
 *      never added the file, so the highest-volume rail showed the monogram on every
 *      screen for a day. Indistinguishable from a rail that was simply never given
 *      a logo.
 *   2. The registries disagree, and one rail shows two different marks depending on
 *      which screen you are standing on.
 *
 * These read the registries as TEXT on purpose. `PayrollDispatch.tsx` is a client
 * component pulling in React, framer-motion and the whole dispatch tree; importing it
 * to read four string literals would make an asset check hostage to unrelated runtime
 * breakage.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const REGISTRIES = [
  'src/lib/employee-payment-processors.ts',
  'src/lib/contractor/invoice-payment.ts',
  'src/components/payroll-clerk/PayrollDispatch.tsx',
] as const;

/** Every `logoSrc: '/foo.ext'` literal in one registry file. */
function logoSrcsIn(relPath: string): string[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  return [...src.matchAll(/logoSrc:\s*'([^']+)'/g)].map((m) => m[1]);
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

test('the three registries agree on every shared processor logo', () => {
  // processor id -> logoSrc seen, per registry. Kolan is the one asset all three carry.
  const byRegistry = new Map<string, Map<string, string>>();

  for (const registry of REGISTRIES) {
    const src = fs.readFileSync(path.join(REPO_ROOT, registry), 'utf8');
    const found = new Map<string, string>();
    // Both registry shapes put the id and the logoSrc in the same object literal:
    //   { id: 'hurupay', ..., logoSrc: '/kolan.svg' }        (the two lib registries)
    //   hurupay: { ..., logoSrc: '/kolan.svg' }              (PROCESSOR_VISUALS)
    for (const m of src.matchAll(/(?:id:\s*'([a-z]+)'|^\s{2}([a-z]+):\s*\{)/gm)) {
      const id = m[1] ?? m[2];
      const rest = src.slice(m.index ?? 0);
      const block = rest.slice(0, rest.indexOf('\n  }') + 1 || rest.indexOf('},') + 1);
      const logo = block.match(/logoSrc:\s*'([^']+)'/);
      if (id && logo) found.set(id, logo[1]);
    }
    byRegistry.set(registry, found);
  }

  const ids = new Set([...byRegistry.values()].flatMap((m) => [...m.keys()]));
  for (const id of ids) {
    const seen = REGISTRIES.map((r) => [r, byRegistry.get(r)?.get(id)] as const).filter(
      ([, logo]) => logo !== undefined,
    );
    const distinct = new Set(seen.map(([, logo]) => logo));
    assert.equal(
      distinct.size,
      1,
      `processor '${id}' has disagreeing logos across registries — the same rail would ` +
        `show two different marks:\n  ${seen.map(([r, l]) => `${l}  <- ${r}`).join('\n  ')}`,
    );
  }
});

test('Kolan ships the brand MARK, and all three registries carry it', () => {
  // The rebrand is LABEL ONLY: the processor id stays 'hurupay'. The ASSET is named
  // after the brand. See memory/hurupay-kolan-rebrand.md.
  for (const registry of REGISTRIES) {
    assert.ok(
      logoSrcsIn(registry).includes('/kolan.svg'),
      `${registry} does not point Kolan at /kolan.svg`,
    );
  }

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
      `The official lockup is ~2.7:1 and its wordmark is WHITE — invisible on the ` +
      `white plate ProcessorLogo renders in both themes.`,
  );
});
